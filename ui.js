// ui.js
// Orquestração de DOM: upload com concorrência controlada, tabela com edição inline em qualquer linha,
// filtros/busca, preview embutido de PDF, configuração de IA sem prompt() surpresa, aprendizado de
// condomínios e exportação ZIP/individual. Sem import circular com pdf-merge.js (estado vive em state.js).
import { CONFIDENCE_THRESHOLD } from './config.js';
import {
  identifyDocument,
  aprenderCondominio,
  todosCondominios,
  findCondominioFallback,
  learnedCondominios,
  saveLearnedCondominios,
  setLoteHintProvider,
  resolveZipMonthFolder,
} from './rules-engine.js';
import {
  identifyDocumentSmart,
  reviewDocumentSmart,
  getAiSecret,
  setAiSecret,
  getAiEndpoint,
  setAiEndpoint,
  isAiEnabled,
  setAiEnabled,
  isAiReady,
} from './ai-extraction.js';
import { getOcrConcurrency } from './ocr-pipeline.js';
import {
  items,
  mergeQueueIds,
  reserveUniqueName,
  releaseName,
  replaceReservedName,
  removeItemById,
  clearAllState,
} from './state.js';
import { escapeHtml, escapeAttr, stripPdfExt } from './pdf-utils.js';
import { initPdfMerge, toggleMergeSelection, clearMergeQueue, renderMergePanel } from './pdf-merge.js';

const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const loteCondominioSelect = document.getElementById('loteCondominioSelect');
const progressWrap = document.getElementById('progressWrap');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');
const cancelBatchBtn = document.getElementById('cancelBatchBtn');
const filterBar = document.getElementById('filterBar');
const searchInput = document.getElementById('searchInput');
const reprocessFilteredBtn = document.getElementById('reprocessFilteredBtn');
const countAllEl = document.getElementById('countAll');
const countPendingEl = document.getElementById('countPending');
const countLowEl = document.getElementById('countLow');
const countUnidentifiedEl = document.getElementById('countUnidentified');
const countErrorEl = document.getElementById('countError');
const countOkEl = document.getElementById('countOk');
const resultsTable = document.getElementById('resultsTable');
const resultsBody = document.getElementById('resultsBody');
const empty = document.getElementById('empty');
const actionsBar = document.getElementById('actionsBar');
const countEl = document.getElementById('count');
const zipByMonthToggle = document.getElementById('zipByMonthToggle');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const reviewBtn = document.getElementById('reviewBtn');
const learnCount = document.getElementById('learnCount');
const exportLearnBtn = document.getElementById('exportLearnBtn');
const importLearnBtn = document.getElementById('importLearnBtn');
const importLearnInput = document.getElementById('importLearnInput');

// Configuração da IA
const aiConfigBtn = document.getElementById('aiConfigBtn');
const aiConfigPanel = document.getElementById('aiConfigPanel');
const aiEnabledToggle = document.getElementById('aiEnabledToggle');
const aiSecretInput = document.getElementById('aiSecretInput');
const aiEndpointInput = document.getElementById('aiEndpointInput');
const aiSaveBtn = document.getElementById('aiSaveBtn');
const aiClearBtn = document.getElementById('aiClearBtn');
const aiCloseBtn = document.getElementById('aiCloseBtn');

// Modal de preview embutido
const previewModal = document.getElementById('previewModal');
const previewTitle = document.getElementById('previewTitle');
const previewFrame = document.getElementById('previewFrame');
const previewNewTabBtn = document.getElementById('previewNewTabBtn');
const previewCloseBtn = document.getElementById('previewCloseBtn');

setLoteHintProvider(() => loteCondominioSelect && loteCondominioSelect.value);

let activeFilter = 'all';
let currentPreviewUrl = null;
let isBatchRunning = false;
let cancelRequested = false;
let batchStartTime = 0;
let wakeLockSentinel = null;
let cloudSyncActive = false;

function getCondominiosEndpoint(){
  const extractUrl = getAiEndpoint();
  return extractUrl.replace(/\/extract\/?$/i, '/condominios');
}

function mergeCondominiosLocais(remoteItems){
  if (!Array.isArray(remoteItems)) return 0;
  let mudancas = 0;
  for (const entry of remoteItems){
    if (!entry || typeof entry.nome !== 'string') continue;
    const nome = entry.nome.trim().toUpperCase();
    if (!nome) continue;
    let existente = learnedCondominios.find(c => c.nome === nome);
    if (!existente){
      existente = { nome, aliases: [nome] };
      learnedCondominios.push(existente);
      mudancas++;
    }
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const a of aliases){
      const clean = String(a || '').trim().toUpperCase();
      if (clean && !existente.aliases.includes(clean)){
        existente.aliases.push(clean);
        mudancas++;
      }
    }
  }
  if (mudancas > 0){
    saveLearnedCondominios();
    preencherLoteCondominioSelect();
  }
  return mudancas;
}

async function syncCondominiosFromCloud(){
  const secret = getAiSecret();
  if (!secret) return;
  try {
    const res = await fetch(getCondominiosEndpoint(), {
      method: 'GET',
      headers: { 'x-renomeador-secret': secret },
    });
    if (!res.ok) return;
    const data = await res.json();
    cloudSyncActive = true;
    mergeCondominiosLocais(data.items);
    updateLearnCount();
  } catch { /* offline ou Supabase ainda não configurado — segue com localStorage */ }
}

async function pushCondominiosToCloud(entries){
  const secret = getAiSecret();
  if (!secret || !Array.isArray(entries) || entries.length === 0) return;
  try {
    const res = await fetch(getCondominiosEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-renomeador-secret': secret },
      body: JSON.stringify({ items: entries }),
    });
    if (!res.ok) return;
    const data = await res.json();
    cloudSyncActive = true;
    mergeCondominiosLocais(data.items);
    updateLearnCount();
  } catch { /* fallback localStorage já salvo */ }
}

async function acquireWakeLock(){
  try {
    if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function'){
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    }
  } catch { /* navegador não suporta ou aba não está ativa */ }
}

async function releaseWakeLock(){
  try {
    if (wakeLockSentinel){
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch { wakeLockSentinel = null; }
}

// Yield sem setTimeout: em abas em 2º plano, Chrome/Edge estrangulam setTimeout pra 1s–60s;
// MessageChannel devolve o controle pro event loop sem cair nesse throttle.
function yieldToBrowser(){
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

function formatEta(done, total){
  if (!batchStartTime || done < 3 || done >= total) return '';
  const elapsedMs = Date.now() - batchStartTime;
  const remainingSec = Math.round((elapsedMs / done) * (total - done) / 1000);
  if (remainingSec < 60) return ` · ~${remainingSec}s restantes`;
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;
  return ` · ~${min}m${sec > 0 ? String(sec).padStart(2, '0') + 's' : ''} restantes`;
}

window.addEventListener('beforeunload', e => {
  if (isBatchRunning || items.length > 0){
    e.preventDefault();
    e.returnValue = '';
  }
});

cancelBatchBtn.addEventListener('click', () => {
  cancelRequested = true;
  cancelBatchBtn.disabled = true;
  cancelBatchBtn.textContent = 'PARANDO...';
});

initPdfMerge({
  onMerged: novaLinha => {
    renderRow(novaLinha);
    reorderTable();
    applyFilters();
    updateCount();
  },
});

/* ============================================================
   CONFIGURAÇÃO DA IA NA INTERFACE
   ============================================================ */

function updateAiStatusButton(){
  const ready = isAiReady();
  const hasSecret = Boolean(getAiSecret());
  aiConfigBtn.classList.toggle('active', ready);
  aiConfigBtn.classList.toggle('off', !ready);
  if (ready){
    aiConfigBtn.textContent = '⚙ IA: ativa';
  } else if (hasSecret){
    aiConfigBtn.textContent = '⚙ IA: pausada';
  } else {
    aiConfigBtn.textContent = '⚙ IA: configurar';
  }
}

function openAiConfigPanel(){
  aiEnabledToggle.checked = isAiEnabled();
  aiSecretInput.value = getAiSecret() || '';
  aiEndpointInput.value = getAiEndpoint();
  aiConfigPanel.style.display = 'block';
}

aiConfigBtn.addEventListener('click', () => {
  if (aiConfigPanel.style.display === 'none') openAiConfigPanel();
  else aiConfigPanel.style.display = 'none';
});

aiCloseBtn.addEventListener('click', () => { aiConfigPanel.style.display = 'none'; });

aiSaveBtn.addEventListener('click', () => {
  const secret = aiSecretInput.value.trim();
  const endpoint = aiEndpointInput.value.trim();
  setAiSecret(secret);
  setAiEndpoint(endpoint);
  setAiEnabled(aiEnabledToggle.checked && Boolean(secret));
  updateAiStatusButton();
  aiConfigPanel.style.display = 'none';
  if (secret) syncCondominiosFromCloud();
});

aiClearBtn.addEventListener('click', () => {
  setAiSecret('');
  setAiEnabled(false);
  aiSecretInput.value = '';
  aiEnabledToggle.checked = false;
  updateAiStatusButton();
});

/* ============================================================
   PREVIEW EMBUTIDO DE PDF (sem vazamento de Blob URL)
   ============================================================ */

function closePreview(){
  previewModal.style.display = 'none';
  previewFrame.src = 'about:blank';
  if (currentPreviewUrl){
    URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
  }
}

function openPreview(row){
  if (!row.originalFile) return;
  closePreview();
  currentPreviewUrl = URL.createObjectURL(row.originalFile);
  previewTitle.textContent = row.suggestedName || row.originalName;
  previewFrame.src = currentPreviewUrl;
  previewModal.style.display = 'flex';
}

previewNewTabBtn.addEventListener('click', () => {
  if (currentPreviewUrl) window.open(currentPreviewUrl, '_blank');
});
previewCloseBtn.addEventListener('click', closePreview);
previewModal.addEventListener('click', e => { if (e.target === previewModal) closePreview(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && previewModal.style.display !== 'none') closePreview();
});

/* ============================================================
   UPLOAD & PROCESSAMENTO EM LOTES COM CONCORRÊNCIA CONTROLADA
   ============================================================ */

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('drag');
  handleFiles([...e.dataTransfer.files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')));
});
fileInput.addEventListener('change', e => {
  handleFiles([...e.target.files]);
  fileInput.value = '';
});

const TAMANHO_LOTE_INTERNO = 30;
const AI_CONCURRENCY = 4;

async function processSingleRow(row){
  try {
    const result = await identifyDocumentSmart(row.originalFile);
    row.fields = result.fields;
    row.ruleId = result.ruleId;
    row.usedOCR = result.usedOCR;
    row.usedAI = result.usedAI;
    row.rotationUsed = result.rotationUsed;
    row.ocrText = result.text;
    row.ocrConfidencePct = result.usedOCR ? Math.round((result.confidence || 0) * 100) : null;

    if (result.nome && result.confidence >= CONFIDENCE_THRESHOLD){
      row.suggestedName = reserveUniqueName(result.nome);
      row.confidence = result.confidence;
      row.status = 'ok';
    } else if (result.nome){
      row.suggestedName = reserveUniqueName(result.nome);
      row.confidence = result.confidence;
      row.status = 'low';
    } else {
      row.suggestedName = reserveUniqueName(stripPdfExt(row.originalName));
      row.confidence = 0;
      row.status = 'unidentified';
    }
  } catch (err){
    console.error(err);
    row.status = 'error';
    row.error = err.message || String(err);
    row.suggestedName = reserveUniqueName(stripPdfExt(row.originalName));
  }
}

async function handleFiles(files){
  if (!files.length) return;
  empty.style.display = 'none';
  filterBar.style.display = 'flex';
  resultsTable.style.display = 'table';
  actionsBar.style.display = 'flex';
  progressWrap.style.display = 'block';

  isBatchRunning = true;
  cancelRequested = false;
  batchStartTime = Date.now();
  acquireWakeLock();
  cancelBatchBtn.style.display = 'inline-block';
  cancelBatchBtn.disabled = false;
  cancelBatchBtn.textContent = 'PARAR LOTE';

  let done = 0;
  const total = files.length;
  const totalBlocos = Math.ceil(total / TAMANHO_LOTE_INTERNO);
  updateProgress(done, total, 1, totalBlocos);

  try {
    for (let bloco = 0; bloco < totalBlocos; bloco++){
      if (cancelRequested) break;
      const inicio = bloco * TAMANHO_LOTE_INTERNO;
      const arquivosDoBloco = files.slice(inicio, inicio + TAMANHO_LOTE_INTERNO);

      const rowsDoBloco = arquivosDoBloco.map(file => {
        const id = 'f' + Math.random().toString(36).slice(2);
        const row = {
          id,
          originalFile: file,
          originalName: file.name,
          suggestedName: null,
          confidence: 0,
          fields: {},
          status: 'processing',
          error: null,
        };
        items.push(row);
        renderRow(row);
        return row;
      });

      // Com IA ativa, roda 3 chamadas em paralelo; no OCR local, usa o pool paralelo de workers do Tesseract.
      const concurrency = isAiReady() ? AI_CONCURRENCY : getOcrConcurrency();
      let nextIdx = 0;
      const workers = Array.from({ length: Math.min(concurrency, rowsDoBloco.length) }, async () => {
        while (nextIdx < rowsDoBloco.length && !cancelRequested){
          const current = rowsDoBloco[nextIdx++];
          await processSingleRow(current);
          done++;
          updateProgress(done, total, bloco + 1, totalBlocos);
          renderRow(current);
        }
      });
      await Promise.all(workers);

      // Se cancelou no meio do bloco, remove as linhas que nem chegaram a começar.
      if (cancelRequested){
        for (const r of rowsDoBloco){
          if (r.status === 'processing'){
            removeItemById(r.id);
            const tr = document.getElementById('row-' + r.id);
            if (tr) tr.remove();
          }
        }
        break;
      }

      reorderTable();
      applyFilters();
      if (bloco < totalBlocos - 1){
        await yieldToBrowser();
      }
    }
  } finally {
    isBatchRunning = false;
    batchStartTime = 0;
    releaseWakeLock();
    cancelBatchBtn.style.display = 'none';
  }

  progressLabel.textContent = cancelRequested
    ? `Lote interrompido: ${done} de ${total} documento(s) processado(s).`
    : `Concluído: ${total} documento(s) processado(s).`;
  cancelRequested = false;
  reorderTable();
  applyFilters();
  updateCount();
  updateAiStatusButton();
}

function updateProgress(done, total, bloco, totalBlocos){
  const pct = total ? Math.round((done / total) * 100) : 0;
  const eta = formatEta(done, total);
  progressLabel.textContent = (totalBlocos && totalBlocos > 1)
    ? `Lote ${bloco} de ${totalBlocos} (30 por vez) — ${done} de ${total} (${pct}%)${eta}`
    : `Processando ${done} de ${total} (${pct}%)${eta}`;
  progressFill.style.width = pct + '%';
}

/* ============================================================
   FILTROS E RENDERIZAÇÃO DA TABELA
   ============================================================ */

function rowMatchesFilter(r, query){
  const matchesTab =
    activeFilter === 'all' ||
    (activeFilter === 'pending' && r.status !== 'ok') ||
    r.status === activeFilter;
  if (!matchesTab) return false;
  if (!query) return true;
  return [
    r.originalName,
    r.suggestedName,
    r.fields && r.fields.condominio,
    r.fields && r.fields.tipo,
  ].some(v => v && String(v).toLowerCase().includes(query));
}

function applyFilterToRow(r){
  const tr = document.getElementById('row-' + r.id);
  if (!tr) return;
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
  tr.classList.toggle('hiddenRow', !rowMatchesFilter(r, query));
}

function getFilteredReprocessableRows(){
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
  if (!query && activeFilter === 'all') return [];
  return items.filter(r => r.status !== 'processing' && !r.merged && rowMatchesFilter(r, query));
}

function updateReprocessFilteredBtn(){
  if (!reprocessFilteredBtn) return;
  const targets = getFilteredReprocessableRows();
  if (targets.length > 0 && !isBatchRunning){
    reprocessFilteredBtn.style.display = 'inline-block';
    reprocessFilteredBtn.textContent = `🔄 REPROCESSAR FILTRADOS (${targets.length})`;
  } else {
    reprocessFilteredBtn.style.display = 'none';
  }
}

function applyFilters(){
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
  for (const r of items){
    const tr = document.getElementById('row-' + r.id);
    if (!tr) continue;
    tr.classList.toggle('hiddenRow', !rowMatchesFilter(r, query));
  }
  updateReprocessFilteredBtn();
}

document.querySelectorAll('.filterBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll('.filterBtn').forEach(b => b.classList.toggle('active', b === btn));
    applyFilters();
  });
});

if (searchInput){
  searchInput.addEventListener('input', applyFilters);
}

function fieldsSummary(f){
  if (!f) return '';
  const parts = [];
  if (f.tipo) parts.push(`<b>Tipo:</b> ${escapeHtml(f.tipo)}`);
  if (f.condominio) parts.push(`<b>Condomínio:</b> ${escapeHtml(f.condominio)}`);
  if (f.dataDDMM) parts.push(`<b>Data:</b> ${escapeHtml(f.dataDDMM)}${f.ano ? '.' + escapeHtml(f.ano) : ''}`);
  else if (f.data) parts.push(`<b>Data:</b> ${escapeHtml(f.data)}`);
  else if (f.mesAno) parts.push(`<b>Mês/Ano:</b> ${escapeHtml(f.mesAno)}`);
  else if (f.mes || f.ano) parts.push(`<b>Mês/Ano:</b> ${escapeHtml(f.mes || '?')} ${escapeHtml(f.ano || '')}`);
  else if (f.mesCompleto || f.ano) parts.push(`<b>Mês/Ano:</b> ${escapeHtml(f.mesCompleto || '?')} ${escapeHtml(f.ano || '')}`);
  if (f.unidade) parts.push(`<b>Unidade:</b> ${escapeHtml(f.unidade)}`);
  if (f.categoria) parts.push(`<b>Categoria:</b> ${escapeHtml(f.categoria)}`);
  if (f.ucSuffix) parts.push(`<b>UC:</b> ...${escapeHtml(f.ucSuffix)}`);
  if (f.apartamento) parts.push(`<b>Apto:</b> ${escapeHtml(f.apartamento)}`);
  if (f.numeroProtocolo) parts.push(`<b>Nº Protocolo:</b> ${escapeHtml(f.numeroProtocolo)}`);
  if (f.observacao) parts.push(`<b>Obs.:</b> ${escapeHtml(f.observacao)}`);
  return parts.join('<br>') || '<span style="opacity:.5">nenhum campo reconhecido</span>';
}

function ocrTextDetails(row){
  if (!row.ocrText || !row.ocrText.trim()) return '';
  const preview = row.ocrText.trim().slice(0, 600);
  return `<details class="ocrDetails"><summary>ver texto reconhecido</summary><pre>${escapeHtml(preview)}</pre></details>`;
}

function verArquivoBtn(row){
  if (!row.originalFile) return '';
  return `<button type="button" class="linkBtn verArquivoBtn" data-id="${row.id}">📄 ver</button>`;
}

function baixarUmBtn(row){
  if (!row.originalFile || row.status === 'processing') return '';
  return `<button type="button" class="linkBtn baixarUmBtn" data-id="${row.id}">⬇ baixar</button>`;
}

function editarBtn(row){
  return `<button type="button" class="linkBtn editarBtn" data-id="${row.id}">✏ editar</button>`;
}

function removerBtn(row){
  if (row.status === 'processing') return '';
  return `<button type="button" class="linkBtn danger removerBtn" data-id="${row.id}">✕ remover</button>`;
}

function confirmarBtn(row){
  return `<button type="button" class="linkBtn confirmarBtn" data-id="${row.id}">✓ confirmar</button>`;
}

function ensinarBtn(row){
  return `<button type="button" class="linkBtn ensinarBtn" data-id="${row.id}">🎓 ensinar condomínio</button>`;
}

function confirmarLinha(row){
  row.confidence = 1;
  row.status = 'ok';
  row.manualEdit = true;
  row.editing = false;
  renderRow(row);
  reorderTable();
  applyFilters();
}

function downloadSingleFile(row){
  if (!row.originalFile) return;
  const url = URL.createObjectURL(row.originalFile);
  const a = document.createElement('a');
  a.href = url;
  a.download = row.suggestedName || row.originalName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reorderTable(){
  const pendentes = items.filter(i => i.status !== 'ok');
  const prontos = items.filter(i => i.status === 'ok');
  for (const r of [...pendentes, ...prontos]){
    const tr = document.getElementById('row-' + r.id);
    if (tr) resultsBody.appendChild(tr);
  }
}

function renderRow(row){
  let tr = document.getElementById('row-' + row.id);
  if (!tr){
    tr = document.createElement('tr');
    tr.id = 'row-' + row.id;
    resultsBody.appendChild(tr);
  }

  let badge, nameCell;
  if (row.status === 'processing'){
    badge = `<span class="status"><span class="spinner"></span> lendo...</span>`;
    nameCell = `<span class="orig">processando...</span>`;
  } else if (row.status === 'error'){
    badge = `<span class="badge err">✕ ERRO</span>`;
    nameCell = `<div class="status">${escapeHtml(row.error || 'falha ao processar')}</div>
      <input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
      <div class="rowActions">${verArquivoBtn(row)}${removerBtn(row)}</div>`;
  } else if (row.status === 'unidentified'){
    badge = `<span class="badge low">⚠ NÃO IDENTIFICADO</span>`;
    nameCell = `<div class="status">Não foi possível determinar tipo/data automaticamente.</div>
      <input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
      <div class="rowActions">${verArquivoBtn(row)}${ensinarBtn(row)}${baixarUmBtn(row)}${removerBtn(row)}</div>
      ${ocrTextDetails(row)}`;
  } else if (row.status === 'low'){
    badge = `<span class="badge low">⚠ CONFERIR (${Math.round(row.confidence * 100)}%)</span>`;
    nameCell = `<input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
      <div class="rowActions">${confirmarBtn(row)}${verArquivoBtn(row)}${ensinarBtn(row)}${baixarUmBtn(row)}${removerBtn(row)}</div>
      ${ocrTextDetails(row)}`;
  } else {
    badge = row.merged
      ? `<span class="badge high">🔗 PDF UNIDO</span>`
      : row.manualEdit
        ? `<span class="badge high">✓ CONFIRMADO (100%)</span>`
        : `<span class="badge high">✓ ALTA CONFIANÇA (${Math.round(row.confidence * 100)}%)</span>`;
    if (row.editing){
      nameCell = `<input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
        <div class="rowActions">${verArquivoBtn(row)}${baixarUmBtn(row)}${removerBtn(row)}</div>`;
    } else {
      nameCell = `<div class="name">${escapeHtml(row.suggestedName)}</div>
        <div class="rowActions">${editarBtn(row)}${verArquivoBtn(row)}${baixarUmBtn(row)}${removerBtn(row)}</div>`;
    }
  }

  const origCell = row.merged
    ? `<div class="orig">Unido de:<br>${row.mergedFrom.map(n => escapeHtml(n)).join('<br>')}</div>`
    : `<div class="orig">${escapeHtml(row.originalName)}</div>${
      row.usedOCR
        ? `<div class="status">via OCR${row.rotationUsed ? ' · girado ' + row.rotationUsed + '°' : ''}${row.ocrConfidencePct != null ? ' · conf. ' + row.ocrConfidencePct + '%' : ''}${row.reviewed ? ' · revisado' : ''}</div>`
        : row.usedAI
          ? `<div class="status">via IA${row.reviewed ? ' · revisado' : ''}</div>`
          : ''
    }`;

  const podeSelecionarParaJuncao = row.status !== 'processing';
  const checkboxCell = podeSelecionarParaJuncao
    ? `<input type="checkbox" class="mergeCheckbox" data-id="${row.id}" ${mergeQueueIds.includes(row.id) ? 'checked' : ''}>`
    : '';

  tr.innerHTML = `
    <td>${checkboxCell}</td>
    <td>${origCell}</td>
    <td>${nameCell}</td>
    <td>${badge}</td>
    <td><div class="fields">${fieldsSummary(row.fields)}</div></td>
  `;

  const verBtn = tr.querySelector('.verArquivoBtn');
  if (verBtn) verBtn.addEventListener('click', () => openPreview(row));

  const baixarBtn = tr.querySelector('.baixarUmBtn');
  if (baixarBtn) baixarBtn.addEventListener('click', () => downloadSingleFile(row));

  const editBtn = tr.querySelector('.editarBtn');
  if (editBtn){
    editBtn.addEventListener('click', () => {
      row.editing = true;
      renderRow(row);
      const inp = document.querySelector(`#row-${row.id} .nameInput`);
      if (inp){ inp.focus(); inp.select(); }
    });
  }

  const remBtn = tr.querySelector('.removerBtn');
  if (remBtn){
    remBtn.addEventListener('click', () => {
      removeItemById(row.id);
      tr.remove();
      renderMergePanel();
      if (items.length === 0){
        resultsTable.style.display = 'none';
        filterBar.style.display = 'none';
        actionsBar.style.display = 'none';
        empty.style.display = 'block';
      }
      updateCount();
    });
  }

  const ensinarBtnEl = tr.querySelector('.ensinarBtn');
  if (ensinarBtnEl) ensinarBtnEl.addEventListener('click', () => ensinarCondominio(row));

  const confirmarBtnEl = tr.querySelector('.confirmarBtn');
  if (confirmarBtnEl) confirmarBtnEl.addEventListener('click', () => confirmarLinha(row));

  const mergeCheckbox = tr.querySelector('.mergeCheckbox');
  if (mergeCheckbox){
    mergeCheckbox.addEventListener('change', () => toggleMergeSelection(row.id, mergeCheckbox.checked));
  }

  const input = tr.querySelector('.nameInput');
  if (input){
    const commitEdit = () => {
      const r = items.find(i => i.id === row.id);
      if (!r) return;
      const val = input.value.trim();
      if (!val){
        r.editing = false;
        renderRow(r);
        return;
      }
      r.suggestedName = replaceReservedName(r.suggestedName, val);
      confirmarLinha(r);
    };
    input.addEventListener('change', commitEdit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter'){ e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape' && row.editing){
        row.editing = false;
        renderRow(row);
      }
    });
  }

  applyFilterToRow(row);
  updateCount();
}

/* ============================================================
   ENSINAR CONDOMÍNIO & REPROCESSAMENTO
   ============================================================ */

function reprocessarLinha(row){
  if (!row.ocrText) return false;
  const ocrConfidence = row.ocrConfidencePct != null ? row.ocrConfidencePct / 100 : null;
  const result = identifyDocument(row.ocrText, ocrConfidence);
  if (!result.nome) return false;

  releaseName(row.suggestedName);
  row.fields = result.fields;
  row.ruleId = result.ruleId;
  row.suggestedName = reserveUniqueName(result.nome);
  row.confidence = result.confidence;
  row.status = result.confidence >= CONFIDENCE_THRESHOLD ? 'ok' : 'low';
  return true;
}

function ensinarCondominio(row){
  const raw = row.ocrText || '';
  const sugestao = findCondominioFallback(raw) || '';
  const nome = window.prompt(
    'Nome do condomínio como deve aparecer no nome do arquivo (ex.: ARQUIPELAGO DO SOL):',
    sugestao
  );
  if (nome === null) return;
  const nomeLimpo = nome.trim();
  if (!nomeLimpo) return;

  aprenderCondominio(nomeLimpo, sugestao);
  const salvo = learnedCondominios.find(c => c.nome === nomeLimpo.toUpperCase());
  if (salvo) pushCondominiosToCloud([salvo]);
  updateLearnCount();
  preencherLoteCondominioSelect();

  let melhoradas = 0;
  for (const r of items){
    if (r.status !== 'low' && r.status !== 'unidentified') continue;
    if (reprocessarLinha(r)){
      melhoradas++;
      renderRow(r);
    }
  }
  if (melhoradas){
    reorderTable();
    applyFilters();
  }

  alert(`"${nomeLimpo.toUpperCase()}" salvo. Documentos futuros com esse nome no cabeçalho serão reconhecidos automaticamente (inclusive em lotes futuros neste computador).${melhoradas ? `\n\n${melhoradas} documento(s) deste lote foram reidentificados agora.` : ''}`);
}

function reviewableRows(){
  return items.filter(i => i.status !== 'processing' && (i.usedOCR || i.usedAI) && !i.reviewed && (i.status === 'low' || i.status === 'unidentified'));
}

function updateCount(){
  const total = items.length;
  const okCount = items.filter(i => i.status === 'ok').length;
  const lowCount = items.filter(i => i.status === 'low').length;
  const unidentifiedCount = items.filter(i => i.status === 'unidentified').length;
  const errorCount = items.filter(i => i.status === 'error').length;
  const pendingCount = total - okCount;
  const doneCount = items.filter(i => i.status !== 'processing').length;

  countAllEl.textContent = String(total);
  countPendingEl.textContent = String(pendingCount);
  countLowEl.textContent = String(lowCount);
  countUnidentifiedEl.textContent = String(unidentifiedCount);
  countErrorEl.textContent = String(errorCount);
  countOkEl.textContent = String(okCount);

  countEl.textContent = `${okCount} pronto(s) · ${pendingCount} pendente(s) (${doneCount}/${total} lidos)`;
  downloadBtn.disabled = doneCount === 0;

  const pendingReview = reviewableRows();
  if (pendingReview.length > 0){
    reviewBtn.style.display = 'inline-block';
    reviewBtn.textContent = `REVISAR BAIXA CONFIANÇA (${pendingReview.length})`;
  } else {
    reviewBtn.style.display = 'none';
  }
  updateReprocessFilteredBtn();
}

/* ============================================================
   REVISÃO PROFUNDA, REPROCESSAR FILTRADOS, DOWNLOAD ZIP & NOVO LOTE
   ============================================================ */

async function runReviewBatch(targets, { force = false, labelPrefix = 'Revisando' } = {}){
  if (!targets.length || isBatchRunning) return;

  isBatchRunning = true;
  cancelRequested = false;
  batchStartTime = Date.now();
  acquireWakeLock();
  reviewBtn.disabled = true;
  if (reprocessFilteredBtn) reprocessFilteredBtn.disabled = true;
  clearBtn.disabled = true;
  downloadBtn.disabled = true;
  progressWrap.style.display = 'block';
  cancelBatchBtn.style.display = 'inline-block';
  cancelBatchBtn.disabled = false;
  cancelBatchBtn.textContent = 'PARAR LOTE';

  let done = 0;
  const total = targets.length;
  progressLabel.textContent = `${labelPrefix} ${done} de ${total} documento(s)...`;
  progressFill.style.width = '0%';

  try {
    for (const row of targets){
      if (cancelRequested) break;
      const statusAntesDaRevisao = row.status;
      row.status = 'processing';
      renderRow(row);
      try {
        const improved = await reviewDocumentSmart(row, { force });
        if (improved && improved.result && improved.result.nome){
          releaseName(row.suggestedName);
          row.ocrText = improved.text;
          row.ocrConfidencePct = improved.ocrConfidence != null ? Math.round(improved.ocrConfidence * 100) : null;
          row.rotationUsed = improved.rotationUsed;
          if (improved.usedAI) row.usedAI = true;
          else row.usedOCR = true;
          row.fields = improved.result.fields;
          row.ruleId = improved.result.ruleId;
          row.suggestedName = reserveUniqueName(improved.result.nome);
          row.confidence = improved.result.confidence;
          row.manualEdit = false;
          row.status = improved.result.confidence >= CONFIDENCE_THRESHOLD ? 'ok' : 'low';
          row.reviewed = true;
        } else if (improved){
          row.ocrText = improved.text;
          row.ocrConfidencePct = improved.ocrConfidence != null ? Math.round(improved.ocrConfidence * 100) : null;
          row.rotationUsed = improved.rotationUsed;
          row.reviewed = true;
          row.status = statusAntesDaRevisao;
        } else {
          row.reviewed = true;
          row.status = statusAntesDaRevisao;
        }
      } catch (err){
        console.error(err);
        row.reviewed = true;
        row.status = statusAntesDaRevisao;
      }
      done++;
      const pct = Math.round((done / total) * 100);
      progressLabel.textContent = `${labelPrefix} ${done} de ${total} (${pct}%)${formatEta(done, total)}`;
      progressFill.style.width = pct + '%';
      renderRow(row);
    }
  } finally {
    isBatchRunning = false;
    batchStartTime = 0;
    releaseWakeLock();
    cancelBatchBtn.style.display = 'none';
    reviewBtn.disabled = false;
    if (reprocessFilteredBtn) reprocessFilteredBtn.disabled = false;
    clearBtn.disabled = false;
    downloadBtn.disabled = false;
  }

  progressLabel.textContent = cancelRequested
    ? `Reprocessamento interrompido: ${done} de ${total} documento(s).`
    : `Concluído: ${done} documento(s) reprocessado(s).`;
  cancelRequested = false;
  reorderTable();
  applyFilters();
  updateCount();
  updateAiStatusButton();
}

reviewBtn.addEventListener('click', () => {
  runReviewBatch(reviewableRows(), { force: false, labelPrefix: 'Revisando baixa confiança' });
});

if (reprocessFilteredBtn){
  reprocessFilteredBtn.addEventListener('click', () => {
    const targets = getFilteredReprocessableRows();
    if (!targets.length) return;
    if (targets.length > 10 && !confirm(`Reprocessar ${targets.length} documento(s) filtrados agora?`)){
      return;
    }
    runReviewBatch(targets, { force: true, labelPrefix: 'Reprocessando filtrados' });
  });
}

downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'GERANDO ZIP...';
  try {
    const zip = new JSZip();
    const organizeByMonth = !zipByMonthToggle || zipByMonthToggle.checked;
    for (const row of items){
      if (row.status === 'processing') continue;
      const entryPath = organizeByMonth
        ? `${resolveZipMonthFolder(row)}/${row.suggestedName}`
        : row.suggestedName;
      zip.file(entryPath, row.originalFile);
    }
    // PDFs já são comprimidos: STORE evita desperdiçar CPU tentando recomprimir 400+ arquivos no navegador.
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'documentos_renomeados.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'BAIXAR TODOS (.ZIP)';
  }
});

clearBtn.addEventListener('click', () => {
  if (items.length && !confirm('Limpar a lista atual? Isso não apaga o ZIP já baixado, só reseta a tela para um novo lote.')) return;
  closePreview();
  clearAllState();
  clearMergeQueue();
  resultsBody.innerHTML = '';
  resultsTable.style.display = 'none';
  filterBar.style.display = 'none';
  actionsBar.style.display = 'none';
  progressWrap.style.display = 'none';
  empty.style.display = 'block';
  if (searchInput) searchInput.value = '';
  activeFilter = 'all';
  document.querySelectorAll('.filterBtn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  updateCount();
});

/* ============================================================
   EXPORTAR/IMPORTAR APRENDIZADO DE CONDOMÍNIOS
   ============================================================ */

function updateLearnCount(){
  const n = learnedCondominios.length;
  const sufixo = cloudSyncActive ? 'sincronizados na nuvem' : 'salvos neste navegador';
  learnCount.textContent = n === 0
    ? (cloudSyncActive ? 'Nenhum condomínio aprendido ainda (nuvem conectada).' : 'Nenhum condomínio aprendido manualmente ainda.')
    : `${n} condomínio(s) aprendido(s) manualmente (${sufixo}).`;
}

function preencherLoteCondominioSelect(){
  if (!loteCondominioSelect) return;
  const selecaoAtual = loteCondominioSelect.value;
  const nomes = todosCondominios().map(c => c.nome).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  loteCondominioSelect.innerHTML = '<option value="">— detectar automaticamente —</option>' +
    nomes.map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
  if (nomes.includes(selecaoAtual)) loteCondominioSelect.value = selecaoAtual;
}

exportLearnBtn.addEventListener('click', () => {
  if (!learnedCondominios.length){
    alert('Ainda não há nenhum condomínio aprendido pra exportar. Use o botão "🎓 ensinar condomínio" nas linhas de baixa confiança primeiro.');
    return;
  }
  const blob = new Blob([JSON.stringify(learnedCondominios, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'renomeador-aprendizado-condominios.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

importLearnBtn.addEventListener('click', () => importLearnInput.click());

importLearnInput.addEventListener('change', async () => {
  const file = importLearnInput.files[0];
  importLearnInput.value = '';
  if (!file) return;

  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    alert('Não consegui ler esse arquivo como JSON válido. Ele precisa ser um arquivo exportado por este mesmo app.');
    return;
  }
  if (!Array.isArray(parsed)){
    alert('Formato inesperado: o arquivo deveria conter uma lista de condomínios.');
    return;
  }

  let novos = 0, aliasesSomados = 0;
  for (const entry of parsed){
    if (!entry || typeof entry.nome !== 'string') continue;
    const nome = entry.nome.trim().toUpperCase();
    if (!nome) continue;
    let existente = learnedCondominios.find(c => c.nome === nome);
    if (!existente){
      existente = { nome, aliases: [] };
      learnedCondominios.push(existente);
      novos++;
    }
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const alias of aliases){
      const a = String(alias).trim().toUpperCase();
      if (a && !existente.aliases.includes(a)){
        existente.aliases.push(a);
        aliasesSomados++;
      }
    }
  }
  saveLearnedCondominios();
  pushCondominiosToCloud(learnedCondominios);
  updateLearnCount();
  preencherLoteCondominioSelect();

  let melhoradas = 0;
  for (const r of items){
    if (r.status !== 'low' && r.status !== 'unidentified') continue;
    if (reprocessarLinha(r)){ melhoradas++; renderRow(r); }
  }
  if (melhoradas){
    reorderTable();
    applyFilters();
  }

  alert(`Importado: ${novos} condomínio(s) novo(s), ${aliasesSomados} apelido(s) somado(s) aos existentes.${melhoradas ? `\n${melhoradas} documento(s) pendente(s) nesta tela foram reidentificados agora.` : ''}`);
});

// Inicialização da página
updateLearnCount();
preencherLoteCondominioSelect();
updateAiStatusButton();
syncCondominiosFromCloud();
