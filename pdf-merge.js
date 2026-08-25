// pdf-merge.js
// Junção de PDFs (ex.: síndico pede boleto + comprovante no mesmo arquivo).
// Marca-se 2+ documentos via checkbox; a fila abaixo da tabela mostra a ordem em que as páginas vão
// entrar no PDF final (ordem de marcação, ajustável com ▲▼). Junção real de páginas via pdf-lib — mantém o
// PDF vetorial original (não rasteriza), diferente de qualquer solução que passasse pelas imagens do canvas.
// Tudo roda no navegador, como o resto do app: nenhum arquivo sai da máquina.
//
// Import circular com ui.js: esse módulo precisa ler/mutar a lista de documentos (`items`) e o conjunto de
// nomes reservados (`usedNames`) que ui.js possui, e chamar de volta renderRow/reorderTable/updateCount/
// escapeHtml de lá; ui.js, por sua vez, importa `mergeQueueIds`/`toggleMergeSelection` daqui pra desenhar o
// checkbox de cada linha. Seguro pelo mesmo motivo dos outros ciclos deste projeto — ver config.js.
import { items, usedNames, uniqueName, renderRow, reorderTable, updateCount, escapeHtml } from './ui.js';

const mergePanel = document.getElementById('mergePanel');
const mergeQueueList = document.getElementById('mergeQueueList');
const mergeNameInput = document.getElementById('mergeNameInput');
const mergeCancelBtn = document.getElementById('mergeCancelBtn');
const mergeConfirmBtn = document.getElementById('mergeConfirmBtn');

export let mergeQueueIds = []; // ids selecionados pra juntar num só PDF, na ordem em que serão empilhados (checkbox)

export function toggleMergeSelection(id, checked){
  if (checked){
    if (!mergeQueueIds.includes(id)) mergeQueueIds.push(id);
  } else {
    mergeQueueIds = mergeQueueIds.filter(i => i !== id);
  }
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
  mergeQueueIds = mergeQueueIds.filter(i => i !== id);
  renderMergePanel();
  // Desmarca o checkbox correspondente na tabela, se ainda estiver na tela.
  const cb = document.querySelector(`.mergeCheckbox[data-id="${id}"]`);
  if (cb) cb.checked = false;
}

// Sugere um nome pro PDF final: usa o nome já sugerido do primeiro documento da fila (normalmente o
// "principal", ex. o boleto) — o usuário pode sempre editar antes de confirmar.
function sugerirNomeJuncao(){
  const primeiro = items.find(i => i.id === mergeQueueIds[0]);
  return primeiro ? primeiro.suggestedName.replace(/\.pdf$/i, '') : '';
}

function renderMergePanel(){
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

mergeNameInput.addEventListener('input', () => { mergeNameInput.dataset.userEdited = '1'; });

mergeCancelBtn.addEventListener('click', () => {
  for (const id of mergeQueueIds){
    const cb = document.querySelector(`.mergeCheckbox[data-id="${id}"]`);
    if (cb) cb.checked = false;
  }
  mergeQueueIds = [];
  delete mergeNameInput.dataset.userEdited;
  renderMergePanel();
});

// Junta as páginas dos PDFs selecionados (na ordem da fila) num arquivo único via pdf-lib. Preserva o
// conteúdo vetorial original — não passa pelo canvas/OCR, então não perde qualidade nem depende de imagem.
async function mergeSelectedPdfs(){
  if (mergeQueueIds.length < 2) return;
  let nomeFinal = mergeNameInput.value.trim();
  if (!nomeFinal){ alert('Digite um nome pro PDF final.'); return; }
  if (!nomeFinal.toLowerCase().endsWith('.pdf')) nomeFinal += '.pdf';

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
    const mergedFile = new File([mergedBytes], nomeFinal, { type: 'application/pdf' });

    // Remove as linhas originais (libera nomes reservados e tira da tela) e entra com uma linha única no lugar.
    const nomesOrigem = rows.map(r => r.suggestedName || r.originalName);
    for (const row of rows){
      if (row.suggestedName) usedNames.delete(row.suggestedName.toUpperCase());
      const tr = document.getElementById('row-' + row.id);
      if (tr) tr.remove();
    }
    // `items` é importado de ui.js: não pode ser reatribuído daqui (binding de import é somente leitura),
    // então a remoção é feita mutando o array in-place em vez de `items = items.filter(...)`.
    items.splice(0, items.length, ...items.filter(i => !mergeQueueIds.includes(i.id)));

    const novaLinha = {
      id: 'f' + Math.random().toString(36).slice(2),
      originalFile: mergedFile,
      originalName: nomesOrigem.join(' + '),
      suggestedName: uniqueName(nomeFinal.replace(/\.pdf$/i, '')) + '.pdf',
      confidence: 1,
      fields: {},
      status: 'ok',
      manualEdit: true,
      merged: true,
      mergedFrom: nomesOrigem
    };
    items.push(novaLinha);
    renderRow(novaLinha);
    reorderTable();

    mergeQueueIds = [];
    delete mergeNameInput.dataset.userEdited;
    renderMergePanel();
    updateCount();
  } catch (err){
    console.error(err);
    alert('Não foi possível juntar esses PDFs: ' + (err.message || err) + '\n\nVerifique se nenhum deles está protegido por senha.');
  } finally {
    mergeConfirmBtn.disabled = false;
    mergeConfirmBtn.textContent = 'JUNTAR EM 1 PDF';
  }
}

mergeConfirmBtn.addEventListener('click', mergeSelectedPdfs);
