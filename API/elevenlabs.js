// api/elevenlabs.js — Proxy sécurisé ElevenLabs pour Vercel
// Voice ID : remplacé dynamiquement depuis l'interface ou via VOICE_ID env var

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { text, voiceId } = req.body;

    // Priorité : 1) voiceId envoyé par le client, 2) variable env, 3) Charlotte par défaut
    const VOICE_ID = voiceId || process.env.ELEVENLABS_VOICE_ID || 'XB0fDUnXU5powFXDhCwa';

    const t = text?.length > 300 ? text.substring(0, 300) + '…' : text;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: t,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.80,
            style: 0.35,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return res.status(200).json({ audio: base64 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
