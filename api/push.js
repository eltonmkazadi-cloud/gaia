// api/push.js — Envoi de notifications push via VAPID/web-push
// Variables Vercel requises :
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ex: "mailto:elton.m.kazadi@gmail.com")
// Génère les clés via : npx web-push generate-vapid-keys

const webpush = require('web-push');

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:elton.m.kazadi@gmail.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  vapidConfigured = true;
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET : retourne la clé publique VAPID pour la souscription côté client
  if (req.method === 'GET') {
    if (!process.env.VAPID_PUBLIC_KEY) {
      return res.status(500).json({ error: 'VAPID_PUBLIC_KEY manquante' });
    }
    return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!ensureVapid()) {
    return res.status(500).json({
      error: 'Variables VAPID manquantes (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { subscription, payload } = body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'subscription invalide' });
    }

    const data = JSON.stringify({
      title: payload?.title || 'GAIA',
      body: payload?.body || '',
      icon: payload?.icon || '/icon-192.png',
      badge: payload?.badge || '/icon-192.png',
      tag: payload?.tag || 'gaia-' + Date.now(),
      url: payload?.url || '/',
      vibrate: payload?.vibrate || [200, 100, 200],
    });

    await webpush.sendNotification(subscription, data);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Push error:', err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.body || err.message || 'Erreur push',
    });
  }
};
