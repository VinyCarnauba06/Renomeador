// pdf-merge.js
// Junção de PDFs (ex.: síndico pede boleto + comprovante no mesmo arquivo) via pdf-lib,
// preservando o PDF vetorial original. Usa state.js + callbacks de initPdfMerge() — sem import circular com ui.js.
import { items, mergeQueueIds, reserveUniqueName, releaseName } from './state.js';
import { escapeHtml, stripPdfExt } from './pdf-utils.js';

const mergePanel = document.getElementById('mergePanel');
const mergeQueueList = document.getElementById('mergeQueueList');
const mergeNameInput = document.getElementById('mergeNameInput');
const mergeCancelBtn = document.getElementById('mergeCancelBtn');
const mergeConfirmBtn = document.getElementById('mergeConfirmBtn');

let callbacks = { onMerged: null };

export function initPdfMerge(cbs = {}){
  callbacks = { ...callbacks, ...cbs };
}

export function toggleMergeSelection(id, checked){
  if (checked){
    if (!mergeQueueIds.includes(id)) mergeQueueIds.push(id);
  } else {
    const idx = mergeQueueIds.indexOf(id);
    if (idx >= 0) mergeQueueIds.splice(idx, 1);
  }
  renderMergePanel();
}

export function clearMergeQueue(){
  for (const id of mergeQueueIds){
    const cb = document.querySelector(`.mergeCheckbox[data-id="${id}"]`);
    if (cb) cb.checked = false;
  }
  mergeQueueIds.length = 0;
  if (mergeNameInput) delete mergeNameInput.dataset.userEdited;
  renderMergePanel();
}

function moveInQueue(id, delta){
  const idx = mergeQueueIds.indexOf(id);
  const novoIdx = idx + delta;
  if (idx < 0 || novoIdx < 0 || novoIdx >= mergeQueueIds.length) return;
  [mergeQueueIds[idx], mergeQueueIds[novoIdx]] = [mergeQueueIds[novoIdx], mergeQueueIds[idx]];
  renderMergePanel();
}

function removeFromQueue(id){
  const idx = mergeQueueIds.indexOf(id);
  if (idx >= 0) mergeQueueIds.splice(idx, 1);
  renderMergePanel();
  const cb = document.querySelector(`.mergeCheckbox[data-id="${id}"]`);
  if (cb) cb.checked = false;
}

function sugerirNomeJuncao(){
  const primeiro = items.find(i => i.id === mergeQueueIds[0]);
  return primeiro ? stripPdfExt(primeiro.suggestedName || primeiro.originalName) : '';
}

export function renderMergePanel(){
  if (!mergePanel) return;
  if (mergeQueueIds.length < 2){
    mergePanel.style.display = 'none';
    return;
  }
  mergePanel.style.display = 'block';
  mergeQueueList.innerHTML = mergeQueueIds.map((id, idx) => {
    const row = items.find(i => i.id === id);
    const nome = row ? (row.suggestedName || row.originalName) : '(removido)';
    return `<li>
      <span class="mergeQueueName">${escapeHtml(nome)}</span>
      <span class="mergeQueueActions">
        <button type="button" class="linkBtn mergeUpBtn" data-id="${id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="linkBtn mergeDownBtn" data-id="${id}" ${idx === mergeQueueIds.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="linkBtn mergeRemoveBtn" data-id="${id}">remover</button>
      </span>
    </li>`;
  }).join('');

  if (!mergeNameInput.dataset.userEdited){
    mergeNameInput.value = sugerirNomeJuncao();
  }

  mergeQueueList.querySelectorAll('.mergeUpBtn').forEach(b => b.addEventListener('click', () => moveInQueue(b.dataset.id, -1)));
  mergeQueueList.querySelectorAll('.mergeDownBtn').forEach(b => b.addEventListener('click', () => moveInQueue(b.dataset.id, 1)));
  mergeQueueList.querySelectorAll('.mergeRemoveBtn').forEach(b => b.addEventListener('click', () => removeFromQueue(b.dataset.id)));
}

if (mergeNameInput){
  mergeNameInput.addEventListener('input', () => { mergeNameInput.dataset.userEdited = '1'; });
}

if (mergeCancelBtn){
  mergeCancelBtn.addEventListener('click', clearMergeQueue);
}

async function mergeSelectedPdfs(){
  if (mergeQueueIds.length < 2) return;
  const nomeDigitado = stripPdfExt(mergeNameInput.value);
  if (!nomeDigitado){ alert('Digite um nome pro PDF final.'); return; }

  mergeConfirmBtn.disabled = true;
  mergeConfirmBtn.textContent = 'JUNTANDO...';
  try {
    const rows = mergeQueueIds.map(id => items.find(i => i.id === id)).filter(Boolean);
    if (rows.length < 2){ alert('Selecione pelo menos 2 documentos válidos.'); return; }

    const merged = await PDFLib.PDFDocument.create();
    for (const row of rows){
      const bytes = await row.originalFile.arrayBuffer();
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const paginas = await merged.copyPages(src, src.getPageIndices());
      paginas.forEach(p => merged.addPage(p));
    }
    const mergedBytes = await merged.save();

    const nomesOrigem = rows.map(r => r.suggestedName || r.originalName);
    const idsParaRemover = new Set(rows.map(r => r.id));
    for (const row of rows){
      releaseName(row.suggestedName);
      const tr = document.getElementById('row-' + row.id);
      if (tr) tr.remove();
    }
    items.splice(0, items.length, ...items.filter(i => !idsParaRemover.has(i.id)));

    const suggestedName = reserveUniqueName(nomeDigitado);
    const mergedFile = new File([mergedBytes], suggestedName, { type: 'application/pdf' });

    const novaLinha = {
      id: 'f' + Math.random().toString(36).slice(2),
      originalFile: mergedFile,
      originalName: nomesOrigem.join(' + '),
      suggestedName,
      confidence: 1,
      fields: {},
      status: 'ok',
      manualEdit: true,
      merged: true,
      mergedFrom: nomesOrigem,
    };
    items.push(novaLinha);

    mergeQueueIds.length = 0;
    delete mergeNameInput.dataset.userEdited;
    renderMergePanel();

    if (typeof callbacks.onMerged === 'function'){
      callbacks.onMerged(novaLinha);
    }
  } catch (err){
    console.error(err);
    alert('Não foi possível juntar esses PDFs: ' + (err.message || err) + '\n\nVerifique se nenhum deles está protegido por senha.');
  } finally {
    mergeConfirmBtn.disabled = false;
    mergeConfirmBtn.textContent = 'JUNTAR EM 1 PDF';
  }
}

if (mergeConfirmBtn){
  mergeConfirmBtn.addEventListener('click', mergeSelectedPdfs);
}
