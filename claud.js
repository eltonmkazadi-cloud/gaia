/ api/claude.js
// Proxy sécurisé vers l'API Claude — optimisé Vercel
// CommonJS (pas ES modules) pour compatibilité maximale Vercel

module.exports = async function handler(req, res) {
  // CORS — autorise tous les appels depuis le front
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Seul POST est accepté
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vérification clé API présente
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante dans les variables Vercel' });
  }

  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages requis et doit être un tableau' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: system || '',
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(response.status).json({
        error: data.error?.message || 'Erreur API Claude',
        details: data,
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
