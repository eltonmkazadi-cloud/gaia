// api/elevenlabs.js — Proxy ElevenLabs TTS (CommonJS pour Vercel)
//
// Endpoints :
//   GET  /api/elevenlabs?search=<nom>     → recherche voix par nom
//   GET  /api/elevenlabs?list=1           → liste toutes les voix accessibles
//   POST /api/elevenlabs                  → TTS
//        body: { text, voiceId? | voiceName? }
//
// Priorité voix : voiceId explicite > voiceName (résolu) > ELEVENLABS_VOICE_ID env > fallback Charlotte

// Cache name → voiceId (module-scoped, persiste entre invocations warm Vercel)
const voiceCache = new Map();

async function fetchVoices(apiKey, search = '') {
  const params = new URLSearchParams({ page_size: '100' });
  if (search) params.set('search', search);
  const r = await fetch(`https://api.elevenlabs.io/v2/voices?${params}`, {
    headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    const e = new Error(`ElevenLabs voices API ${r.status}: ${err}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function fetchSharedVoices(apiKey, search) {
  const params = new URLSearchParams({ page_size: '20', search });
  const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params}`, {
    headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
  });
  if (!r.ok) return { voices: [] };
  return r.json();
}

async function resolveVoiceId(apiKey, name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  if (voiceCache.has(key)) return voiceCache.get(key);

  // 1. Cherche dans la library personnelle de l'utilisateur
  const personal = await fetchVoices(apiKey, name);
  const personalList = personal.voices || [];
  let voice =
    personalList.find((v) => v.name?.toLowerCase() === key) ||
    personalList.find((v) => v.name?.toLowerCase().includes(key));

  // 2. Sinon, cherche dans la Voice Library publique (shared voices)
  if (!voice) {
    const shared = await fetchSharedVoices(apiKey, name);
    const sharedList = shared.voices || [];
    voice =
      sharedList.find((v) => v.name?.toLowerCase() === key) ||
      sharedList.find((v) => v.name?.toLowerCase().includes(key));
  }

  if (!voice) return null;
  const id = voice.voice_id;
  voiceCache.set(key, id);
  return id;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({
      error: 'ELEVENLABS_API_KEY manquante dans les variables Vercel',
    });
  }

  // GET — list / search voices
  if (req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://x');
      const search = u.searchParams.get('search') || u.searchParams.get('find') || '';
      const data = await fetchVoices(process.env.ELEVENLABS_API_KEY, search);
      const voices = (data.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        description: v.description,
        labels: v.labels,
        preview_url: v.preview_url,
      }));
      return res.status(200).json({ count: voices.length, voices });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { text, voiceId, voiceName } = body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text requis (string non vide)' });
    }

    let VOICE_ID = voiceId;

    if (!VOICE_ID && voiceName) {
      try {
        VOICE_ID = await resolveVoiceId(process.env.ELEVENLABS_API_KEY, voiceName);
      } catch (err) {
        console.error('Voice resolution error:', err);
      }
      if (!VOICE_ID) {
        return res.status(404).json({
          error: `Voix introuvable : "${voiceName}". Vérifie qu'elle est ajoutée à ta library ElevenLabs (Voice Library → Add to my voices).`,
        });
      }
    }

    if (!VOICE_ID) {
      VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'XB0fDUnXU5powFXDhCwa'; // Charlotte fallback
    }

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
    return res.status(200).json({ audio: base64, voiceId: VOICE_ID });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
