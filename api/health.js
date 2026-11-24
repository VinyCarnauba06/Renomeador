// api/health.js
// Endpoint leve de status do backend serverless (não expõe nenhum segredo).
const { isSupabaseConfigured } = require('./_supabase');

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const configuredProvider = resolveConfiguredProvider();
  return res.status(200).json({
    ok: Boolean(configuredProvider && process.env.RENOMEADOR_SHARED_SECRET),
    provider: configuredProvider,
    secretConfigured: Boolean(process.env.RENOMEADOR_SHARED_SECRET),
    supabaseConfigured: isSupabaseConfigured(),
  });
};

function resolveConfiguredProvider() {
  const forced = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (forced === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
