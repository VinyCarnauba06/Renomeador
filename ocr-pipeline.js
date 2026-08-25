// ocr-pipeline.js
// Tier 3: leitura de PDF via texto nativo -> OCR local (Tesseract), com correção automática de rotação, e
// revisão profunda sob demanda. É o fallback de último recurso quando a rede/IA não está disponível — ver
// identifyDocumentSmart() em ai-extraction.js, que tenta a IA antes de cair aqui.
//
// Import circular com ai-extraction.js: reviewDocument() (abaixo) tenta a IA de novo antes do OCR profundo
// local, então importa extractWithAI de lá; ai-extraction.js importa renderPageToCanvas/extractPdfText
// daqui pro caminho normal e pro fallback final. Seguro pelo mesmo motivo do ciclo config.js/rules-engine.js:
// as chamadas cruzadas só acontecem dentro de corpos de função assíncrona, nunca na avaliação do módulo.
import { normalize, identifyDocument } from './rules-engine.js';
import { extractWithAI } from './ai-extraction.js';
import { MIN_TEXT_LEN_TO_SKIP_OCR } from './config.js';

// Configuração global do worker do PDF.js — precisa rodar uma única vez antes de qualquer render/getDocument.
// Fica aqui por ser o módulo "dono" da leitura de PDF, mesmo sendo consumida também por ai-extraction.js.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ============================================================
   LEITURA DE PDF: TEXTO NATIVO -> OCR (fallback, com correção de rotação)
   ============================================================
   Os documentos reais analisados eram todos PDFs só-imagem (sem texto
   pesquisável) e vários vinham com o conteúdo rotacionado 90° (comum em
   digitalizações feitas com o celular deitado). Por isso: se o primeiro
   OCR (0°) sair curto ou pouco confiável, tenta 90/180/270° e fica com
   o melhor resultado.
*/

export async function renderPageToCanvas(page, scale){
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// Digitalizações feitas com celular costumam sair com contraste ruim (sombra, papel amarelado, luz desigual).
// Aqui: converte pra escala de cinza e "estica" o contraste (o pixel mais escuro vira preto, o mais claro vira
// branco), o que costuma melhorar bastante a precisão do OCR em texto pequeno sem destruir assinaturas/rasuras
// (não é uma binarização dura — mantém tons de cinza).
function preprocessCanvasForOCR(canvas){
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++){
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(max - min, 1);
  for (let i = 0, p = 0; i < d.length; i += 4, p++){
    const v = Math.round((gray[p] - min) / range * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// Worker do Tesseract reaproveitado entre todas as chamadas (evita recarregar o modelo de idioma a cada
// rotação/arquivo) e configurado para PSM 6 ("bloco único de texto"), que costuma funcionar melhor que o
// modo automático em tabelas com linhas/colunas — o padrão predominante nos documentos deste fluxo.
let tesseractWorkerPromise = null;
async function getTesseractWorker(){
  if (!tesseractWorkerPromise){
    tesseractWorkerPromise = (async () => {
      const worker = await Tesseract.createWorker('por');
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      return worker;
    })();
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
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
  return out;
}

// Lista de palavras que, se aparecerem no OCR, indicam que a rotação atual já está correta (o texto faz
// sentido, não é ruído). Precisa cobrir o vocabulário de TODOS os tipos em DOCUMENT_TYPES — se um tipo
// novo for adicionado e nenhuma palavra dele estiver aqui, ocrWithAutoRotate deixa de conseguir "sair
// cedo" nesse tipo de documento e passa a testar as 4 rotações sempre, o que deixa o OCR bem mais lento
// sem necessidade (a maioria dos documentos já vem na orientação certa).
const OCR_KEYWORDS = [
  "PROTOCOLO","TERMO","CONDOMINIO","RESERVA","VISTORIA","BOLETO","TAXA","DESCRICAO","ENVIADO","RECEBIDO",
  "SALAO","FESTA","ENTREGA","PROPRIETARIOS","INQUILINOS",
  "EQUATORIAL","CLARO","EMPRESAS","PAGAMENTO","PIX","REALIZADO","GERENCIADOR","EXTRATO","APLICACAO",
  "DEPOSITO","ASSOCIADO","PERIODO","CARTORIO","RECIBO","PAGADOR","BENEFICIARIO","UNIDADE","VENCIMENTO",
  "DECLARACAO","DECLARO","QUITACAO","NADA CONSTA","IDENTIFICADOR","ADMINISTRADORA"
];

function ocrLooksGood(text, confidence){
  if (!text || text.trim().length < 15) return false;
  if (confidence < 40) return false;
  const norm = normalize(text);
  // se reconhecer qualquer palavra-chave de negócio, já é sinal forte de que a rotação está correta
  return OCR_KEYWORDS.some(k => norm.includes(k));
}

// A confiança bruta do Tesseract mede "quão certo ele está de cada caractere", não se o texto faz sentido.
// Uma rotação errada pode gerar letras nítidas porém sem nexo e "ganhar" na confiança pura. Por isso a
// escolha da melhor rotação usa confiança + um bônus por reconhecer palavras-chave de negócio e datas —
// isso pesa a favor da leitura que realmente faz sentido, não só da mais "nítida".
function ocrQualityScore(text, confidence){
  const norm = normalize(text || '');
  let bonus = 0;
  for (const k of OCR_KEYWORDS) if (norm.includes(k)) bonus += 12;
  if (/\d{1,2}\D\d{1,2}\D\d{2,4}/.test(norm)) bonus += 15;
  return (confidence || 0) + bonus;
}

async function ocrWithAutoRotate(canvas0){
  const worker = await getTesseractWorker();
  let best = null;
  for (const degrees of [0, 90, 180, 270]){
    const canvas = rotateCanvas(canvas0, degrees);
    const { data } = await worker.recognize(canvas);
    const confidence = data.confidence || 0;
    const text = data.text || '';
    if (canvas !== canvas0) canvas.remove();
    const score = ocrQualityScore(text, confidence);
    if (!best || score > best.score) best = { text, confidence, degrees, score };
    if (ocrLooksGood(text, confidence)) break; // já achou uma rotação boa, não precisa testar as outras
  }
  return best;
}

// Renderiza a 1ª página do PDF já com o contraste reforçado — usado tanto na leitura normal quanto na revisão.
async function renderPreprocessedPage(file, scale){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const canvas = await renderPageToCanvas(page, scale);
  preprocessCanvasForOCR(canvas);
  return canvas;
}

export async function extractPdfText(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  const maxPages = Math.min(pdf.numPages, 3); // primeiras páginas costumam ter os dados relevantes
  for (let i = 1; i <= maxPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }

  if (text.trim().length >= MIN_TEXT_LEN_TO_SKIP_OCR){
    return { text, ocrConfidence: null, usedOCR: false };
  }

  // fallback: OCR na primeira página, com contraste reforçado e testando rotações se necessário.
  // Escala 2.5 (~180 DPI efetivo) em vez de 3.0 (~216 DPI): ainda acima do que a maioria das digitalizações
  // de celular consegue entregar de detalhe real, mas com ~30% menos pixels pro Tesseract processar — ganho
  // de velocidade sem perda perceptível de precisão. Documentos que ficarem com baixa confiança continuam
  // podendo ser reprocessados em resolução maior (3.5) pelo botão "revisar baixa confiança".
  const canvas = await renderPreprocessedPage(file, 2.5);
  const best = await ocrWithAutoRotate(canvas);
  canvas.remove();
  return { text: best.text, ocrConfidence: (best.confidence || 0) / 100, usedOCR: true, rotationUsed: best.degrees };
}

/* ============================================================
   REVISÃO PROFUNDA (sob demanda, só para documentos com confiança baixa)
   ============================================================
   Mais lenta de propósito: além das 4 rotações, testa 3 modos de segmentação
   de página do Tesseract (bloco único, coluna única, automático) — o modo
   ideal varia conforme o layout do documento (tabela vs. texto corrido vs.
   formulário). É custoso demais pra rodar em todo documento por padrão, por
   isso fica atrás do botão "revisar baixa confiança", disparado manualmente.
*/
const REVIEW_PSM_MODES = ['6', '4', '3']; // 6=bloco único, 4=coluna única, 3=automático

async function ocrDeepReview(canvas0){
  const worker = await getTesseractWorker();
  let best = null;
  for (const psm of REVIEW_PSM_MODES){
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    for (const degrees of [0, 90, 180, 270]){
      const canvas = rotateCanvas(canvas0, degrees);
      const { data } = await worker.recognize(canvas);
      const confidence = data.confidence || 0;
      const text = data.text || '';
      if (canvas !== canvas0) canvas.remove();
      const score = ocrQualityScore(text, confidence);
      if (!best || score > best.score) best = { text, confidence, degrees, psm, score };
    }
  }
  await worker.setParameters({ tessedit_pageseg_mode: '6' }); // restaura o padrão usado no fluxo normal
  return best;
}

// Roda a revisão profunda para UM documento e devolve o resultado atualizado (ou null se não deu pra melhorar).
export async function reviewDocument(row){
  if (!row.usedOCR && !row.usedAI){
    // Texto nativo (não veio de OCR nem de IA) — o texto já é o que é; revisar de novo não muda nada.
    // O que falta aqui é vocabulário (condomínio/tipo não reconhecido), não qualidade de leitura.
    return null;
  }

  // Primeiro tenta de novo via IA, em resolução maior e avisando que é um caso difícil (o modelo tende a
  // prestar mais atenção em rotação/campos ambíguos com essa dica). Só cai pro OCR profundo local se a IA
  // falhar (sem chave configurada, rede fora, backend indisponível).
  try {
    const canvasAI = await renderPreprocessedPage(row.originalFile, 3.5);
    const ai = await extractWithAI(canvasAI, { hint: 'baixa_confianca_revisar_com_cuidado_inclusive_rotacao_e_condominio' });
    canvasAI.remove();
    if (ai && ai.nome_sugerido){
      const ocrConfidence = typeof ai.confidence === 'number' ? ai.confidence : 0.85;
      const result = {
        nome: ai.nome_sugerido,
        confidence: ocrConfidence,
        ruleId: 'ai:' + (ai.tipo_documento || 'desconhecido'),
        fields: {
          condominio: ai.condominio || undefined,
          data: ai.data || undefined,
          unidade: ai.unidade || undefined,
          categoria: ai.categoria || undefined,
        },
      };
      return { text: row.ocrText, ocrConfidence, result };
    }
  } catch (err){
    console.warn('Revisão via IA falhou, caindo pro OCR profundo local:', err);
  }

  if (!row.usedOCR) return null; // não veio de OCR local — não há OCR profundo pra tentar como último recurso
  const canvas = await renderPreprocessedPage(row.originalFile, 3.5); // resolução ainda maior na revisão
  const best = await ocrDeepReview(canvas);
  canvas.remove();
  if (!best) return null;
  const ocrConfidence = (best.confidence || 0) / 100;
  const result = identifyDocument(best.text, ocrConfidence);
  return { text: best.text, ocrConfidence, rotationUsed: best.degrees, psmUsed: best.psm, result };
}
