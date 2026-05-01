// api/cron.js — Worker périodique
//
// Fait deux choses :
// 1. Envoie les notifs push dont la date de déclenchement est passée
// 2. (Optionnel) Scan Gmail pour notifier d'emails urgents — désactivé par défaut
//
// Auth :
//   - Vercel cron envoie automatiquement: Authorization: Bearer ${CRON_SECRET}
//   - Cron externe (cron-job.org, etc.) peut passer ?secret=<CRON_SECRET>
//
// Variables :
//   CRON_SECRET (recommandé pour bloquer les invocations externes non autorisées)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (web-push)
//   GMAIL_AUTO_NOTIFY=1 (optionnel — active le scan Gmail dans le cron)

const webpush = require('web-push');
const { cmd, configured: kvConfigured } = require('../lib/kv');

const SCHEDULED_KEY = 'gaia:scheduled';
const LAST_GMAIL_KEY = 'gaia:last_gmail_check';

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

async function readScheduled() {
  const raw = await cmd('GET', SCHEDULED_KEY);
  try {
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeScheduled(list) {
  return cmd('SET', SCHEDULED_KEY, JSON.stringify(list));
}

async function sendTwilioMessage(twilio) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_WHATSAPP_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials missing');
  }
  const action = (twilio.action || 'sms').toLowerCase();
  let dest = String(twilio.to).replace(/\s/g, '').replace(/^00/, '+');
  if (/^0\d{9}$/.test(dest)) dest = '+33' + dest.substring(1);

  let from, toFormatted;
  if (action === 'whatsapp') {
    const wa = TWILIO_WHATSAPP_NUMBER || '+14155238886';
    from = `whatsapp:${wa.startsWith('+') ? wa : '+' + wa}`;
    toFormatted = `whatsapp:${dest}`;
  } else {
    from = TWILIO_PHONE_NUMBER;
    toFormatted = dest;
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const r = await fetch(
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
        Body: String(twilio.message).substring(0, 1600),
      }).toString(),
    }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.message || `Twilio ${r.status}`);
    e.statusCode = r.status;
    throw e;
  }
  return data;
}

async function processScheduled() {
  const list = await readScheduled();
  const now = Date.now();
  const due = list.filter((s) => s.due <= now);
  let remaining = list.filter((s) => s.due > now);

  let pushSent = 0;
  let twilioSent = 0;
  let failed = 0;

  for (const item of due) {
    let pushOk = !item.subscription;
    let twilioOk = !item.twilio;

    // Push notification (si subscription présente)
    if (item.subscription) {
      try {
        const data = JSON.stringify({
          title: item.payload?.title || 'GAIA',
          body: item.payload?.body || '',
          icon: item.payload?.icon || '/icon-192.png',
          badge: item.payload?.badge || '/icon-192.png',
          tag: item.payload?.tag || item.id,
          url: item.payload?.url || '/',
          vibrate: item.payload?.vibrate || [200, 100, 200],
        });
        await webpush.sendNotification(item.subscription, data);
        pushSent++;
        pushOk = true;
      } catch (err) {
        const status = err.statusCode || 0;
        console.error('Push failed:', item.id, status, err.body || err.message);
        // 5xx/timeouts → re-queue ; 4xx → drop
        if (status >= 500 || status === 408 || status === 429 || status === 0) {
          pushOk = false;
        } else {
          pushOk = true; // dropped on purpose
        }
      }
    }

    // Twilio SMS / WhatsApp (si twilio présent)
    if (item.twilio) {
      try {
        await sendTwilioMessage(item.twilio);
        twilioSent++;
        twilioOk = true;
      } catch (err) {
        const status = err.statusCode || 0;
        console.error('Twilio failed:', item.id, status, err.message);
        // Erreurs définitives (4xx) : drop. Transient : retry.
        if (status >= 500 || status === 0) twilioOk = false;
        else twilioOk = true; // 4xx définitif
      }
    }

    if (!pushOk || !twilioOk) {
      remaining.push(item); // retry au prochain cron
      failed++;
    }
  }

  if (due.length > 0) {
    await writeScheduled(remaining);
  }

  return {
    due: due.length,
    pushSent,
    twilioSent,
    failed,
    remaining: remaining.length,
  };
}

async function pingGmailIfEnabled(host) {
  if (process.env.GMAIL_AUTO_NOTIFY !== '1') return null;
  // Throttle : 1 scan par heure max
  const lastRaw = await cmd('GET', LAST_GMAIL_KEY).catch(() => null);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  if (Date.now() - last < 3600000) return { skipped: 'throttled' };

  try {
    const r = await fetch(`${host}/api/gmail?action=auto&max=10`, {
      headers: { 'x-internal-cron': process.env.CRON_SECRET || '' },
    });
    const data = await r.json();
    await cmd('SET', LAST_GMAIL_KEY, String(Date.now()));
    return { ok: r.ok, urgent: data.urgent || 0, processed: data.processed || 0 };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Auth
  const headerAuth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const querySecret =
    new URL(req.url, 'http://x').searchParams.get('secret') || '';
  const expected = process.env.CRON_SECRET || '';
  if (expected && headerAuth !== expected && querySecret !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!kvConfigured()) {
    return res.status(500).json({
      error: 'KV non configuré (Vercel KV ou Upstash Redis requis)',
    });
  }
  if (!ensureVapid()) {
    return res
      .status(500)
      .json({ error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants' });
  }

  try {
    const result = await processScheduled();

    // Optional: scan Gmail
    const host = `https://${req.headers.host || 'gaia-tau.vercel.app'}`;
    const gmail = await pingGmailIfEnabled(host).catch((e) => ({
      error: e.message,
    }));

    return res.status(200).json({
      now: new Date().toISOString(),
      ...result,
      gmail,
    });
  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ error: err.message });
  }
};
