// api/sms.js — Envoi SMS via Twilio (Basic Auth, sans dépendance)
// Variables Vercel requises :
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (ex: "+33XXXXXXXXX")

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    return res.status(500).json({
      error: 'Variables Twilio manquantes (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { to, message } = body;

    if (!to || !message) {
      return res.status(400).json({ error: 'to et message requis' });
    }

    // Normalise vers E.164 si numéro français sans préfixe
    let dest = String(to).replace(/\s/g, '');
    if (/^0\d{9}$/.test(dest)) dest = '+33' + dest.substring(1);
    if (!/^\+\d{6,15}$/.test(dest)) {
      return res.status(400).json({ error: `Numéro invalide (format E.164 attendu): ${to}` });
    }

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const upstream = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: dest,
          Body: String(message).substring(0, 1600),
        }).toString(),
      }
    );

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Twilio error:', data);
      return res.status(upstream.status).json({
        error: data.message || `Erreur Twilio (${upstream.status})`,
        code: data.code,
      });
    }

    return res.status(200).json({
      ok: true,
      sid: data.sid,
      status: data.status,
      to: data.to,
    });
  } catch (err) {
    console.error('SMS handler error:', err);
    return res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
