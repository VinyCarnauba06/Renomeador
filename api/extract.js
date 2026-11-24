// api/extract.js
// Proxy serverless (Vercel) para extração via IA (suporta Gemini Flash e Claude Haiku).
// As chaves de API vivem só aqui (env vars), nunca no navegador. O front-end (mesma origem no Vercel
// ou GitHub Pages) se autentica com um segredo compartilhado (RENOMEADOR_SHARED_SECRET).

// CommonJS de propósito — evita depender de "type": "module" no package.json (Vercel detecta sozinho).
const crypto = require('crypto');
const { getCachedExtraction, saveCachedExtraction, logExtraction } = require('./_supabase');

module.exports = handler;
module.exports.config = { runtime: 'nodejs' };

const ALLOWED_ORIGINS = new Set([
  'https://renomeador.carnauba.dev.br', // domínio customizado (CNAME / Vercel)
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

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_HINT_LENGTH = 240;
const UPSTREAM_TIMEOUT_MS = 25_000;

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
      const parsed = new URL(origin);
      if (parsed.host === host) return true; // same-origin (ex.: preview *.vercel.app)
    } catch {
      return false;
    }
  }
  return false;
}

function resolveProvider() {
  const forced = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (forced === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// Convenções de nome de arquivo aprendidas no projeto (ver CONTEXTO_PROJETO.md).
const SYSTEM_PROMPT = `Você é um extrator de dados de documentos administrativos de condomínios brasileiros (faturas, recibos, extratos bancários, boletos, protocolos, comprovantes de pagamento, DARF, declarações, atas, orçamentos, etc.), digitalizados e às vezes rotacionados ou com baixa qualidade.

Responda SEMPRE e SOMENTE com um objeto JSON válido (sem markdown, sem texto antes/depois), no formato:
{
  "tipo_documento": "slug_curto_em_snake_case",
  "condominio": "NOME DO CONDOMÍNIO EM MAIÚSCULO ou null se não conseguir identificar",
  "data": "DD/MM/AAAA ou null",
  "mes_ano": "MES/AAAA abreviado tipo 'AGO/2026' ou null",
  "unidade": "número do apartamento/unidade ou null",
  "categoria": "ex: AGUA, LUZ, GAS, CONDOMINIO, ALUGUEL, PIX, etc. ou null",
  "nome_sugerido": "NOME DE ARQUIVO JÁ FORMATADO, EM MAIÚSCULO, SEM EXTENSÃO",
  "confidence": 0.0 a 1.0,
  "observacao": "opcional, texto curto só se algo for ambíguo"
}

Convenções OBRIGATÓRIAS pra montar "nome_sugerido" (siga o padrão mais específico que se aplicar; todas em MAIÚSCULO, campos separados por espaço, sem acentos problemáticos, sem caracteres especiais de sistema de arquivos):
- "PROTOCOLO {DD.MM}" — protocolo de entrega de boletos / setor boletos (sem condomínio, use a data da entrega/enviado)
- "PROTOCOLO {condominio} {MES_POR_EXTENSO}" — lista de proprietários/inquilinos/locatários de entrega da taxa de condomínio
- "PROTOCOLO RESERVA {condominio}" ou "TERMO {condominio} {DD.MM}" — reserva de salão de festas
- "FATURA {EQUATORIAL|CLARO|GAS|AGUA} {condominio} {MES} {ANO}"
- "COMPROVANTE {PIX|BOLETO} {condominio} {DD.MM}"
- "EXTRATO [APLICACAO|CAPTACAO] {condominio} {MES} {ANO}"
- "RECIBO [CARTORIO] {condominio} {DD.MM}"
- "NADA CONSTA {condominio} {unidade}" ou "DECLARACAO {condominio} {unidade}"
- "BOLETO RATEIO {condominio} {unidade} {MES} {ANO}"
- "RELATORIO DESPESAS {condominio} {categoria} {DD.MM}"
- "NOTA COBRANCA {condominio} {DD.MM}"
- "DARF {condominio} {DD.MM}"
- "BOLETO {condominio} {DD.MM}" — genérico, quando nenhum padrão acima se aplica mas ainda é um boleto
- Se o tipo de documento não se encaixar em nenhum padrão acima, monte um nome análogo e coerente: TIPO_EM_MAIUSCULO + condominio (se houver) + data/mês (se houver). Nunca invente tipo genérico demais tipo "DOCUMENTO".

Regras de confiança:
- confidence deve refletir sua certeza real. Se não conseguir ler o condomínio com clareza, isso deve DERRUBAR a confiança pra abaixo de 0.7, mesmo que o tipo esteja claro (exceto nos tipos que por natureza não levam condomínio: protocolo de entrega de boletos, reservas em planilha-mestre com vários condomínios, comprovante de consumo Sicredi).
- Se a imagem estiver ilegível/cortada, retorne confidence baixo (< 0.4) e nome_sugerido com o melhor palpite mesmo assim (nunca null).
- Nomes de condomínio podem vir abreviados ("RES.", "EDF", "COND") — normalize pro nome mais limpo sem inventar.

Se a imagem não for um documento de condomínio (lixo, página em branco, foto não relacionada), responda com tipo_documento "nao_identificado", condominio null, nome_sugerido genérico e confidence 0.`;

async function callGemini({ image, mimeType, userText }) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const aiRes = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: image } },
            { text: userText },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    }),
  });
  return {
    ok: aiRes.ok,
    status: aiRes.status,
    retryAfter: aiRes.headers.get('retry-after'),
    getText: async () => {
      const data = await aiRes.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    },
    getErrorDetail: () => aiRes.text().catch(() => ''),
  };
}

async function callAnthropic({ image, mimeType, userText }) {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } },
            { type: 'text', text: userText },
          ],
        },
      ],
    }),
  });
  return {
    ok: aiRes.ok,
    status: aiRes.status,
    retryAfter: aiRes.headers.get('retry-after'),
    getText: async () => {
      const data = await aiRes.json();
      return data?.content?.[0]?.text || '';
    },
    getErrorDetail: () => aiRes.text().catch(() => ''),
  };
}

async function handler(req, res) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin, req.headers.host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Renomeador-Secret');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const secretHeader = req.headers['x-renomeador-secret'];
  if (!secretsMatch(secretHeader, process.env.RENOMEADOR_SHARED_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const provider = resolveProvider();
  if (!provider) {
    return res.status(500).json({ error: 'server_misconfigured', detail: 'Configure GEMINI_API_KEY ou ANTHROPIC_API_KEY' });
  }

  const { image, mimeType, hint, loteCondominio } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'missing_image' });
  }
  if (image.length > MAX_IMAGE_BYTES * 1.4) {
    return res.status(413).json({ error: 'image_too_large' });
  }
  const safeMimeType = ALLOWED_MIME_TYPES.has(mimeType) ? mimeType : 'image/jpeg';
  const safeHint = typeof hint === 'string'
    ? hint.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_HINT_LENGTH)
    : '';
  const safeLoteCondo = typeof loteCondominio === 'string'
    ? loteCondominio.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)
    : '';

  const extraNotes = [];
  if (safeHint) {
    extraNotes.push(`Dica de revisão: este documento falhou numa tentativa anterior (${safeHint}) — preste atenção redobrada em rotação, condomínio e data.`);
  }
  if (safeLoteCondo) {
    extraNotes.push(`Contexto do lote: o usuário informou que este lote provavelmente pertence ao condomínio "${safeLoteCondo}" — use-o apenas se o documento não indicar claramente outro condomínio.`);
  }
  const userText = extraNotes.length
    ? `Extraia os dados deste documento e responda SOMENTE com o JSON pedido.\n${extraNotes.join('\n')}`
    : 'Extraia os dados deste documento e responda SOMENTE com o JSON pedido.';

  const imageHash = crypto.createHash('sha256').update(image).digest('hex');

  // Cache por SHA-256 (ignora cache apenas em revisão forçada com hint explícito)
  if (!safeHint) {
    const cached = await getCachedExtraction(imageHash);
    if (cached && cached.result) {
      logExtraction({
        provider: cached.provider,
        tipoDocumento: cached.result.tipo_documento,
        confidence: cached.result.confidence,
        cacheHit: true,
      }).catch(() => {});
      res.setHeader('X-AI-Provider', cached.provider || provider);
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached.result);
    }
  }

  try {
    const upstream = provider === 'gemini'
      ? await callGemini({ image, mimeType: safeMimeType, userText })
      : await callAnthropic({ image, mimeType: safeMimeType, userText });

    if (!upstream.ok) {
      const detail = await upstream.getErrorDetail();
      if (upstream.status === 429) {
        if (upstream.retryAfter) res.setHeader('Retry-After', upstream.retryAfter);
        return res.status(429).json({ error: 'ai_rate_limited', provider, detail });
      }
      return res.status(502).json({ error: 'ai_upstream_error', provider, status: upstream.status, detail });
    }

    const raw = await upstream.getText();
    const parsed = extractJson(raw);
    if (!parsed) {
      return res.status(502).json({ error: 'ai_bad_output', provider, raw });
    }

    if (typeof parsed.nome_sugerido === 'string') {
      parsed.nome_sugerido = parsed.nome_sugerido
        .replace(/[\/\\]+/g, '.')
        .replace(/[:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Persiste no cache apenas resultados com confiança minimamente útil (>= 0.5)
    if (typeof parsed.confidence !== 'number' || parsed.confidence >= 0.5) {
      saveCachedExtraction(imageHash, provider, parsed).catch(() => {});
    }
    logExtraction({
      provider,
      tipoDocumento: parsed.tipo_documento,
      confidence: parsed.confidence,
      cacheHit: false,
    }).catch(() => {});

    res.setHeader('X-AI-Provider', provider);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(parsed);
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return res.status(504).json({ error: 'ai_timeout', provider });
    }
    return res.status(500).json({ error: 'server_error', provider, detail: String(err && err.message || err) });
  }
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
