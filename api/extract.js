// api/extract.js
// Proxy serverless (Vercel) entre o front-end estático (GitHub Pages) e a Anthropic API.
// A chave da Anthropic vive só aqui (env var), nunca no navegador. O front-end se autentica com um
// segredo compartilhado próprio (RENOMEADOR_SHARED_SECRET) — mais simples que OAuth/login pra um app
// de uso pessoal, mas evita que qualquer um que ache a URL queime seu crédito de API.

// CommonJS de propósito — evita depender de "type": "module" no package.json (Vercel detecta sozinho).
const crypto = require('crypto');

module.exports = handler;
module.exports.config = { runtime: 'nodejs' };

const ALLOWED_ORIGINS = new Set([
  'https://renomeador.carnauba.dev.br', // domínio customizado (CNAME)
  'https://vinycarnauba06.github.io',
  'http://localhost:3000', // dev local (ex.: `npx serve`)
  'http://127.0.0.1:3000',
  'http://localhost:5500', // Live Server
  'http://127.0.0.1:5500',
  'http://localhost:5173',
]);
for (const extra of String(process.env.EXTRA_ALLOWED_ORIGINS || '').split(',')){
  const trimmed = extra.trim();
  if (trimmed) ALLOWED_ORIGINS.add(trimmed);
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // limite de segurança (base64 já é ~33% maior que o binário)
const MAX_HINT_LENGTH = 240;
const UPSTREAM_TIMEOUT_MS = 25_000;

function secretsMatch(provided, expected){
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Convenções de nome de arquivo aprendidas no projeto (ver CONTEXTO_PROJETO.md) — mantidas aqui pra o
// modelo seguir o mesmo padrão que o motor de regras local já usa, mesmo em documentos/condomínios novos.
const SYSTEM_PROMPT = `Você é um extrator de dados de documentos administrativos de condomínios brasileiros (faturas, recibos, extratos bancários, boletos, protocolos, comprovantes de pagamento, DARF, declarações, atas, orçamentos, etc.), digitalizados e às vezes com baixa qualidade de imagem ou rotacionados.

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
- "PROTOCOLO {data}" — entrega de boletos (sem condomínio)
- "PROTOCOLO RESERVA {condominio}" ou "TERMO {condominio} {data}" — reserva de salão de festas
- "FATURA {EQUATORIAL|CLARO|GAS|AGUA} {condominio} {mes} {ano}"
- "COMPROVANTE {PIX|BOLETO} {condominio} {data}"
- "EXTRATO [APLICACAO|CAPTACAO] {condominio} {mes} {ano}"
- "RECIBO [CARTORIO] {condominio} {data}"
- "NADA CONSTA {condominio} {unidade}" ou "DECLARACAO {condominio} {unidade}"
- "BOLETO RATEIO {condominio} {unidade} {mes} {ano}"
- "RELATORIO DESPESAS {condominio} {categoria} {data}"
- "NOTA COBRANCA {condominio} {data}"
- "DARF {condominio} {data}"
- "BOLETO {condominio} {data}" — genérico, quando nenhum padrão acima se aplica mas ainda é um boleto
- Se o tipo de documento não se encaixar em nenhum padrão acima, monte um nome análogo e coerente: TIPO_EM_MAIUSCULO + condominio (se houver) + data/mês (se houver). Nunca invente tipo genérico demais tipo "DOCUMENTO" — leia o conteúdo e nomeie pelo que ele realmente é.

Regras de confiança:
- confidence deve refletir sua certeza real. Se não conseguir ler o condomínio com clareza, isso deve DERRUBAR a confiança pra abaixo de 0.7, mesmo que o tipo de documento esteja claro — o condomínio é o dado mais importante do nome pra esse fluxo (exceto nos tipos que por natureza não levam condomínio: protocolo de entrega de boletos genérico, reservas em planilha-mestre com vários condomínios, comprovante de consumo Sicredi).
- Se a imagem estiver ilegível/rotacionada/cortada a ponto de não dar pra confiar em nada, retorne confidence baixo (< 0.4) e nome_sugerido com o melhor palpite mesmo assim (nunca null).
- Nomes de condomínio podem vir abreviados ou com ruído de digitalização (ex: "RES.", "RESID", "EDF", "COND") — normalize pro nome completo mais provável, mas sem inventar um condomínio que não esteja escrito no documento.

Se a imagem não for um documento de condomínio (lixo, página em branco, foto não relacionada), responda com tipo_documento "nao_identificado", condominio null, nome_sugerido com um nome descritivo genérico, e confidence 0.`;

async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'server_misconfigured', detail: 'ANTHROPIC_API_KEY ausente' });
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

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: safeMimeType, data: image } },
              { type: 'text', text: userText },
            ],
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => '');
      return res.status(502).json({ error: 'ai_upstream_error', status: aiRes.status, detail });
    }

    const data = await aiRes.json();
    const raw = data?.content?.[0]?.text || '';
    const parsed = extractJson(raw);
    if (!parsed) {
      return res.status(502).json({ error: 'ai_bad_output', raw });
    }

    if (typeof parsed.nome_sugerido === 'string') {
      parsed.nome_sugerido = parsed.nome_sugerido
        .replace(/[\/\\]+/g, '.')
        .replace(/[:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return res.status(200).json(parsed);
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return res.status(504).json({ error: 'ai_timeout' });
    }
    return res.status(500).json({ error: 'server_error', detail: String(err && err.message || err) });
  }
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
