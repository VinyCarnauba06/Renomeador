// ai-extraction.js
// Tier 2 (IA) + orquestrador principal Tier 1 (regras locais) -> Tier 2 (Claude Vision via proxy) -> Tier 3 (OCR local).
// Sem import circular: este módulo importa ocr-pipeline.js, pdf-utils.js, rules-engine.js e state.js;
// nenhum deles importa este módulo de volta.
import {
  AI_SECRET_STORAGE_KEY,
  AI_ENABLED_STORAGE_KEY,
  AI_ENDPOINT_STORAGE_KEY,
  AI_EXTRACT_ENDPOINT,
  MIN_TEXT_LEN_TO_SKIP_OCR,
  CONFIDENCE_THRESHOLD,
} from './config.js';
import { identifyDocument, findExtras, findCondominio, normalize } from './rules-engine.js';
import { ocrFromCanvas, ocrDeepReviewDocument, preprocessCanvasForOCR } from './ocr-pipeline.js';
import { openPdfDocument, extractNativeTextFromPdf, renderPageToCanvas, releaseCanvas, sanitizeFilename } from './pdf-utils.js';
import { getLoteCondominio } from './state.js';

const AI_FETCH_TIMEOUT_MS = 28_000;

/* ============================================================
   CONFIGURAÇÃO DA IA (sem prompt() intrusivo no meio do lote)
   ============================================================ */

export function getAiSecret(){
  try {
    const s = localStorage.getItem(AI_SECRET_STORAGE_KEY);
    return s ? s.trim() : null;
  } catch {
    return null;
  }
}

export function setAiSecret(secret){
  const clean = String(secret || '').trim();
  try {
    if (clean) localStorage.setItem(AI_SECRET_STORAGE_KEY, clean);
    else localStorage.removeItem(AI_SECRET_STORAGE_KEY);
  } catch { /* localStorage indisponível */ }
}

export function getAiEndpoint(){
  try {
    const custom = localStorage.getItem(AI_ENDPOINT_STORAGE_KEY);
    if (custom && custom.trim()) return custom.trim();
  } catch { /* fallback padrão */ }
  return AI_EXTRACT_ENDPOINT;
}

export function setAiEndpoint(url){
  const clean = String(url || '').trim();
  try {
    if (clean) localStorage.setItem(AI_ENDPOINT_STORAGE_KEY, clean);
    else localStorage.removeItem(AI_ENDPOINT_STORAGE_KEY);
  } catch { /* localStorage indisponível */ }
}

export function isAiEnabled(){
  try {
    const raw = localStorage.getItem(AI_ENABLED_STORAGE_KEY);
    if (raw === null) return Boolean(getAiSecret()); // se tem chave salva, vem ligada por padrão
    return raw === '1';
  } catch {
    return false;
  }
}

export function setAiEnabled(enabled){
  try {
    localStorage.setItem(AI_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
  } catch { /* localStorage indisponível */ }
}

export function isAiReady(){
  return isAiEnabled() && Boolean(getAiSecret());
}

/* ============================================================
   CLIENTE HTTP DO PROXY DE IA
   ============================================================ */

function canvasToBase64Jpeg(canvas, quality = 0.85){
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('canvas_to_blob_failed'));
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('file_reader_failed'));
      reader.readAsDataURL(blob);
    }, 'image/jpeg', quality);
  });
}

function buildAiResult(ai, nativeText){
  const rawCondo = ai.condominio ? String(ai.condominio).trim() : null;
  const canonicalCondo = rawCondo ? (findCondominio(normalize(rawCondo)) || rawCondo.toUpperCase()) : undefined;
  const cleanName = sanitizeFilename(ai.nome_sugerido);

  return {
    nome: cleanName,
    confidence: typeof ai.confidence === 'number' ? Math.max(0, Math.min(1, ai.confidence)) : 0.85,
    ruleId: 'ai:' + (ai.tipo_documento || 'desconhecido'),
    fields: {
      ...findExtras(nativeText || ''),
      tipo: ai.tipo_documento ? String(ai.tipo_documento).replace(/_/g, ' ').toUpperCase() : undefined,
      condominio: canonicalCondo,
      data: ai.data || undefined,
      mesAno: ai.mes_ano || undefined,
      unidade: ai.unidade || undefined,
      categoria: ai.categoria || undefined,
      observacao: ai.observacao || undefined,
    },
    text: (nativeText && nativeText.trim()) || '[PDF só-imagem — extraído via IA]',
    usedOCR: false,
    usedAI: true,
  };
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const MAX_AI_ATTEMPTS = 3;

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function extractWithAI(canvas, { hint, loteCondominio } = {}){
  const secret = getAiSecret();
  if (!secret) throw new Error('ai_secret_not_configured');

  const image = await canvasToBase64Jpeg(canvas, 0.85);
  const payload = JSON.stringify({
    image,
    mimeType: 'image/jpeg',
    hint: hint || undefined,
    loteCondominio: loteCondominio || undefined,
  });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++){
    const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(AI_FETCH_TIMEOUT_MS)
      : undefined;

    const res = await fetch(getAiEndpoint(), {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-renomeador-secret': secret },
      body: payload,
    });

    if (res.status === 401){
      // Chave errada/expirada — remove pra não insistir nos próximos arquivos do lote
      setAiSecret('');
      throw new Error('ai_unauthorized');
    }
    if (res.ok) return res.json();

    lastError = new Error(`ai_http_${res.status}`);
    if (!RETRYABLE_HTTP_STATUSES.has(res.status) || attempt === MAX_AI_ATTEMPTS){
      throw lastError;
    }

    // Backoff exponencial com respeito a Retry-After (ex.: rate limit 429 em lotes de 400+ PDFs)
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const baseDelay = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(retryAfterSec * 1000, 15_000)
      : 1500 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 400);
    await sleep(baseDelay + jitter);
  }
  throw lastError || new Error('ai_unknown_error');
}

/* ============================================================
   ORQUESTRAÇÃO: TIER 1 (REGRAS) -> TIER 2 (IA) -> TIER 3 (OCR)
   ============================================================ */

export async function identifyDocumentSmart(file){
  const pdf = await openPdfDocument(file);
  try {
    const nativeText = await extractNativeTextFromPdf(pdf, 3);
    const hasNativeText = nativeText.trim().length >= MIN_TEXT_LEN_TO_SKIP_OCR;
    let localFromNative = null;

    if (hasNativeText){
      localFromNative = identifyDocument(nativeText, null);
      if (localFromNative.nome && localFromNative.confidence >= CONFIDENCE_THRESHOLD){
        return { ...localFromNative, text: nativeText, usedOCR: false, usedAI: false };
      }
    }

    const page1 = await pdf.getPage(1);
    // Escala 2.0 (~144 DPI): ~36% menos pixels que 2.5 — acelera bem o OCR local e também encaixa no
    // tamanho ideal da Anthropic Vision (que redimensiona >1568px). Revisão profunda continua em 3.5.
    const canvas = await renderPageToCanvas(page1, 2.0);
    try {
      if (isAiReady()){
        try {
          const ai = await extractWithAI(canvas, { loteCondominio: getLoteCondominio() });
          if (ai && ai.nome_sugerido){
            return buildAiResult(ai, nativeText);
          }
        } catch (err){
          console.warn('Extração via IA falhou, caindo pro OCR local:', err);
        }
      }

      // Se o PDF já tinha texto nativo (só não atingiu confiança alta na Tier 1 e a IA não resolveu),
      // não desperdiça tempo fazendo OCR em cima de texto já pesquisável.
      if (hasNativeText && localFromNative){
        return { ...localFromNative, text: nativeText, usedOCR: false, usedAI: false };
      }

      // Reaproveita o MESMO canvas já renderizado (evita abrir/parsear o PDF novamente).
      const ocr = await ocrFromCanvas(canvas, { alreadyPreprocessed: false });
      const result = identifyDocument(ocr.text, ocr.ocrConfidence);
      return { ...result, text: ocr.text, usedOCR: true, usedAI: false, rotationUsed: ocr.rotationUsed };
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    await pdf.destroy();
  }
}

// Revisão sob demanda para documentos com baixa confiança / não identificados (ou forçada pelo usuário via
// "Reprocessar filtrados"): tenta IA em resolução maior (3.5x) com hint (ignora cache SHA-256) primeiro se
// configurada; senão (ou se falhar), roda OCR profundo local.
export async function reviewDocumentSmart(row, { force = false } = {}){
  if (!force && !row.usedOCR && !row.usedAI){
    return null; // texto nativo já foi lido sem erro de OCR
  }

  if (isAiReady()){
    const pdf = await openPdfDocument(row.originalFile);
    try {
      const page1 = await pdf.getPage(1);
      const canvasAI = await renderPageToCanvas(page1, 3.5);
      try {
        preprocessCanvasForOCR(canvasAI);
        const ai = await extractWithAI(canvasAI, {
          hint: 'baixa_confianca_revisar_com_cuidado_inclusive_rotacao_e_condominio',
          loteCondominio: getLoteCondominio(),
        });
        if (ai && ai.nome_sugerido){
          const built = buildAiResult(ai, row.ocrText);
          return {
            text: row.ocrText || built.text,
            ocrConfidence: built.confidence,
            usedAI: true,
            result: {
              nome: built.nome,
              confidence: built.confidence,
              ruleId: built.ruleId,
              fields: built.fields,
            },
          };
        }
      } finally {
        releaseCanvas(canvasAI);
      }
    } catch (err){
      console.warn('Revisão via IA falhou, caindo pro OCR profundo local:', err);
    } finally {
      await pdf.destroy();
    }
  }

  // Sempre tenta OCR profundo local como último recurso (mesmo se a tentativa original foi via IA).
  return ocrDeepReviewDocument(row.originalFile);
}
