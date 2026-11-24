// api/_supabase.js
// Cliente leve (sem SDK) para a API REST do Supabase, usado apenas no servidor (Vercel Functions).
// Prefixo "_" garante que o Vercel não exponha este arquivo como endpoint HTTP.
// Se SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não estiverem configuradas, todas as funções viram no-op seguro.

const SUPABASE_TIMEOUT_MS = 4_000;

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  if (!url || !key) return null;
  return { url, key };
}

function isSupabaseConfigured() {
  return Boolean(getSupabaseConfig());
}

async function supabaseRest(path, { method = 'GET', body, headers = {} } = {}) {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;

  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`supabase_http_${res.status}: ${detail.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getCachedExtraction(imageHash) {
  if (!isSupabaseConfigured() || !imageHash) return null;
  try {
    const rows = await supabaseRest(
      `extraction_cache?image_hash=eq.${encodeURIComponent(imageHash)}&select=provider,result,hit_count&limit=1`
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const hit = rows[0];
    // Atualiza contador em background (não bloqueia a resposta)
    supabaseRest(`extraction_cache?image_hash=eq.${encodeURIComponent(imageHash)}`, {
      method: 'PATCH',
      body: { hit_count: (hit.hit_count || 0) + 1, last_hit_at: new Date().toISOString() },
    }).catch(() => {});
    return hit;
  } catch (err) {
    console.warn('Supabase cache read falhou:', err.message);
    return null;
  }
}

async function saveCachedExtraction(imageHash, provider, result) {
  if (!isSupabaseConfigured() || !imageHash || !result) return;
  try {
    await supabaseRest('extraction_cache?on_conflict=image_hash', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: {
        image_hash: imageHash,
        provider,
        result,
        last_hit_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn('Supabase cache write falhou:', err.message);
  }
}

async function logExtraction({ provider, tipoDocumento, confidence, cacheHit }) {
  if (!isSupabaseConfigured()) return;
  try {
    await supabaseRest('extraction_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: {
        provider: String(provider || 'unknown').slice(0, 40),
        tipo_documento: tipoDocumento ? String(tipoDocumento).slice(0, 80) : null,
        confidence: typeof confidence === 'number' ? confidence : null,
        cache_hit: Boolean(cacheHit),
      },
    });
  } catch (err) {
    console.warn('Supabase log write falhou:', err.message);
  }
}

async function listLearnedCondominios() {
  if (!isSupabaseConfigured()) return [];
  const rows = await supabaseRest('condominios_aprendidos?select=nome,aliases&order=nome.asc');
  return Array.isArray(rows) ? rows : [];
}

async function upsertLearnedCondominios(entries) {
  if (!isSupabaseConfigured() || !Array.isArray(entries) || entries.length === 0) return [];
  const existentes = await listLearnedCondominios();
  const byName = new Map(existentes.map(e => [e.nome, new Set(Array.isArray(e.aliases) ? e.aliases : [e.nome])]));

  const payload = [];
  for (const item of entries) {
    if (!item || typeof item.nome !== 'string') continue;
    const nome = item.nome.trim().toUpperCase().slice(0, 120);
    if (!nome) continue;
    const aliasSet = byName.get(nome) || new Set([nome]);
    aliasSet.add(nome);
    const incoming = Array.isArray(item.aliases) ? item.aliases : [];
    for (const a of incoming) {
      const clean = String(a || '').trim().toUpperCase().slice(0, 120);
      if (clean) aliasSet.add(clean);
    }
    byName.set(nome, aliasSet);
    payload.push({
      nome,
      aliases: [...aliasSet],
      updated_at: new Date().toISOString(),
    });
  }

  if (payload.length === 0) return existentes;

  await supabaseRest('condominios_aprendidos?on_conflict=nome', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: payload,
  });

  return listLearnedCondominios();
}

module.exports = {
  isSupabaseConfigured,
  getCachedExtraction,
  saveCachedExtraction,
  logExtraction,
  listLearnedCondominios,
  upsertLearnedCondominios,
};
