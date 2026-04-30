// api/elevenlabs.js — Proxy ElevenLabs TTS (CommonJS pour Vercel)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({
      error: 'ELEVENLABS_API_KEY manquante dans les variables Vercel',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { text, voiceId } = body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text requis (string non vide)' });
    }

    const VOICE_ID =
      voiceId ||
      process.env.ELEVENLABS_VOICE_ID ||
      'XB0fDUnXU5powFXDhCwa'; // Charlotte par défaut

    const t = text.length > 300 ? text.substring(0, 300) + '…' : text;

    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: t,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
            style: 0.35,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => '');
      console.error('ElevenLabs error:', upstream.status, errTxt);
      return res.status(upstream.status).json({
        error: errTxt || `Erreur ElevenLabs (${upstream.status})`,
      });
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return res.status(200).json({ audio: base64 });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
