// api/condominios.js
// Sincronização na nuvem (Supabase) da lista de condomínios aprendidos manualmente.
// Autenticado com o mesmo RENOMEADOR_SHARED_SECRET do /api/extract.
const crypto = require('crypto');
const { isSupabaseConfigured, listLearnedCondominios, upsertLearnedCondominios } = require('./_supabase');

module.exports = handler;
module.exports.config = { runtime: 'nodejs' };

const ALLOWED_ORIGINS = new Set([
  'https://renomeador.carnauba.dev.br',
  'https://vinycarnauba06.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:5173',
]);
for (const extra of String(process.env.EXTRA_ALLOWED_ORIGINS || '').split(',')) {
  const trimmed = extra.trim();
  if (trimmed) ALLOWED_ORIGINS.add(trimmed);
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isOriginAllowed(origin, host) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (host) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

async function handler(req, res) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin, req.headers.host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Renomeador-Secret');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const secretHeader = req.headers['x-renomeador-secret'];
  if (!secretsMatch(secretHeader, process.env.RENOMEADOR_SHARED_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: 'supabase_not_configured' });
  }

  try {
    if (req.method === 'GET') {
      const items = await listLearnedCondominios();
      return res.status(200).json({ items });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const entries = Array.isArray(body.items)
        ? body.items
        : (body.nome ? [{ nome: body.nome, aliases: body.aliases || [] }] : []);

      if (entries.length === 0) {
        return res.status(400).json({ error: 'missing_entries' });
      }
      if (entries.length > 200) {
        return res.status(400).json({ error: 'too_many_entries' });
      }

      const items = await upsertLearnedCondominios(entries);
      return res.status(200).json({ items });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', detail: String(err && err.message || err) });
  }
}
