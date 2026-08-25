// ai-extraction.js
// Tier 2: extração via IA — fallback inteligente pra tudo que DOCUMENT_TYPES/CONDOMINIOS (Tier 1, motor de
// regras local) não cobre.
//
// O motor de regras é rápido e grátis, mas é fechado: só reconhece os tipos/condomínios que já foram
// ensinados nele manualmente. Em vez de continuar ampliando regex pra cada caso novo, qualquer documento
// que o motor de regras não resolver com confiança suficiente é mandado, como imagem, pra um backend
// serverless que chama a Claude API (visão) e devolve a extração já estruturada — generaliza pra
// condomínio/tipo de documento nunca visto sem precisar editar código.
//
// Import circular com ocr-pipeline.js: identifyDocumentSmart() usa renderPageToCanvas/extractPdfText de lá
// (Tier 3, caminho normal e fallback final); reviewDocument() de lá chama extractWithAI() daqui de volta.
// Seguro pelo mesmo motivo do ciclo config.js/rules-engine.js — ver comentário lá.
import { AI_SECRET_STORAGE_KEY, AI_EXTRACT_ENDPOINT, MIN_TEXT_LEN_TO_SKIP_OCR, CONFIDENCE_THRESHOLD } from './config.js';
import { identifyDocument, findExtras } from './rules-engine.js';
import { renderPageToCanvas, extractPdfText } from './ocr-pipeline.js';

// Pede a chave de acesso do backend uma única vez e guarda em localStorage (nunca é a chave da Anthropic —
// é só um segredo compartilhado entre este front-end e o proxy serverless, pra evitar uso por terceiros).
function getAiSecret(){
  let secret = localStorage.getItem(AI_SECRET_STORAGE_KEY);
  if (!secret){
    secret = window.prompt('Cole a chave de acesso do backend de IA:');
    if (secret) localStorage.setItem(AI_SECRET_STORAGE_KEY, secret.trim());
  }
  return secret ? secret.trim() : null;
}

function canvasToBase64Jpeg(canvas, quality){
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('canvas_to_blob_failed'));
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('file_reader_failed'));
      reader.readAsDataURL(blob);
    }, 'image/jpeg', quality || 0.85);
  });
}

// Chama o proxy serverless (api/extract.js) com a página renderizada como imagem. Lança erro em qualquer
// falha (sem chave, sem rede, backend fora do ar) — quem chama decide o fallback (ver identifyDocumentSmart).
export async function extractWithAI(canvas, { hint } = {}){
  const secret = getAiSecret();
  if (!secret) throw new Error('ai_secret_not_configured');
  const image = await canvasToBase64Jpeg(canvas, 0.85);
  const res = await fetch(AI_EXTRACT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-renomeador-secret': secret },
    body: JSON.stringify({ image, mimeType: 'image/jpeg', hint }),
  });
  if (res.status === 401){
    // chave errada/expirada — some com ela pra não insistir com a mesma chave em todos os próximos arquivos
    localStorage.removeItem(AI_SECRET_STORAGE_KEY);
    throw new Error('ai_unauthorized');
  }
  if (!res.ok) throw new Error(`ai_http_${res.status}`);
  return res.json();
}

// Orquestrador principal: tenta o motor de regras local (grátis, instantâneo) primeiro; só recorre à IA
// quando o texto nativo não existe/não basta ou o motor de regras não reconheceu nada com confiança
// suficiente; se a IA falhar (rede, sem chave), cai pro pipeline antigo de OCR local + regras como último
// recurso, pra o app nunca ficar completamente sem funcionar.
export async function identifyDocumentSmart(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let nativeText = '';
  const maxPages = Math.min(pdf.numPages, 3);
  for (let i = 1; i <= maxPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    nativeText += content.items.map(it => it.str).join(' ') + '\n';
  }
  const hasNativeText = nativeText.trim().length >= MIN_TEXT_LEN_TO_SKIP_OCR;

  if (hasNativeText){
    const local = identifyDocument(nativeText, null);
    if (local.nome && local.confidence >= CONFIDENCE_THRESHOLD){
      return { ...local, text: nativeText, usedOCR: false, usedAI: false };
    }
  }

  try {
    const page1 = await pdf.getPage(1);
    const canvas = await renderPageToCanvas(page1, 2.5);
    const ai = await extractWithAI(canvas);
    canvas.remove();
    if (ai && ai.nome_sugerido){
      return {
        nome: ai.nome_sugerido,
        confidence: typeof ai.confidence === 'number' ? ai.confidence : 0.85,
        ruleId: 'ai:' + (ai.tipo_documento || 'desconhecido'),
        fields: {
          ...findExtras(nativeText),
          condominio: ai.condominio || undefined,
          data: ai.data || undefined,
          unidade: ai.unidade || undefined,
          categoria: ai.categoria || undefined,
        },
        text: nativeText.trim() || '[PDF só-imagem — extraído via IA]',
        usedOCR: false,
        usedAI: true,
      };
    }
  } catch (err){
    console.warn('Extração via IA falhou, caindo pro OCR local:', err);
  }

  const { text, ocrConfidence, usedOCR, rotationUsed } = await extractPdfText(file);
  const result = identifyDocument(text, ocrConfidence);
  return { ...result, text, usedOCR, usedAI: false, rotationUsed };
}
