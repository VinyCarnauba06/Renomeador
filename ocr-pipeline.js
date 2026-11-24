// ocr-pipeline.js
// Tier 3: leitura de PDF via texto nativo -> OCR local (Tesseract), com pré-processamento adaptativo
// (contraste por percentil + binarização Bradley-Roth sob demanda), correção automática de rotação e
// revisão profunda. Sem dependência de IA — a orquestração Tier 1 -> Tier 2 -> Tier 3 vive em ai-extraction.js.
import { normalize, identifyDocument } from './rules-engine.js';
import { MIN_TEXT_LEN_TO_SKIP_OCR } from './config.js';
import { openPdfDocument, extractNativeTextFromPdf, renderPageToCanvas, releaseCanvas } from './pdf-utils.js';

/* ============================================================
   PRÉ-PROCESSAMENTO DE IMAGEM PARA OCR
   ============================================================ */

// Converte para tons de cinza e estica o contraste usando percentis (2%–98%) via histograma.
// Diferente do min-max simples (que falha se houver um único pixel preto de borda/sombra e um branco),
// cortar 2% das extremidades recupera contraste real em digitalizações amareladas ou com sombra.
export function preprocessCanvasForOCR(canvas){
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);

  for (let i = 0, p = 0; i < d.length; i += 4, p++){
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    gray[p] = g;
    hist[g]++;
  }

  const lowTarget = Math.floor(n * 0.02);
  const highTarget = Math.floor(n * 0.98);
  let acc = 0, low = 0, high = 255;
  for (let v = 0; v < 256; v++){
    acc += hist[v];
    if (acc >= lowTarget){ low = v; break; }
  }
  acc = 0;
  for (let v = 0; v < 256; v++){
    acc += hist[v];
    if (acc >= highTarget){ high = v; break; }
  }

  const range = Math.max(high - low, 1);
  for (let i = 0, p = 0; i < d.length; i += 4, p++){
    let norm = (gray[p] - low) / range;
    if (norm < 0) norm = 0;
    else if (norm > 1) norm = 1;
    const v = Math.round(norm * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// Binarização adaptativa de Bradley-Roth usando Integral Image (O(W*H), ~15ms em 2000x2800).
// Excelente para fotos de celular com sombra, papel amarelado ou iluminação desigual, onde
// threshold global falha. Devolve um novo canvas (não muta o original).
export function createAdaptiveBinaryCanvas(srcCanvas, thresholdPct = 0.14){
  const w = srcCanvas.width, h = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const srcData = srcCtx.getImageData(0, 0, w, h).data;

  const gray = new Uint8Array(w * h);
  const integral = new Float64Array((w + 1) * (h + 1));
  const stride = w + 1;

  for (let y = 0; y < h; y++){
    let rowSum = 0;
    const rowOff = y * w;
    const intRow = (y + 1) * stride;
    const prevIntRow = y * stride;
    for (let x = 0; x < w; x++){
      const idx = (rowOff + x) * 4;
      const g = Math.round(0.299 * srcData[idx] + 0.587 * srcData[idx + 1] + 0.114 * srcData[idx + 2]);
      gray[rowOff + x] = g;
      rowSum += g;
      integral[intRow + x + 1] = integral[prevIntRow + x + 1] + rowSum;
    }
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  const outImg = outCtx.createImageData(w, h);
  const outData = outImg.data;

  const radius = Math.max(8, Math.min(32, Math.floor(Math.min(w, h) / 32)));
  const factor = 1 - thresholdPct;

  for (let y = 0; y < h; y++){
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(h - 1, y + radius);
    const rowOff = y * w;
    for (let x = 0; x < w; x++){
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(w - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * stride + (x2 + 1)]
        - integral[y1 * stride + (x2 + 1)]
        - integral[(y2 + 1) * stride + x1]
        + integral[y1 * stride + x1];
      const v = (gray[rowOff + x] * count) < (sum * factor) ? 0 : 255;
      const idx = (rowOff + x) * 4;
      outData[idx] = outData[idx + 1] = outData[idx + 2] = v;
      outData[idx + 3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return out;
}

/* ============================================================
   TESSERACT WORKER & AUTO-ROTAÇÃO
   ============================================================ */

// Worker do Tesseract reaproveitado entre chamadas. Configura PSM 6 (bloco único), preserva espaços
// entre colunas de tabela e define DPI explícito (evita fallback ruim de 70 DPI do Tesseract).
let tesseractWorkerPromise = null;
async function getTesseractWorker(){
  if (!tesseractWorkerPromise){
    tesseractWorkerPromise = (async () => {
      const worker = await Tesseract.createWorker('por');
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
        user_defined_dpi: '200',
      });
      return worker;
    })().catch(err => {
      tesseractWorkerPromise = null; // permite tentar de novo se o download inicial falhou por rede
      throw err;
    });
  }
  return tesseractWorkerPromise;
}

function rotateCanvas(srcCanvas, degrees){
  if (degrees === 0) return srcCanvas;
  const rad = degrees * Math.PI / 180;
  const swap = degrees === 90 || degrees === 270;
  const out = document.createElement('canvas');
  out.width = swap ? srcCanvas.height : srcCanvas.width;
  out.height = swap ? srcCanvas.width : srcCanvas.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
  return out;
}

// Vocabulário que cobre TODOS os tipos em DOCUMENT_TYPES — permite saída antecipada na rotação correta.
const OCR_KEYWORDS = [
  "PROTOCOLO","TERMO","CONDOMINIO","RESERVA","VISTORIA","BOLETO","TAXA","DESCRICAO","ENVIADO","RECEBIDO",
  "SALAO","FESTA","ENTREGA","PROPRIETARIOS","INQUILINOS",
  "EQUATORIAL","CLARO","EMPRESAS","ALGAS","GAS NATURAL","AMBIENTAL","AGUA","ESGOTO",
  "PAGAMENTO","PIX","REALIZADO","GERENCIADOR","SAC CAIXA","OUVIDORIA","EXTRATO","APLICACAO","CAPTACAO",
  "DEPOSITO","ASSOCIADO","PERIODO","DEBITO AUTOMATICO","CONSUMO","LINHA DIGITAVEL",
  "CARTORIO","RECIBO","PAGADOR","BENEFICIARIO","UNIDADE","VENCIMENTO",
  "DECLARACAO","DECLARO","QUITACAO","NADA CONSTA","IDENTIFICADOR","ADMINISTRADORA",
  "DARF","ARRECADACAO","FGTS","TRABALHISTAS","CDB","INFORMATIVO","TOMADOR","SALARIO","FUNCIONARIO","DESPESAS"
];

function ocrLooksGood(text, confidence){
  if (!text || text.trim().length < 15) return false;
  if (confidence < 40) return false;
  const norm = normalize(text);
  return OCR_KEYWORDS.some(k => norm.includes(k));
}

function ocrQualityScore(text, confidence){
  const norm = normalize(text || '');
  let bonus = 0;
  for (const k of OCR_KEYWORDS) if (norm.includes(k)) bonus += 12;
  if (/\d{1,2}\D\d{1,2}\D\d{2,4}/.test(norm)) bonus += 15;
  return (confidence || 0) + bonus;
}

// Ordem de rotação otimizada: 0° (normal), 90°/270° (celular deitado), 180° (ponta-cabeça, mais raro).
const ROTATION_ORDER = [0, 90, 270, 180];

async function ocrWithAutoRotate(canvas0){
  const worker = await getTesseractWorker();
  let best = null;
  for (const degrees of ROTATION_ORDER){
    const canvas = rotateCanvas(canvas0, degrees);
    const { data } = await worker.recognize(canvas);
    const confidence = data.confidence || 0;
    const text = data.text || '';
    if (canvas !== canvas0) releaseCanvas(canvas);
    const score = ocrQualityScore(text, confidence);
    if (!best || score > best.score) best = { text, confidence, degrees, score };
    if (ocrLooksGood(text, confidence)) break;
  }

  // Se o melhor resultado ainda ficou fraco (ex.: foto com sombra forte ou papel escuro),
  // tenta binarização adaptativa Bradley-Roth no melhor ângulo encontrado — custo baixo (~1 reconhecimento).
  if (best && (best.confidence < 58 || !ocrLooksGood(best.text, best.confidence))){
    const rotatedBest = rotateCanvas(canvas0, best.degrees);
    const binaryCanvas = createAdaptiveBinaryCanvas(rotatedBest);
    if (rotatedBest !== canvas0) releaseCanvas(rotatedBest);
    try {
      const { data } = await worker.recognize(binaryCanvas);
      const confidence = data.confidence || 0;
      const text = data.text || '';
      const score = ocrQualityScore(text, confidence);
      if (score > best.score){
        best = { text, confidence, degrees: best.degrees, score, adaptive: true };
      }
    } finally {
      releaseCanvas(binaryCanvas);
    }
  }

  return best;
}

// Executa OCR diretamente sobre um canvas já renderizado (evita reabrir/re-renderizar o PDF no fallback da IA).
export async function ocrFromCanvas(canvas, { alreadyPreprocessed = false } = {}){
  if (!alreadyPreprocessed) preprocessCanvasForOCR(canvas);
  const best = await ocrWithAutoRotate(canvas);
  return {
    text: best ? best.text : '',
    ocrConfidence: best ? (best.confidence || 0) / 100 : 0,
    usedOCR: true,
    rotationUsed: best ? best.degrees : 0,
  };
}

export async function extractPdfText(file){
  const pdf = await openPdfDocument(file);
  try {
    const text = await extractNativeTextFromPdf(pdf, 3);
    if (text.trim().length >= MIN_TEXT_LEN_TO_SKIP_OCR){
      return { text, ocrConfidence: null, usedOCR: false };
    }

    const page1 = await pdf.getPage(1);
    const canvas = await renderPageToCanvas(page1, 2.5);
    try {
      return await ocrFromCanvas(canvas, { alreadyPreprocessed: false });
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    await pdf.destroy();
  }
}

/* ============================================================
   REVISÃO PROFUNDA LOCAL (sob demanda, só para baixa confiança)
   ============================================================ */

const REVIEW_PSM_MODES = ['6', '4', '3']; // 6=bloco único, 4=coluna única, 3=automático

async function ocrDeepReview(canvasGray){
  const worker = await getTesseractWorker();
  const canvasBinary = createAdaptiveBinaryCanvas(canvasGray);
  let best = null;

  try {
    // Primeiro testa todos os PSMs e rotações no canvas em tons de cinza (alta fidelidade).
    for (const psm of REVIEW_PSM_MODES){
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      for (const degrees of ROTATION_ORDER){
        const canvas = rotateCanvas(canvasGray, degrees);
        const { data } = await worker.recognize(canvas);
        const confidence = data.confidence || 0;
        const text = data.text || '';
        if (canvas !== canvasGray) releaseCanvas(canvas);
        const score = ocrQualityScore(text, confidence);
        if (!best || score > best.score) best = { text, confidence, degrees, psm, score };
      }
    }

    // Depois testa a versão binarizada adaptativa no melhor ângulo (e em 0° se for diferente), nos 3 PSMs.
    const anglesToTry = best && best.degrees !== 0 ? [best.degrees, 0] : [0];
    for (const degrees of anglesToTry){
      const canvas = rotateCanvas(canvasBinary, degrees);
      try {
        for (const psm of REVIEW_PSM_MODES){
          await worker.setParameters({ tessedit_pageseg_mode: psm });
          const { data } = await worker.recognize(canvas);
          const confidence = data.confidence || 0;
          const text = data.text || '';
          const score = ocrQualityScore(text, confidence);
          if (!best || score > best.score) best = { text, confidence, degrees, psm, score, adaptive: true };
        }
      } finally {
        if (canvas !== canvasBinary) releaseCanvas(canvas);
      }
    }
  } finally {
    releaseCanvas(canvasBinary);
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
  }

  return best;
}

// Revisão profunda puramente local para UM documento (alta resolução 3.5x, múltiplos PSMs,
// binarização adaptativa e, se a pág. 1 continuar sem nome, tenta pág. 2 caso exista).
export async function ocrDeepReviewDocument(file){
  const pdf = await openPdfDocument(file);
  try {
    const page1 = await pdf.getPage(1);
    const canvas1 = await renderPageToCanvas(page1, 3.5);
    let best;
    try {
      preprocessCanvasForOCR(canvas1);
      best = await ocrDeepReview(canvas1);
    } finally {
      releaseCanvas(canvas1);
    }

    if (!best) return null;
    let combinedText = best.text;
    let ocrConfidence = (best.confidence || 0) / 100;
    let result = identifyDocument(combinedText, ocrConfidence);

    // Se a página 1 não resolveu (ex.: folha de rosto ou anexo) e existe página 2, tenta OCR rápido na pág. 2.
    if ((!result.nome || !result.fields?.condominio) && pdf.numPages >= 2){
      const page2 = await pdf.getPage(2);
      const canvas2 = await renderPageToCanvas(page2, 2.5);
      try {
        const res2 = await ocrFromCanvas(canvas2, { alreadyPreprocessed: false });
        if (res2.text && res2.text.trim().length > 15){
          const merged = `${combinedText}\n${res2.text}`;
          const mergedConf = Math.max(ocrConfidence, res2.ocrConfidence || 0);
          const mergedResult = identifyDocument(merged, mergedConf);
          if (mergedResult.confidence > result.confidence){
            combinedText = merged;
            ocrConfidence = mergedConf;
            result = mergedResult;
          }
        }
      } finally {
        releaseCanvas(canvas2);
      }
    }

    return {
      text: combinedText,
      ocrConfidence,
      rotationUsed: best.degrees,
      psmUsed: best.psm,
      result,
    };
  } finally {
    await pdf.destroy();
  }
}
