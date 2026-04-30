// api/schedule.js — Gestion des notifications push planifiées
//
// POST  /api/schedule        → planifie une notif {subscription, payload, scheduledAt}
// GET   /api/schedule        → liste les notifs planifiées
// DELETE /api/schedule?id=X  → annule une notif

const { cmd, configured } = require('../lib/kv');

const KEY = 'gaia:scheduled';
const MAX_AGE_DAYS = 30;

async function readList() {
  const raw = await cmd('GET', KEY);
  try {
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeList(list) {
  return cmd('SET', KEY, JSON.stringify(list));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!configured()) {
    return res.status(500).json({
      error:
        'Vercel KV non configuré. Storage → Create → KV dans le dashboard Vercel.',
    });
  }

  try {
    if (req.method === 'GET') {
      const list = await readList();
      return res.status(200).json({
        count: list.length,
        scheduled: list.map(({ id, payload, due }) => ({
          id,
          title: payload.title,
          body: payload.body,
          due: new Date(due).toISOString(),
        })),
      });
    }

    if (req.method === 'POST') {
      const body =
        typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const { subscription, payload, scheduledAt } = body;

      if (!subscription?.endpoint) {
        return res.status(400).json({ error: 'subscription.endpoint requis' });
      }
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'payload requis' });
      }
      if (!scheduledAt) {
        return res.status(400).json({ error: 'scheduledAt requis' });
      }

      const due = new Date(scheduledAt).getTime();
      if (isNaN(due)) {
        return res.status(400).json({ error: 'scheduledAt invalide' });
      }

      const list = await readList();
      const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      list.push({
        id,
        subscription,
        payload,
        due,
        createdAt: Date.now(),
      });

      // Nettoyage : supprime les entrées de plus de 30 jours
      const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
      const fresh = list.filter((s) => s.createdAt > cutoff);

      await writeList(fresh);
      return res.status(200).json({
        ok: true,
        id,
        due: new Date(due).toISOString(),
        total: fresh.length,
      });
    }

    if (req.method === 'DELETE') {
      const u = new URL(req.url, 'http://x');
      const id = u.searchParams.get('id');
      if (!id) return res.status(400).json({ error: 'id requis' });

      const list = await readList();
      const filtered = list.filter((s) => s.id !== id);
      const removed = list.length - filtered.length;
      if (removed > 0) await writeList(filtered);
      return res.status(200).json({ ok: true, removed });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Schedule error:', err);
    return res.status(500).json({ error: err.message });
  }
};
