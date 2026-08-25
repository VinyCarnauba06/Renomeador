// ui.js
// Orquestração de DOM: refs de elementos, upload/processamento de arquivos, render das linhas da tabela,
// fluxo de "ensinar condomínio", revisão de baixa confiança, download do ZIP e exportar/importar aprendizado.
// Importa a lógica pura dos outros módulos — não define regra de negócio nenhuma aqui.
//
// Import circular com pdf-merge.js: aquele módulo precisa de `items`/`usedNames`/`uniqueName`/`renderRow`/
// `reorderTable`/`updateCount`/`escapeHtml` daqui; este módulo precisa de `mergeQueueIds`/`toggleMergeSelection`
// de lá pra desenhar o checkbox de junção em cada linha. Seguro pelo mesmo motivo dos outros ciclos deste
// projeto (as referências cruzadas só são lidas dentro de funções/callbacks, nunca na avaliação do módulo)
// — ver comentário em config.js.
import { CONFIDENCE_THRESHOLD } from './config.js';
import { identifyDocument, aprenderCondominio, todosCondominios, findCondominioFallback, learnedCondominios, saveLearnedCondominios, setLoteHintProvider } from './rules-engine.js';
import { identifyDocumentSmart } from './ai-extraction.js';
import { reviewDocument } from './ocr-pipeline.js';
import { mergeQueueIds, toggleMergeSelection } from './pdf-merge.js';

const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const loteCondominioSelect = document.getElementById('loteCondominioSelect');
const progressWrap = document.getElementById('progressWrap');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');
const resultsTable = document.getElementById('resultsTable');
const resultsBody = document.getElementById('resultsBody');
const empty = document.getElementById('empty');
const actionsBar = document.getElementById('actionsBar');
const countEl = document.getElementById('count');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const reviewBtn = document.getElementById('reviewBtn');
const learnCount = document.getElementById('learnCount');
const exportLearnBtn = document.getElementById('exportLearnBtn');
const importLearnBtn = document.getElementById('importLearnBtn');
const importLearnInput = document.getElementById('importLearnInput');

// rules-engine.js não pode depender de DOM diretamente (precisa ficar testável em Node isolado) — por isso
// a dica de condomínio do lote é injetada aqui como uma função, em vez do motor de regras ler o `<select>` ele mesmo.
setLoteHintProvider(() => loteCondominioSelect && loteCondominioSelect.value);

export let items = []; // { id, originalFile, originalName, suggestedName, confidence, fields, status, error }
export let usedNames = new Set();

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

export function uniqueName(base){
  let candidate = base;
  let n = 2;
  while (usedNames.has(candidate.toUpperCase())){
    candidate = `${base} (${n})`;
    n++;
  }
  usedNames.add(candidate.toUpperCase());
  return candidate;
}

// Tamanho do "lote interno" de processamento. Em vez de encarar os 200 arquivos de um lote de digitalização
// como uma fila só, processa em blocos de 30: lê os 30, organiza o que deu certo e o que precisa de revisão,
// devolve o controle pro navegador por um instante (evita a aba travar em lotes grandes) e só então segue
// pro próximo bloco de 30 — automaticamente, sem precisar clicar em nada — até acabar tudo.
const TAMANHO_LOTE_INTERNO = 30;

async function handleFiles(files){
  if (!files.length) return;
  empty.style.display = 'none';
  resultsTable.style.display = 'table';
  actionsBar.style.display = 'flex';
  progressWrap.style.display = 'block';

  let done = 0;
  const total = files.length;
  const totalBlocos = Math.ceil(total / TAMANHO_LOTE_INTERNO);
  updateProgress(done, total, 1, totalBlocos);

  for (let bloco = 0; bloco < totalBlocos; bloco++){
    const inicio = bloco * TAMANHO_LOTE_INTERNO;
    const arquivosDoBloco = files.slice(inicio, inicio + TAMANHO_LOTE_INTERNO);

    for (const file of arquivosDoBloco){
      const id = 'f' + Math.random().toString(36).slice(2);
      const row = { id, originalFile: file, originalName: file.name, suggestedName: null, confidence: 0, fields: {}, status: 'processing', error: null };
      items.push(row);
      renderRow(row);

      try {
        const result = await identifyDocumentSmart(file);
        row.fields = result.fields;
        row.ruleId = result.ruleId;
        row.usedOCR = result.usedOCR;
        row.usedAI = result.usedAI;
        row.rotationUsed = result.rotationUsed;
        row.ocrText = result.text;
        // Confiança de OCR bruta só existe no pipeline local antigo; no caminho de regras locais com texto
        // nativo e no caminho de IA, result.confidence já É a confiança final — não há uma métrica separada.
        row.ocrConfidencePct = result.usedOCR ? Math.round((result.confidence || 0) * 100) : null;

        if (result.nome && result.confidence >= CONFIDENCE_THRESHOLD){
          row.suggestedName = uniqueName(result.nome) + '.pdf';
          row.confidence = result.confidence;
          row.status = 'ok';
        } else if (result.nome){
          row.suggestedName = uniqueName(result.nome) + '.pdf';
          row.confidence = result.confidence;
          row.status = 'low';
        } else {
          row.suggestedName = uniqueName(file.name.replace(/\.pdf$/i,'')) + '.pdf';
          row.confidence = 0;
          row.status = 'unidentified';
        }
      } catch (err){
        console.error(err);
        row.status = 'error';
        row.error = err.message || String(err);
        row.suggestedName = uniqueName(file.name.replace(/\.pdf$/i,'')) + '.pdf';
      }

      done++;
      updateProgress(done, total, bloco + 1, totalBlocos);
      renderRow(row);
    }

    // Fim do bloco de 30: separa o que já está pronto do que precisa de revisão antes de seguir.
    reorderTable();
    if (bloco < totalBlocos - 1){
      await new Promise(resolve => setTimeout(resolve, 0)); // devolve o controle pro navegador entre blocos
    }
  }

  progressLabel.textContent = `Concluído: ${total} documento(s) processado(s).`;
  reorderTable(); // deixa o que precisa de revisão no topo e o que já está pronto no fim
  updateCount();
}

function updateProgress(done, total, bloco, totalBlocos){
  const pct = total ? Math.round((done/total)*100) : 0;
  progressLabel.textContent = (totalBlocos && totalBlocos > 1)
    ? `Lote ${bloco} de ${totalBlocos} (30 por vez) — ${done} de ${total} documentos no total...`
    : `Processando ${done} de ${total} documentos...`;
  progressFill.style.width = pct + '%';
}

function fieldsSummary(f){
  if (!f) return '';
  const parts = [];
  if (f.tipo) parts.push(`<b>Tipo:</b> ${f.tipo}`);
  if (f.condominio) parts.push(`<b>Condomínio:</b> ${f.condominio}`);
  if (f.dataDDMM) parts.push(`<b>Data:</b> ${f.dataDDMM}${f.ano ? '.'+f.ano : ''}`);
  else if (f.mes || f.ano) parts.push(`<b>Mês/Ano:</b> ${f.mes||'?'} ${f.ano||''}`);
  else if (f.mesCompleto || f.ano) parts.push(`<b>Mês/Ano:</b> ${f.mesCompleto||'?'} ${f.ano||''}`);
  if (f.unidade) parts.push(`<b>Unidade:</b> ${f.unidade}`);
  if (f.ucSuffix) parts.push(`<b>UC:</b> ...${f.ucSuffix}`);
  if (f.apartamento) parts.push(`<b>Apto:</b> ${f.apartamento}`);
  if (f.numeroProtocolo) parts.push(`<b>Nº Protocolo:</b> ${f.numeroProtocolo}`);
  return parts.join('<br>') || '<span style="opacity:.5">nenhum campo reconhecido</span>';
}

// Mostra o texto bruto reconhecido (nativo ou OCR) para o usuário conferir por que a identificação falhou/ficou incerta.
function ocrTextDetails(row){
  if (!row.ocrText || !row.ocrText.trim()) return '';
  const preview = row.ocrText.trim().slice(0, 600);
  return `<details class="ocrDetails"><summary>ver texto reconhecido</summary><pre>${escapeHtml(preview)}</pre></details>`;
}

// Botão "ver arquivo": abre o PDF original numa aba nova pra conferência visual antes de renomear.
// Só cria a URL do blob na hora do clique (não guarda uma por linha o tempo todo).
function verArquivoBtn(row){
  if (!row.originalFile) return '';
  return `<button type="button" class="linkBtn verArquivoBtn" data-id="${row.id}">📄 ver arquivo</button>`;
}

// Botão "confirmar": pro caso comum de o OCR ter acertado o nome mas ficado com confiança baixa (ex.: 60%)
// por causa da qualidade da digitalização — em vez de precisar reescrever o mesmo texto no campo só pra
// "forçar" a confirmação, um clique já marca como 100% confiável.
function confirmarBtn(row){
  return `<button type="button" class="linkBtn confirmarBtn" data-id="${row.id}">✓ confirmar</button>`;
}

// Marca a linha como confirmada (100% de confiança) e reordena a tabela: linhas prontas descem pro fim,
// deixando só o que ainda precisa de atenção no topo.
function confirmarLinha(row){
  row.confidence = 1;
  row.status = 'ok';
  row.manualEdit = true;
  renderRow(row);
  reorderTable();
}

// Reordena as linhas na tela: o que ainda precisa de revisão (baixa confiança/não identificado/erro/em
// processamento) sobe pro topo; o que já está pronto (alta confiança ou confirmado) desce pro fim. Só
// move os elementos existentes — não recria nada, então não perde o estado dos inputs/detalhes abertos.
export function reorderTable(){
  const pendentes = items.filter(i => i.status !== 'ok');
  const prontos = items.filter(i => i.status === 'ok');
  for (const r of [...pendentes, ...prontos]){
    const tr = document.getElementById('row-' + r.id);
    if (tr) resultsBody.appendChild(tr);
  }
}

// Botão "ensinar condomínio": só aparece em linhas de baixa confiança/não identificadas. Deixa o usuário
// confirmar manualmente qual é o condomínio; a partir daí o nome fica salvo (localStorage, só nesta
// máquina) e passa a ser reconhecido automaticamente nos próximos documentos — inclusive em lotes futuros.
function ensinarBtn(row){
  return `<button type="button" class="linkBtn ensinarBtn" data-id="${row.id}">🎓 ensinar condomínio</button>`;
}

export function renderRow(row){
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
    nameCell = `<div class="status">${escapeHtml(row.error||'falha ao processar')}</div>
      <input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
      <div class="rowActions">${verArquivoBtn(row)}</div>`;
  } else if (row.status === 'unidentified'){
    badge = `<span class="badge low">⚠ NÃO IDENTIFICADO</span>`;
    nameCell = `<div class="status">Não foi possível determinar tipo/data automaticamente.</div>
      <input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
      <div class="rowActions">${verArquivoBtn(row)}${ensinarBtn(row)}</div>
      ${ocrTextDetails(row)}`;
  } else if (row.status === 'low'){
    badge = `<span class="badge low">⚠ CONFERIR (${Math.round(row.confidence*100)}%)</span>`;
    nameCell = `<input class="nameInput" data-id="${row.id}" value="${escapeAttr(row.suggestedName)}">
      <div class="rowActions">${confirmarBtn(row)}${verArquivoBtn(row)}${ensinarBtn(row)}</div>
      ${ocrTextDetails(row)}`;
  } else {
    badge = row.merged
      ? `<span class="badge high">🔗 PDF UNIDO</span>`
      : row.manualEdit
        ? `<span class="badge high">✓ CONFIRMADO MANUALMENTE (100%)</span>`
        : `<span class="badge high">✓ ALTA CONFIANÇA (${Math.round(row.confidence*100)}%)</span>`;
    nameCell = `<div class="name">${escapeHtml(row.suggestedName)}</div>
      <div class="rowActions">${verArquivoBtn(row)}</div>`;
  }

  const origCell = row.merged
    ? `<div class="orig">Unido de:<br>${row.mergedFrom.map(n => escapeHtml(n)).join('<br>')}</div>`
    : `<div class="orig">${escapeHtml(row.originalName)}</div>${row.usedOCR ? `<div class="status">via OCR${row.rotationUsed ? ' · girado '+row.rotationUsed+'°' : ''}${row.ocrConfidencePct != null ? ' · conf. '+row.ocrConfidencePct+'%' : ''}${row.reviewed ? ' · revisado' : ''}</div>` : row.usedAI ? `<div class="status">via IA${row.reviewed ? ' · revisado' : ''}</div>` : ''}`;

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
  if (verBtn){
    verBtn.addEventListener('click', () => {
      const url = URL.createObjectURL(row.originalFile);
      window.open(url, '_blank');
    });
  }

  const ensinarBtnEl = tr.querySelector('.ensinarBtn');
  if (ensinarBtnEl){
    ensinarBtnEl.addEventListener('click', () => ensinarCondominio(row));
  }

  const confirmarBtnEl = tr.querySelector('.confirmarBtn');
  if (confirmarBtnEl){
    // Cobre o caso do OCR ter acertado o nome mas ficado com confiança baixa (ex.: 60%) por causa da
    // qualidade da digitalização — confirma sem precisar reescrever o mesmo texto no campo.
    confirmarBtnEl.addEventListener('click', () => confirmarLinha(row));
  }

  const mergeCheckbox = tr.querySelector('.mergeCheckbox');
  if (mergeCheckbox){
    mergeCheckbox.addEventListener('change', () => toggleMergeSelection(row.id, mergeCheckbox.checked));
  }

  const input = tr.querySelector('.nameInput');
  if (input){
    // Se o usuário digitou o nome à mão (em vez de aceitar a sugestão), considera confirmado: 100% de
    // confiança, badge de alta confiança e sai da fila do botão "revisar baixa confiança".
    input.addEventListener('change', () => {
      const r = items.find(i => i.id === row.id);
      let val = input.value.trim();
      if (!val.toLowerCase().endsWith('.pdf')) val += '.pdf';
      if (r.suggestedName) usedNames.delete(r.suggestedName.toUpperCase());
      usedNames.add(val.toUpperCase());
      r.suggestedName = val;
      confirmarLinha(r);
    });
  }
  updateCount();
}

// Reaplica identifyDocument numa linha já processada (usado depois de "ensinar condomínio"), preservando
// o texto/confiança de OCR já extraídos — só a etapa de reconhecimento de campos é refeita.
function reprocessarLinha(row){
  if (!row.ocrText) return false;
  const ocrConfidence = row.ocrConfidencePct != null ? row.ocrConfidencePct / 100 : null;
  const result = identifyDocument(row.ocrText, ocrConfidence);
  if (!result.nome) return false;

  if (row.suggestedName) usedNames.delete(row.suggestedName.toUpperCase());
  row.fields = result.fields;
  row.ruleId = result.ruleId;
  row.suggestedName = uniqueName(result.nome) + '.pdf';
  row.confidence = result.confidence;
  row.status = result.confidence >= CONFIDENCE_THRESHOLD ? 'ok' : 'low';
  return true;
}

// Fluxo de "ensinar condomínio": pede confirmação do nome (sugerindo o que o fallback de cabeçalho
// encontrou, se encontrou algo), salva no whitelist aprendido e tenta reidentificar esta linha e
// qualquer outra do lote atual que ainda esteja pendente — é comum vários documentos do mesmo condomínio
// aparecerem juntos no mesmo lote de digitalização.
function ensinarCondominio(row){
  const raw = row.ocrText || '';
  const sugestao = findCondominioFallback(raw) || '';
  const nome = window.prompt(
    'Nome do condomínio como deve aparecer no nome do arquivo (ex.: ARQUIPELAGO DO SOL):',
    sugestao
  );
  if (nome === null) return; // cancelou
  const nomeLimpo = nome.trim();
  if (!nomeLimpo) return;

  aprenderCondominio(nomeLimpo, sugestao);
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
  if (melhoradas) reorderTable();

  alert(`"${nomeLimpo.toUpperCase()}" salvo. Documentos futuros com esse nome no cabeçalho serão reconhecidos automaticamente (inclusive em lotes futuros neste computador).${melhoradas ? `\n\n${melhoradas} documento(s) deste lote foram reidentificados agora.` : ''}`);
}

function reviewableRows(){
  // Documentos que passaram por OCR local OU por IA, ficaram abaixo do limiar de confiança e ainda não
  // foram revisados (a revisão é determinística o bastante — rodar de novo no mesmo arquivo raramente muda
  // o resultado sozinha, então não repete automaticamente).
  return items.filter(i => i.status !== 'processing' && (i.usedOCR || i.usedAI) && !i.reviewed && (i.status === 'low' || i.status === 'unidentified'));
}

export function updateCount(){
  const doneCount = items.filter(i => i.status !== 'processing').length;
  countEl.textContent = `${doneCount} de ${items.length} documento(s) prontos`;
  downloadBtn.disabled = doneCount === 0;

  const pending = reviewableRows();
  if (pending.length > 0){
    reviewBtn.style.display = 'inline-block';
    reviewBtn.textContent = `REVISAR BAIXA CONFIANÇA (${pending.length})`;
  } else {
    reviewBtn.style.display = 'none';
  }
}

export function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s){ return escapeHtml(s); }

// Revisão manual, sob demanda, só dos documentos que ficaram abaixo de 70% de confiança (ou não identificados)
// e vieram de OCR. É mais lenta de propósito (testa mais combinações) — por isso fica fora do fluxo automático.
reviewBtn.addEventListener('click', async () => {
  const pending = reviewableRows();
  if (!pending.length) return;

  reviewBtn.disabled = true;
  clearBtn.disabled = true;
  downloadBtn.disabled = true;
  progressWrap.style.display = 'block';

  let done = 0;
  const total = pending.length;
  progressLabel.textContent = `Revisando ${done} de ${total} documento(s) de baixa confiança...`;
  progressFill.style.width = '0%';

  for (const row of pending){
    // Guarda o status de ANTES da revisão — é o valor certo pra voltar se a revisão não melhorar nada.
    // Bug corrigido (13/ago): o código antigo usava `row.suggestedName ? 'low' : 'unidentified'` pra decidir
    // isso, mas suggestedName está SEMPRE preenchido (até documento nunca identificado ganha o nome do
    // arquivo original como sugestão) — então toda revisão sem melhora virava '⚠ CONFERIR (0%)' mesmo
    // quando o documento continuava, de fato, não identificado.
    const statusAntesDaRevisao = row.status;
    row.status = 'processing';
    renderRow(row);
    try {
      const improved = await reviewDocument(row);
      if (improved && improved.result.nome){
        // libera o nome antigo (se ele tinha reservado um) antes de reservar o novo
        if (row.suggestedName) usedNames.delete(row.suggestedName.toUpperCase());
        row.ocrText = improved.text;
        row.ocrConfidencePct = Math.round(improved.ocrConfidence * 100);
        row.rotationUsed = improved.rotationUsed;
        row.fields = improved.result.fields;
        row.ruleId = improved.result.ruleId;
        row.suggestedName = uniqueName(improved.result.nome) + '.pdf';
        row.confidence = improved.result.confidence;
        row.status = improved.result.confidence >= CONFIDENCE_THRESHOLD ? 'ok' : 'low';
        row.reviewed = true;
      } else if (improved){
        // revisão rodou mas não conseguiu identificar nada melhor — mantém o nome anterior editável
        row.ocrText = improved.text;
        row.ocrConfidencePct = Math.round(improved.ocrConfidence * 100);
        row.rotationUsed = improved.rotationUsed;
        row.reviewed = true;
        row.status = statusAntesDaRevisao;
      } else {
        // texto nativo (não veio de OCR) — nada a revisar
        row.reviewed = true;
        row.status = statusAntesDaRevisao;
      }
    } catch (err){
      console.error(err);
      row.reviewed = true;
      row.status = statusAntesDaRevisao;
    }
    done++;
    progressLabel.textContent = `Revisando ${done} de ${total} documento(s) de baixa confiança...`;
    progressFill.style.width = Math.round((done/total)*100) + '%';
    renderRow(row);
  }

  progressLabel.textContent = `Revisão concluída: ${total} documento(s) reprocessado(s).`;
  reorderTable();
  reviewBtn.disabled = false;
  clearBtn.disabled = false;
  downloadBtn.disabled = false;
  updateCount();
});

downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'GERANDO ZIP...';
  const zip = new JSZip();
  for (const row of items){
    if (row.status === 'processing') continue;
    zip.file(row.suggestedName, row.originalFile);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'documentos_renomeados.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  downloadBtn.disabled = false;
  downloadBtn.textContent = 'BAIXAR TODOS (.ZIP)';
});

// Fecha o lote atual: limpa a lista pra você começar um lote novo sem misturar com o que já foi baixado.
// Útil quando você digitaliza em levas grandes (ex.: 150 documentos) mas prefere processar/conferir em
// partes — depois de baixar o ZIP de uma parte, clique aqui antes de arrastar a próxima leva.
clearBtn.addEventListener('click', () => {
  if (items.length && !confirm('Limpar a lista atual? Isso não apaga o ZIP já baixado, só reseta a tela para um novo lote.')) return;
  items = [];
  usedNames = new Set();
  resultsBody.innerHTML = '';
  resultsTable.style.display = 'none';
  actionsBar.style.display = 'none';
  progressWrap.style.display = 'none';
  empty.style.display = 'block';
});

/* ============================================================
   EXPORTAR/IMPORTAR APRENDIZADO DE CONDOMÍNIOS
   ============================================================
   O aprendizado (botão "🎓 ensinar condomínio") fica salvo no localStorage, que é isolado por origem —
   ou seja, rodando o app localmente (file://) e depois hospedado (ex.: GitHub Pages, https://...) são
   dois "bancos" separados na visão do navegador. Esses dois botões deixam levar a lista aprendida de um
   ambiente pro outro (ou pra outro computador/navegador) via um arquivo .json.
   ============================================================ */

function updateLearnCount(){
  const n = learnedCondominios.length;
  learnCount.textContent = n === 0
    ? 'Nenhum condomínio aprendido manualmente ainda.'
    : `${n} condomínio(s) aprendido(s) manualmente (salvos neste navegador).`;
}

// Preenche o dropdown "este lote é de um condomínio só?" com a whitelist + os aprendidos, em ordem
// alfabética. Preserva a seleção atual (se ainda existir na lista) para não perder a escolha do usuário
// quando isso é chamado de novo depois de aprender um condomínio novo no meio do lote.
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
  URL.revokeObjectURL(url);
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
  } catch(e){
    alert('Não consegui ler esse arquivo como JSON válido. Ele precisa ser um arquivo exportado por este mesmo app.');
    return;
  }
  if (!Array.isArray(parsed)){
    alert('Formato inesperado: o arquivo deveria conter uma lista de condomínios.');
    return;
  }

  // Mescla com o que já existe (não substitui): mesmo nome de condomínio soma aliases em vez de duplicar.
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
  updateLearnCount();
  preencherLoteCondominioSelect();

  // Se já houver documentos pendentes na tela, tenta reidentificar com o aprendizado recém-importado.
  let melhoradas = 0;
  for (const r of items){
    if (r.status !== 'low' && r.status !== 'unidentified') continue;
    if (reprocessarLinha(r)){ melhoradas++; renderRow(r); }
  }
  if (melhoradas) reorderTable();

  alert(`Importado: ${novos} condomínio(s) novo(s), ${aliasesSomados} apelido(s) somado(s) aos existentes.${melhoradas ? `\n${melhoradas} documento(s) pendente(s) nesta tela foram reidentificados agora.` : ''}`);
});

updateLearnCount();
