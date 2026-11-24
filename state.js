// state.js
// Estado compartilhado da sessão (lista de documentos, reserva consistente de nomes únicos,
// fila de junção e provedor da dica de condomínio do lote). Sem dependência de DOM — permite
// eliminar o import circular entre ui.js e pdf-merge.js e facilita testes isolados.
import { sanitizeFilename, stripPdfExt } from './pdf-utils.js';

export const items = [];
export const usedNames = new Set(); // sempre armazena a BASE sem ".pdf", em UPPERCASE
export const mergeQueueIds = [];

let loteHintProvider = () => null;

export function setLoteHintProvider(fn){
  loteHintProvider = typeof fn === 'function' ? fn : () => null;
}

export function getLoteCondominio(){
  const val = loteHintProvider();
  return val ? String(val).trim() : null;
}

function nameKey(name){
  return sanitizeFilename(stripPdfExt(name)).toUpperCase();
}

// Reserva um nome único (sanitizado) e devolve já com ".pdf".
export function reserveUniqueName(base){
  const cleanBase = sanitizeFilename(stripPdfExt(base));
  let candidate = cleanBase;
  let n = 2;
  while (usedNames.has(candidate.toUpperCase())){
    candidate = `${cleanBase} (${n})`;
    n++;
  }
  usedNames.add(candidate.toUpperCase());
  return `${candidate}.pdf`;
}

// Libera a reserva de um nome previamente atribuído (aceita com ou sem ".pdf").
export function releaseName(name){
  if (!name) return;
  usedNames.delete(nameKey(name));
}

// Troca o nome de um item existente (edição manual): libera o nome antigo e reserva o novo.
export function replaceReservedName(oldName, newName){
  releaseName(oldName);
  const cleanBase = sanitizeFilename(stripPdfExt(newName));
  usedNames.add(cleanBase.toUpperCase());
  return `${cleanBase}.pdf`;
}

export function removeItemById(id){
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0){
    const [removed] = items.splice(idx, 1);
    if (removed && removed.suggestedName) releaseName(removed.suggestedName);
  }
  const qIdx = mergeQueueIds.indexOf(id);
  if (qIdx >= 0) mergeQueueIds.splice(qIdx, 1);
}

export function clearAllState(){
  items.length = 0;
  usedNames.clear();
  mergeQueueIds.length = 0;
}
