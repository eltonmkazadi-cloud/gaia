// api/twilio.js — Envoi SMS + WhatsApp via Twilio (CommonJS)
//
// POST /api/twilio
// body: { action: 'sms' | 'whatsapp', to: string, message: string }
//
// Variables Vercel requises :
//   TWILIO_ACCOUNT_SID   (commence par AC...)
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER  (E.164, ex "+33XXXXXXXXX") — pour les SMS
//   TWILIO_WHATSAPP_NUMBER (optionnel, par défaut le sandbox "+14155238886")
//
// Note WhatsApp : pour utiliser le sandbox, Elton doit d'abord envoyer le code
// "join <mot>" depuis son WhatsApp au numéro sandbox Twilio. Pour la prod, il
// faut un Sender approuvé par WhatsApp Business.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_WHATSAPP_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return res.status(500).json({
      error: 'Variables Twilio manquantes (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const action = String(body.action || 'sms').toLowerCase();
    const { to, message } = body;

    if (!to || !message) {
      return res.status(400).json({ error: 'to et message requis' });
    }

    // Normalise vers E.164 (français : 06... → +336...)
    let dest = String(to).replace(/\s/g, '').replace(/^00/, '+');
    if (/^0\d{9}$/.test(dest)) dest = '+33' + dest.substring(1);
    if (!/^\+\d{6,15}$/.test(dest)) {
      return res.status(400).json({ error: `Numéro invalide (E.164 attendu): ${to}` });
    }

    let from, toFormatted;
    if (action === 'whatsapp') {
      const wa = TWILIO_WHATSAPP_NUMBER || '+14155238886'; // sandbox par défaut
      const waNorm = wa.startsWith('+') ? wa : '+' + wa.replace(/^whatsapp:/i, '');
      from = `whatsapp:${waNorm}`;
      toFormatted = `whatsapp:${dest}`;
    } else if (action === 'sms') {
      if (!TWILIO_PHONE_NUMBER) {
        return res.status(500).json({ error: 'TWILIO_PHONE_NUMBER manquant pour SMS' });
      }
      from = TWILIO_PHONE_NUMBER;
      toFormatted = dest;
    } else {
      return res.status(400).json({ error: 'action doit être "sms" ou "whatsapp"' });
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
          From: from,
          To: toFormatted,
          Body: String(message).substring(0, 1600),
        }).toString(),
      }
    );

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Twilio error:', upstream.status, data);
      return res.status(upstream.status).json({
        error: data.message || `Erreur Twilio (${upstream.status})`,
        code: data.code,
      });
    }

    return res.status(200).json({
      ok: true,
      sid: data.sid,
      status: data.status,
      action,
      to: data.to,
      from: data.from,
    });
  } catch (err) {
    console.error('Twilio handler error:', err);
    return res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
