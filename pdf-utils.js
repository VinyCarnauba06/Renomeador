// pdf-utils.js
// Utilitários puros compartilhados: sanitização de nomes de arquivo, escape HTML,
// abertura/leitura/renderização de PDF (PDF.js) e liberação explícita de memória de canvas.

const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let workerConfigured = false;

function ensurePdfWorker(){
  if (!workerConfigured && typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions){
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
    workerConfigured = true;
  }
}

export function stripPdfExt(name){
  return String(name || '').trim().replace(/\.pdf$/i, '').trim();
}

export function ensurePdfExt(name){
  const base = sanitizeFilename(stripPdfExt(name));
  return `${base}.pdf`;
}

// Remove caracteres proibidos em Windows/macOS/Linux e ZIP (especialmente `/` e `\`, que viram subpastas no JSZip).
export function sanitizeFilename(name, fallback = 'DOCUMENTO'){
  let clean = String(name || '')
    .replace(/[\/\\]+/g, '.')        // datas tipo 05/08/2026 ou unidades 101/102 viram 05.08.2026 / 101.102
    .replace(/[:*?"<>|]/g, ' ')      // proibidos no Windows
    .replace(/[\x00-\x1f\x7f]/g, '') // caracteres de controle
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');

  if (clean.length > 160){
    clean = clean.slice(0, 160).replace(/[.\s]+$/, '');
  }
  return clean || fallback;
}

export function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function escapeAttr(s){
  return escapeHtml(s);
}

// Canvas fora do DOM não libera bitmap só com canvas.remove(); zerar dimensões libera a memória de GPU/RAM.
export function releaseCanvas(canvas){
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  if (typeof canvas.remove === 'function') canvas.remove();
}

export async function openPdfDocument(file){
  ensurePdfWorker();
  const buf = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: buf }).promise;
}

export async function extractNativeTextFromPdf(pdf, maxPages = 3){
  let text = '';
  const limit = Math.min(pdf.numPages, maxPages);
  for (let i = 1; i <= limit; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  return text;
}

// Renderiza página com fundo branco explícito (PDFs com fundo transparente viram preto em JPEG/OCR sem isso).
export async function renderPageToCanvas(page, scale){
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}
