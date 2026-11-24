// ocr-pipeline.js
// Tier 3: leitura de PDF via texto nativo -> OCR local (Tesseract) com pool paralelo de workers,
// pré-processamento calibrado em scans reais (contraste por percentil, limpeza de bordas pretas,
// auto-crop de área útil, nitidez leve, binarização adaptativa Bradley-Roth), rotação adaptativa
// (lembra a última rotação vencedora do lote), leitura focada no cabeçalho (top 40%) e auto-deskew na revisão profunda.
import { normalize, identifyDocument } from './rules-engine.js';
import { MIN_TEXT_LEN_TO_SKIP_OCR } from './config.js';
import { openPdfDocument, extractNativeTextFromPdf, renderPageToCanvas, releaseCanvas } from './pdf-utils.js';

/* ============================================================
   PRÉ-PROCESSAMENTO DE IMAGEM PARA OCR
   ============================================================ */

// Converte para tons de cinza, estica contraste por percentis (2%–98%), limpa bordas pretas de scanner
// e aplica um unsharp mask 3x3 leve para realçar fontes pequenas.
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
  const stretched = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p++){
    let norm = (gray[p] - low) / range;
    if (norm < 0) norm = 0;
    else if (norm > 1) norm = 1;
    stretched[p] = Math.round(norm * 255);
  }

  // Limpa faixas pretas de tampa de scanner encostadas nas 4 bordas (até 2,5% de cada lado)
  const borderX = Math.max(4, Math.floor(w * 0.025));
  const borderY = Math.max(4, Math.floor(h * 0.025));
  for (let y = 0; y < h; y++){
    const row = y * w;
    for (let x = 0; x < borderX; x++){
      if (stretched[row + x] < 90) stretched[row + x] = 255;
      if (stretched[row + (w - 1 - x)] < 90) stretched[row + (w - 1 - x)] = 255;
    }
  }
  for (let y = 0; y < borderY; y++){
    const topRow = y * w;
    const botRow = (h - 1 - y) * w;
    for (let x = 0; x < w; x++){
      if (stretched[topRow + x] < 90) stretched[topRow + x] = 255;
      if (stretched[botRow + x] < 90) stretched[botRow + x] = 255;
    }
  }

  // Unsharp mask 3x3 leve (peso 0.35): realça bordas de letras pequenas sem explodir ruído
  for (let y = 1; y < h - 1; y++){
    const row = y * w;
    for (let x = 1; x < w - 1; x++){
      const p = row + x;
      const blur = (
        stretched[p - w - 1] + stretched[p - w] + stretched[p - w + 1] +
        stretched[p - 1]     + stretched[p]     + stretched[p + 1] +
        stretched[p + w - 1] + stretched[p + w] + stretched[p + w + 1]
      ) / 9;
      let sharp = stretched[p] + 0.35 * (stretched[p] - blur);
      if (sharp < 0) sharp = 0;
      else if (sharp > 255) sharp = 255;
      const v = Math.round(sharp);
      const idx = p * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = v;
    }
  }
  // Copia bordas de 1px sem alterar
  for (let x = 0; x < w; x++){
    const vTop = stretched[x];
    const vBot = stretched[(h - 1) * w + x];
    const iTop = x * 4;
    const iBot = ((h - 1) * w + x) * 4;
    d[iTop] = d[iTop + 1] = d[iTop + 2] = vTop;
    d[iBot] = d[iBot + 1] = d[iBot + 2] = vBot;
  }
  for (let y = 0; y < h; y++){
    const vL = stretched[y * w];
    const vR = stretched[y * w + w - 1];
    const iL = (y * w) * 4;
    const iR = (y * w + w - 1) * 4;
    d[iL] = d[iL + 1] = d[iL + 2] = vL;
    d[iR] = d[iR + 1] = d[iR + 2] = vR;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// Recorta grandes áreas totalmente brancas ao redor do documento (muito comum em protocolos de entrega,
// onde 40–55% da folha é espaço vazio). Reduz pixels pro Tesseract sem perder nada de conteúdo.
function cropContentArea(srcCanvas){
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;

  // Varredura rápida com passo de 4px pra achar bounding box dos pixels escuros (< 220)
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y += 4){
    const rowOff = y * w;
    for (let x = 0; x < w; x += 4){
      if (d[(rowOff + x) * 4] < 220){
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return srcCanvas;

  const pad = 24;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const cw = Math.min(w - x0, (maxX - minX) + pad * 2);
  const ch = Math.min(h - y0, (maxY - minY) + pad * 2);

  // Só recorta se economizar pelo menos 15% da área e mantiver tamanho mínimo razoável
  if (cw < 200 || ch < 200 || (cw * ch) > (w * h * 0.85)) return srcCanvas;

  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, cw, ch);
  outCtx.drawImage(srcCanvas, x0, y0, cw, ch, 0, 0, cw, ch);
  return out;
}

// Recorta os 42% superiores da página (cabeçalho) — evita que QR codes, códigos de barras e tabelas
// de consumo na parte inferior confundam a segmentação do Tesseract em faturas e boletos.
function cropTopHeader(srcCanvas, ratio = 0.42){
  const w = srcCanvas.width;
  const ch = Math.max(160, Math.round(srcCanvas.height * ratio));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = ch;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, ch);
  ctx.drawImage(srcCanvas, 0, 0, w, ch, 0, 0, w, ch);
  return out;
}

// Binarização adaptativa de Bradley-Roth usando Integral Image (O(W*H), ~15ms em 2000x2800).
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

// Estima inclinação leve (-5° a +5°) via variância do perfil de projeção horizontal numa versão reduzida.
// Quanto mais alinhadas as linhas de texto, maiores os picos (linhas de texto) e vales (espaço entre linhas).
function estimateSkewAngle(srcCanvas){
  const scale = Math.min(1, 500 / Math.max(srcCanvas.width, srcCanvas.height));
  const sw = Math.max(60, Math.round(srcCanvas.width * scale));
  const sh = Math.max(60, Math.round(srcCanvas.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });

  let bestAngle = 0;
  let bestScore = -1;
  try {
    for (let deg = -5; deg <= 5; deg += 1){
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, sw, sh);
      tctx.save();
      tctx.translate(sw / 2, sh / 2);
      tctx.rotate(deg * Math.PI / 180);
      tctx.drawImage(srcCanvas, -sw / 2, -sh / 2, sw, sh);
      tctx.restore();

      const data = tctx.getImageData(0, 0, sw, sh).data;
      let score = 0;
      for (let y = 0; y < sh; y++){
        let dark = 0;
        const rowOff = y * sw;
        for (let x = 0; x < sw; x += 2){
          if (data[(rowOff + x) * 4] < 160) dark++;
        }
        score += dark * dark;
      }
      if (score > bestScore){
        bestScore = score;
        bestAngle = deg;
      }
    }
  } finally {
    releaseCanvas(tmp);
  }
  return bestAngle;
}

function deskewCanvas(srcCanvas){
  const angle = estimateSkewAngle(srcCanvas);
  if (angle === 0) return srcCanvas;
  const out = document.createElement('canvas');
  out.width = srcCanvas.width;
  out.height = srcCanvas.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(angle * Math.PI / 180);
  ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
  return out;
}

/* ============================================================
   TESSERACT POOL DE WORKERS (SCHEDULER) & AUTO-ROTAÇÃO ADAPTATIVA
   ============================================================ */

export function getOcrConcurrency(){
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(4, Math.floor(cores / 2) || 2));
}

let tesseractSchedulerPromise = null;
async function getTesseractScheduler(){
  if (!tesseractSchedulerPromise){
    tesseractSchedulerPromise = (async () => {
      const scheduler = Tesseract.createScheduler();
      const count = getOcrConcurrency();
      const workers = await Promise.all(
        Array.from({ length: count }, async () => {
          const worker = await Tesseract.createWorker('por');
          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            preserve_interword_spaces: '1',
            user_defined_dpi: '200',
          });
          return worker;
        })
      );
      for (const w of workers) scheduler.addWorker(w);
      return scheduler;
    })().catch(err => {
      tesseractSchedulerPromise = null;
      throw err;
    });
  }
  return tesseractSchedulerPromise;
}

// Worker dedicado para revisão profunda (alterna PSM 6/4/3 sem race condition no pool principal).
let deepReviewWorkerPromise = null;
async function getDeepReviewWorker(){
  if (!deepReviewWorkerPromise){
    deepReviewWorkerPromise = (async () => {
      const worker = await Tesseract.createWorker('por');
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
        user_defined_dpi: '200',
      });
      return worker;
    })().catch(err => {
      deepReviewWorkerPromise = null;
      throw err;
    });
  }
  return deepReviewWorkerPromise;
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

// Vocabulário que cobre TODOS os tipos em DOCUMENT_TYPES (incluindo protocolos de continuação e Condomínio21).
const OCR_KEYWORDS = [
  "PROTOCOLO","TERMO","CONDOMINIO","RESERVA","VISTORIA","BOLETO","TAXA","DESCRICAO","ENVIADO","RECEBIDO",
  "SALAO","FESTA","ENTREGA","PROPRIETARIOS","PROPRIETARIO","INQUILINOS","LOCATARIO","PRO-LAR",
  "COMUNICADO SALAO","TAXA DE CONSUMO","TAXA EXTRA","BOLETO MULTA",
  "EQUATORIAL","CLARO","EMPRESAS","ALGAS","GAS NATURAL","AMBIENTAL","AGUA","ESGOTO",
  "PAGAMENTO","PIX","REALIZADO","GERENCIADOR","SAC CAIXA","OUVIDORIA","EXTRATO","APLICACAO","CAPTACAO",
  "DEPOSITO","ASSOCIADO","PERIODO","DEBITO AUTOMATICO","CONSUMO","LINHA DIGITAVEL",
  "CARTORIO","RECIBO","PAGADOR","BENEFICIARIO","UNIDADE","VENCIMENTO",
  "DECLARACAO","DECLARO","QUITACAO","NADA CONSTA","IDENTIFICADOR","ADMINISTRADORA",
  "DARF","ARRECADACAO","FGTS","TRABALHISTAS","CDB","INFORMATIVO","TOMADOR","SALARIO","FUNCIONARIO","DESPESAS"
];

function ocrLooksGood(text, confidence){
  if (!text || text.trim().length < 15) return false;
  const norm = normalize(text);
  let hits = 0;
  for (const k of OCR_KEYWORDS){
    if (norm.includes(k)){
      hits++;
      if (hits >= 2 && confidence >= 35) return true;
    }
  }
  return hits >= 1 && confidence >= 55;
}

function ocrQualityScore(text, confidence){
  const norm = normalize(text || '');
  let bonus = 0;
  for (const k of OCR_KEYWORDS) if (norm.includes(k)) bonus += 12;
  if (/\d{1,2}\D\d{1,2}\D\d{2,4}/.test(norm)) bonus += 15;
  return (confidence || 0) + bonus;
}

// Ordem de rotação adaptativa: em lotes de scanner de mesa, quase todos os PDFs vêm na mesma orientação
// (ex.: 270° em protocolos de entrega em paisagem). Testar a última rotação vencedora PRIMEIRO corta
// até 2 de cada 3 chamadas de OCR no lote inteiro!
const DEFAULT_ROTATION_ORDER = [0, 270, 90, 180];
let lastSuccessfulRotation = 0;

function getAdaptiveRotationOrder(){
  const order = [lastSuccessfulRotation];
  for (const deg of DEFAULT_ROTATION_ORDER){
    if (!order.includes(deg)) order.push(deg);
  }
  return order;
}

async function ocrWithAutoRotate(canvas0){
  const scheduler = await getTesseractScheduler();
  const cropped = cropContentArea(canvas0);
  const workCanvas = cropped;
  let best = null;

  try {
    for (const degrees of getAdaptiveRotationOrder()){
      const canvas = rotateCanvas(workCanvas, degrees);
      const { data } = await scheduler.addJob('recognize', canvas);
      const confidence = data.confidence || 0;
      const text = data.text || '';
      if (canvas !== workCanvas) releaseCanvas(canvas);
      const score = ocrQualityScore(text, confidence);
      if (!best || score > best.score) best = { text, confidence, degrees, score };
      if (ocrLooksGood(text, confidence)){
        lastSuccessfulRotation = degrees;
        break;
      }
    }

    // Se o melhor resultado ainda ficou com confiança muito baixa (< 45), tenta binarização adaptativa
    // no melhor ângulo encontrado.
    if (best && best.confidence < 45){
      const rotatedBest = rotateCanvas(workCanvas, best.degrees);
      const binaryCanvas = createAdaptiveBinaryCanvas(rotatedBest);
      if (rotatedBest !== workCanvas) releaseCanvas(rotatedBest);
      try {
        const { data } = await scheduler.addJob('recognize', binaryCanvas);
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

    // Se a leitura da página inteira não reconheceu nenhuma palavra-chave forte (ex.: fatura/boleto
    // onde QR code/código de barras no rodapé bagunçou a segmentação), faz uma passada rápida só no
    // cabeçalho (top 42%) no melhor ângulo e concatena o texto limpo ao resultado.
    if (best && !ocrLooksGood(best.text, best.confidence)){
      const rotatedBest = rotateCanvas(workCanvas, best.degrees);
      const headerCanvas = cropTopHeader(rotatedBest, 0.42);
      if (rotatedBest !== workCanvas) releaseCanvas(rotatedBest);
      try {
        const { data } = await scheduler.addJob('recognize', headerCanvas);
        const hText = (data.text || '').trim();
        const hConf = data.confidence || 0;
        if (hText.length >= 10){
          const combinedText = `${hText}\n${best.text}`;
          const combinedConf = Math.max(best.confidence, hConf);
          const combinedScore = ocrQualityScore(combinedText, combinedConf);
          if (combinedScore > best.score){
            best = { text: combinedText, confidence: combinedConf, degrees: best.degrees, score: combinedScore };
          }
        }
      } finally {
        releaseCanvas(headerCanvas);
      }
    }

    if (best && ocrLooksGood(best.text, best.confidence)){
      lastSuccessfulRotation = best.degrees;
    }
    return best;
  } finally {
    if (cropped !== canvas0) releaseCanvas(cropped);
  }
}

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
    const canvas = await renderPageToCanvas(page1, 2.0);
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

const REVIEW_PSM_MODES = ['6', '4', '3'];

async function ocrDeepReview(canvasGray){
  const worker = await getDeepReviewWorker();
  const cropped = cropContentArea(canvasGray);
  const deskewed = deskewCanvas(cropped);
  const canvasBinary = createAdaptiveBinaryCanvas(deskewed);
  let best = null;

  try {
    for (const psm of REVIEW_PSM_MODES){
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      for (const degrees of getAdaptiveRotationOrder()){
        const canvas = rotateCanvas(deskewed, degrees);
        const { data } = await worker.recognize(canvas);
        const confidence = data.confidence || 0;
        const text = data.text || '';
        if (canvas !== deskewed) releaseCanvas(canvas);
        const score = ocrQualityScore(text, confidence);
        if (!best || score > best.score) best = { text, confidence, degrees, psm, score };
      }
    }

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
    if (deskewed !== cropped) releaseCanvas(deskewed);
    if (cropped !== canvasGray) releaseCanvas(cropped);
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
  }

  return best;
}

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

    if ((!result.nome || !result.fields?.condominio) && pdf.numPages >= 2){
      const page2 = await pdf.getPage(2);
      const canvas2 = await renderPageToCanvas(page2, 2.0);
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
