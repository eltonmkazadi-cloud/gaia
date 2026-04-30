// lib/kv.js — Helper KV REST (compatible Vercel KV / Upstash Redis)
// Variables requises (Vercel KV les définit automatiquement à la création) :
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
// Compatible Upstash : si tu utilises Upstash, mappe :
//   KV_REST_API_URL  = UPSTASH_REDIS_REST_URL
//   KV_REST_API_TOKEN = UPSTASH_REDIS_REST_TOKEN

const URL_ =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

function configured() {
  return !!URL_ && !!TOKEN;
}

async function cmd(...args) {
  if (!configured()) {
    throw new Error(
      'KV non configuré. Crée une base Vercel KV (Storage → Create → KV) — les vars KV_REST_API_URL et KV_REST_API_TOKEN seront ajoutées automatiquement.'
    );
  }
  const r = await fetch(URL_, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    throw new Error(`KV ${r.status}: ${data.error || 'erreur inconnue'}`);
  }
  return data.result;
}

module.exports = { cmd, configured };
