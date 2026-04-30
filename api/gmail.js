// api/gmail.js — Tri & réponses automatiques Gmail via OAuth2 refresh token
// Variables Vercel requises :
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   ANTHROPIC_API_KEY (pour les réponses générées)
//
// Setup OAuth :
// 1. Crée un projet sur console.cloud.google.com
// 2. Active l'API Gmail
// 3. Crée des identifiants OAuth 2.0 (type "Application Web")
// 4. Génère un refresh_token via OAuth Playground avec scopes :
//    https://www.googleapis.com/auth/gmail.readonly
//    https://www.googleapis.com/auth/gmail.modify
//    https://www.googleapis.com/auth/gmail.send

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || 'OAuth refresh failed');
  return d.access_token;
}

async function gmailFetch(token, path, init = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const e = new Error(data.error?.message || `Gmail API ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

function decodeB64Url(s) {
  if (!s) return '';
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b, 'base64').toString('utf8');
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeB64Url(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) return decodeB64Url(p.body.data);
    }
    for (const p of payload.parts) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  return '';
}

async function classifyAndReply(subject, from, body) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { category: 'other', priority: 'normal', suggestedReply: '' };
  }
  const prompt = `Tu es l'assistant email d'Elton (entrepreneur dropshipping bijoux, objectif 1M€ fin 2026).
Classe cet email et propose une réponse courte en français (3 phrases max).

De: ${from}
Sujet: ${subject}
Corps: ${body.substring(0, 1500)}

Catégories : client, fournisseur, spam, admin, perso, other.
Priorités : urgent, normal, low.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: {
                type: 'string',
                enum: ['client', 'fournisseur', 'spam', 'admin', 'perso', 'other'],
              },
              priority: {
                type: 'string',
                enum: ['urgent', 'normal', 'low'],
              },
              suggestedReply: { type: 'string' },
            },
            required: ['category', 'priority', 'suggestedReply'],
          },
        },
      },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const d = await r.json();
  const fallback = { category: 'other', priority: 'normal', suggestedReply: '' };
  if (d.stop_reason === 'refusal' || d.stop_reason === 'max_tokens') return fallback;
  const txt = d.content?.find((c) => c.type === 'text')?.text || '';
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function buildRfc822(to, subject, body, fromName = 'Elton') {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject.startsWith('Re:') ? subject : 'Re: ' + subject}`,
    `From: ${fromName}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
  ].join('\r\n');
  const raw = `${headers}\r\n\r\n${body}`;
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    return res.status(500).json({
      error: 'Variables Gmail manquantes (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)',
    });
  }

  try {
    const token = await getAccessToken();
    const action = (req.query?.action || req.url.split('?')[1]?.match(/action=([^&]+)/)?.[1] || 'list').toLowerCase();

    // GET ?action=count — Compte les non-lus (rapide, pas de classification)
    if (req.method === 'GET' && action === 'count') {
      const r = await gmailFetch(
        token,
        `/users/me/messages?q=is:unread in:inbox&maxResults=100`
      );
      return res.status(200).json({
        unread: (r.messages || []).length,
        estimateTotal: r.resultSizeEstimate || 0,
      });
    }

    // GET ?action=auto — Scan automatique : classifie + traite
    //   spam        → archive (retire INBOX + UNREAD)
    //   urgent      → laisse non-lu, signale dans urgentList
    //   non-urgent  → marque comme lu (retire UNREAD seulement, reste dans INBOX)
    // → boîte propre : seuls les urgents restent en non-lu
    if (req.method === 'GET' && action === 'auto') {
      const max = Math.min(parseInt(req.query?.max || '10', 10) || 10, 25);
      const list = await gmailFetch(
        token,
        `/users/me/messages?q=is:unread in:inbox&maxResults=${max}`
      );
      const ids = (list.messages || []).map((m) => m.id);
      const totalEstimate = list.resultSizeEstimate || 0;

      let urgent = 0, archived = 0, marked = 0, processed = 0;
      const urgentList = [];

      await Promise.all(
        ids.map(async (id) => {
          const msg = await gmailFetch(token, `/users/me/messages/${id}?format=full`);
          const headers = msg.payload?.headers || [];
          const h = (n) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || '';
          const subject = h('Subject');
          const from = h('From');
          const body = extractBody(msg.payload);
          const ai = await classifyAndReply(subject, from, body);
          processed++;

          // Spam → archive
          if (ai.category === 'spam') {
            await gmailFetch(token, `/users/me/messages/${id}/modify`, {
              method: 'POST',
              body: JSON.stringify({ removeLabelIds: ['INBOX', 'UNREAD'] }),
            }).catch(() => {});
            archived++;
            return;
          }
          // Urgent → reste non-lu, signal
          if (ai.priority === 'urgent') {
            urgent++;
            urgentList.push({ from, subject, category: ai.category });
            return;
          }
          // Non-urgent non-spam → marque comme lu (retire UNREAD)
          await gmailFetch(token, `/users/me/messages/${id}/modify`, {
            method: 'POST',
            body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
          }).catch(() => {});
          marked++;
        })
      );

      return res.status(200).json({
        processed,
        urgent,
        archived,
        marked,
        remaining: Math.max(0, totalEstimate - processed),
        urgentList: urgentList.slice(0, 5),
      });
    }

    // GET ?action=list — Liste les emails non lus + classification IA
    if (req.method === 'GET' || action === 'list') {
      const max = Math.min(parseInt(req.query?.max || '10', 10) || 10, 25);
      const list = await gmailFetch(
        token,
        `/users/me/messages?q=is:unread in:inbox&maxResults=${max}`
      );
      const ids = (list.messages || []).map((m) => m.id);

      const messages = await Promise.all(
        ids.map(async (id) => {
          const msg = await gmailFetch(token, `/users/me/messages/${id}?format=full`);
          const headers = msg.payload?.headers || [];
          const h = (n) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || '';
          const subject = h('Subject');
          const from = h('From');
          const date = h('Date');
          const body = extractBody(msg.payload);
          const ai = await classifyAndReply(subject, from, body);
          return { id, threadId: msg.threadId, subject, from, date, snippet: msg.snippet, ...ai };
        })
      );

      return res.status(200).json({ count: messages.length, messages });
    }

    // POST {action:"reply", id, body} — Envoi d'une réponse
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const op = body.action || 'reply';

      if (op === 'reply') {
        if (!body.id || !body.body) {
          return res.status(400).json({ error: 'id et body requis' });
        }
        const orig = await gmailFetch(token, `/users/me/messages/${body.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`);
        const headers = orig.payload?.headers || [];
        const h = (n) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || '';
        const raw = buildRfc822(h('From'), h('Subject') || '', body.body);
        const sent = await gmailFetch(token, `/users/me/messages/send`, {
          method: 'POST',
          body: JSON.stringify({ raw, threadId: orig.threadId }),
        });
        // Marquer comme lu
        await gmailFetch(token, `/users/me/messages/${body.id}/modify`, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        }).catch(() => {});
        return res.status(200).json({ ok: true, id: sent.id });
      }

      if (op === 'mark-read') {
        await gmailFetch(token, `/users/me/messages/${body.id}/modify`, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        });
        return res.status(200).json({ ok: true });
      }

      if (op === 'archive') {
        await gmailFetch(token, `/users/me/messages/${body.id}/modify`, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['INBOX', 'UNREAD'] }),
        });
        return res.status(200).json({ ok: true });
      }

      if (op === 'trash') {
        await gmailFetch(token, `/users/me/messages/${body.id}/trash`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'action inconnue' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Gmail error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Erreur Gmail' });
  }
};
