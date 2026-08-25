// rules-engine.js
// Motor de regras local (Tier 1): reconhece tipo de documento + condomínio a partir de texto (nativo do
// PDF ou de OCR), sem rede. Rápido, grátis e determinístico — mas fechado: só reconhece o que DOCUMENT_TYPES/
// CONDOMINIOS já ensinam. O que não bater aqui cai pra IA (ver ai-extraction.js) e, em último caso, pro OCR
// local (ver ocr-pipeline.js).
//
// Import circular com config.js: DOCUMENT_TYPES (definido lá) usa os helpers abaixo dentro dos seus
// test/extract; identifyDocument (definido aqui) itera DOCUMENT_TYPES. Seguro porque os helpers só são
// chamados de dentro de closures, nunca durante a avaliação do módulo em si — ver comentário equivalente
// em config.js.
import { CONDOMINIOS, DOCUMENT_TYPES, MESES, RULES_SEM_CONDOMINIO, CONFIDENCE_THRESHOLD } from './config.js';

// Dica de condomínio do lote inteiro: quando o usuário sabe de antemão que só está digitalizando documentos
// de UM condomínio, ele seleciona isso num dropdown antes de soltar os arquivos. Esse motor de regras não
// deve depender de DOM diretamente (precisa ficar testável em Node isolado) — por isso a UI injeta aqui só
// uma função que devolve o valor atual, em vez de este módulo ler o elemento `<select>` ele mesmo.
let loteHintProvider = () => null;
export function setLoteHintProvider(fn){
  loteHintProvider = typeof fn === 'function' ? fn : () => null;
}
function condominioDoLote(){
  return loteHintProvider() || null;
}

/* ============================================================
   EXTRAÇÃO DE CAMPOS A PARTIR DO TEXTO
   ============================================================ */

export function normalize(str){
  return str.toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'') // remove acentos p/ casar com mais tolerância
    .replace(/[\[\]{}|]/g, '') // remove ruído comum de OCR (colchetes/barras que não fazem parte do texto real)
    .replace(/\s+/g, ' '); // colapsa quebras de linha/espaços múltiplos — OCR quebra nomes/frases no meio a toda hora
}

// Versão sem nenhum espaço, para checar frases que o OCR às vezes gruda inteiras (ex.: "ExtratodeAplicação").
export function semEspacos(norm){
  return norm.replace(/[\s\-]+/g, '');
}

// Tipos genéricos de documento (fallback), usados apenas se nenhum detector específico casar.
export function findTipoGenerico(text){
  // "Protocolo de autorização" é rodapé padrão de toda nota fiscal eletrônica (DANFE) — não é o tipo de
  // documento "protocolo de entrega" que essa regra genérica tenta pegar. Se for a única ocorrência de
  // "PROTOCOLO" no texto, ignora, senão qualquer fatura/conta de consumo vira "PROTOCOLO" por engano.
  const semAutorizacao = text.replace(/PROTOCOLO\s+DE\s+AUTORIZA[CÇ][AÃ]O/g, '');
  if (semAutorizacao.includes("PROTOCOLO")) return "PROTOCOLO";
  if (text.includes("TERMO")) return "TERMO";
  if (text.includes("CONTAS A RECEBER")) return "CONTAS A RECEBER";
  return null;
}

// Aprendizado por correção manual: quando o usuário renomeia um documento de baixa confiança/não
// identificado indicando o condomínio, guardamos esse nome (e o trecho do cabeçalho que apareceu no
// OCR) para reconhecer automaticamente da próxima vez. Fica só no navegador (localStorage) — nada sai
// da máquina do usuário, e continua funcionando em sessões futuras no mesmo computador.
const LEARNED_CONDOS_KEY = 'renomeador_condominios_aprendidos_v1';

function loadLearnedCondominios(){
  try {
    const raw = localStorage.getItem(LEARNED_CONDOS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch(e){ return []; }
}

export function saveLearnedCondominios(){
  try { localStorage.setItem(LEARNED_CONDOS_KEY, JSON.stringify(learnedCondominios)); } catch(e){ /* localStorage indisponível — segue só na memória desta sessão */ }
}

export let learnedCondominios = loadLearnedCondominios();

// Registra (ou complementa) um condomínio aprendido manualmente. `nome` é o nome final que deve
// aparecer no arquivo; `aliasSugerido` é o trecho reconhecido no cabeçalho do documento (pode ser null
// se o OCR não deu pista nenhuma — nesse caso o nome vira alias de si mesmo).
export function aprenderCondominio(nome, aliasSugerido){
  nome = (nome || '').trim().toUpperCase();
  if (!nome) return;
  let entry = learnedCondominios.find(c => c.nome === nome);
  if (!entry){
    entry = { nome, aliases: [nome] };
    learnedCondominios.push(entry);
  }
  const alias = (aliasSugerido || '').trim().toUpperCase();
  if (alias && !entry.aliases.includes(alias)) entry.aliases.push(alias);
  saveLearnedCondominios();
}

export function todosCondominios(){
  return CONDOMINIOS.concat(learnedCondominios);
}

export function findCondominio(text){
  const lista = todosCondominios();
  for (const c of lista){
    for (const alias of c.aliases){
      if (text.includes(normalize(alias))) return c.nome;
    }
  }
  // Segunda passada tolerante a espaço: o OCR às vezes gruda o nome inteiro sem espaços
  // (ex.: "MAISONSAINTTROPEZ"). Compara a versão sem espaços dos dois lados.
  const semEspacosText = semEspacos(text);
  for (const c of lista){
    for (const alias of c.aliases){
      if (semEspacosText.includes(semEspacos(normalize(alias)))) return c.nome;
    }
  }
  return null;
}

// Fim de captura do nome do condomínio no cabeçalho: quebra de linha, 2+ espaços, número isolado (quase
// sempre apartamento/telefone/código vazando da linha seguinte), espaço seguido de símbolo de ruído de OCR
// (achado 13/ago: um "*" solto do formulário bancário grudava a captura, impedindo o "\n" seguinte de ser
// alcançado porque "*" não é letra/espaço/dígito e travava o character class do grupo de captura antes de
// chegar lá), fim de string, ou pontuação de corte.
// ":" solto (sem espaço antes, ex.: "Seção:" colado no rótulo seguinte) também corta — achado 13/ago num
// recibo de pagamento de salário: "Departamento: CONDOMINIO CERRO CATEDRAL Seção: PORTEIRO..." só tinha um
// espaço simples entre o nome e o próximo rótulo, sem símbolo/dígito ali pra disparar as alternativas acima.
const FIM_NOME_CONDOMINIO = '(?:[\\n\\r]|\\s{2,}|\\s\\d|\\s[^A-Za-zÀ-ÖØ-öø-ÿ0-9\\s]|:|$|\\.|,|-|—)';

// Lista de rótulos que costumam preceder o nome do condomínio no cabeçalho do documento — da forma mais
// específica/confiável pra mais curta/ambígua. A ordem importa: um rótulo curto ("ED", "CON") só é tentado
// se nenhum rótulo mais longo e específico casou antes, porque sozinho é fácil de disparar em falso.
// Cada entrada é só o texto do rótulo (sem acento — a função monta a variante COM e SEM acento e com/sem
// ponto sozinha) mais uma flag dizendo se a própria palavra do rótulo faz parte do nome final (é o caso de
// "RESIDENCIAL"/"EMPRESARIAL" quando aparecem soltos — muitos condomínios têm isso no nome de verdade, ex.
// "LIV RESIDENCE" já cadastrado na whitelist) ou se é só uma palavra administrativa a pular (CONDOMÍNIO,
// COND, EDF, ED, CON).
const CONDOMINIO_LABELS = [
  { label: 'CONDOMINIO DO EDIFICIO' },
  { label: 'CONDOMINIO EDIFICIO' },
  { label: 'COND DO EDIFICIO' },
  { label: 'COND EDIFICIO' },
  { label: 'COND DO EDIF' }, // abreviação de 4 letras: "Cond. do Edif. X"
  { label: 'COND EDIF' },
  { label: 'EDIFICIO RESIDENCIAL', manterRotuloNoNome: 'RESIDENCIAL' },
  { label: 'EDIFICIO EMPRESARIAL', manterRotuloNoNome: 'EMPRESARIAL' },
  { label: 'EDIFICIO' },
  { label: 'EDIF' }, // abreviação de 4 letras sozinha
  { label: 'EDF' },  // abreviação de 3 letras sozinha (diferente de EDIF)
  { label: 'ED RESIDENCIAL', manterRotuloNoNome: 'RESIDENCIAL' },
  { label: 'ED EMPRESARIAL', manterRotuloNoNome: 'EMPRESARIAL' },
  { label: 'COND ED' },
  { label: 'ASSOCIADO' }, // rótulo de cooperativa de crédito (Sicredi/Sicoob), não é sobre tipo de prédio
  { label: 'CONDOMINIO' }, // "CONDOMÍNIO <nome>" direto, sem EDIFÍCIO/EDF no meio
  { label: 'RESIDENCIAL', manterRotuloNoNome: 'RESIDENCIAL' }, // bare, sem ED/EDIFÍCIO na frente
  { label: 'EMPRESARIAL', manterRotuloNoNome: 'EMPRESARIAL' },
  { label: 'COND' }, // abreviação de 4 letras sozinha, sem EDIFÍCIO/EDF/ED depois
  { label: 'ED' }, // 2 letras sozinha — o mais ambíguo de todos, por isso é o último
  { label: 'CON' }, // 3 letras sozinha — igualmente ambíguo, último recurso
];

// Monta a regex de um rótulo: aceita ponto opcional depois de cada palavra abreviada, e é insensível a
// acento porque compara contra rawText com a flag /i mas sem normalizar — então cada vogal acentuável do
// rótulo vira uma classe [VÁÀÂÃ] etc. (cobre "CONDOMÍNIO" e "CONDOMINIO", "EDIFÍCIO" e "EDIFICIO").
function regexDoRotulo(label){
  const acentos = { A: '[AÁÀÂÃ]', E: '[EÉÊ]', I: '[IÍ]', O: '[OÓÔÕ]', U: '[UÚ]' };
  const partes = label.split(' ').map(palavra => {
    const comAcento = palavra.split('').map(ch => acentos[ch] || ch).join('');
    return comAcento + '\\.?';
  });
  return new RegExp('\\b' + partes.join('\\s+') + '\\s+([A-Za-zÀ-ÖØ-öø-ÿ\'\\s]{2,40}?)' + FIM_NOME_CONDOMINIO, 'i');
}

// Fallback: quando o condomínio não está na whitelist, tenta extrair do cabeçalho do documento, testando
// CONDOMINIO_LABELS em ordem até um bater. Cobre "CONDOMÍNIO EDIFÍCIO X", "CONDOMÍNIO DO EDIFÍCIO X",
// "EDF. X", "COND. X", "Associado: X" etc. — com e sem acento, com e sem ponto de abreviação.
export function findCondominioFallback(rawText){
  for (const { label, manterRotuloNoNome } of CONDOMINIO_LABELS){
    const m = rawText.match(regexDoRotulo(label));
    if (!m) continue;
    const nome = m[1].trim();
    if (!nome) continue;
    return (manterRotuloNoNome ? manterRotuloNoNome + ' ' + nome : nome).trim().toUpperCase();
  }
  return null;
}

// Ponto único de resolução de condomínio usado por todos os detectores: tenta a whitelist, depois o
// cabeçalho do documento, e só por último a dica de lote (se houver).
export function resolverCondominio(norm, raw){
  return findCondominio(norm) || findCondominioFallback(raw) || condominioDoLote();
}

// Procura datas em formatos DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA, DD/MM, "05 de julho de 2026" etc.
export function findData(rawText){
  // dd/mm/aaaa ou dd-mm-aaaa ou dd.mm.aaaa
  let m = rawText.match(/\b([0-3]?\d)[\/\-\.]([0-1]?\d)[\/\-\.](\d{4}|\d{2})\b/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12){
    const dd = m[1].padStart(2,'0');
    const mm = m[2].padStart(2,'0');
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = '20' + yyyy;
    return { dataDDMM: `${dd}.${mm}`, mes: mesPorNumero(mm), ano: yyyy };
  }
  // dd/mm sem ano — dia/mês "00" (achado 13/ago: "0.00" de um valor monetário tipo "R$ 0.00" casando à toa
  // com esse padrão) é rejeitado aqui e cai pros fallbacks de mês/ano por extenso abaixo, em vez de virar
  // uma data fantasma "00.00" no nome do arquivo.
  m = rawText.match(/\b([0-3]?\d)[\/\-\.]([0-1]?\d)\b/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12){
    const dd = m[1].padStart(2,'0');
    const mm = m[2].padStart(2,'0');
    return { dataDDMM: `${dd}.${mm}`, mes: mesPorNumero(mm), ano: null };
  }
  // "05 de julho de 2026" / "5 DE JULHO DE 2026"
  const normText = normalize(rawText);
  m = normText.match(/\b([0-3]?\d)\s+DE\s+([A-Z]+)\s+DE\s+(\d{4})\b/);
  if (m){
    const dd = m[1].padStart(2,'0');
    const mesNome = m[2];
    const mes = MESES[mesNome] || null;
    const ano = m[3];
    if (mes){
      const mmNum = numeroPorMesAbrev(mes);
      return { dataDDMM: mmNum ? `${dd}.${mmNum}` : null, mes: mes, ano };
    }
  }
  // Só mês/ano por extenso: "JULHO DE 2026" / "JULHO/2026"
  m = normText.match(/\b([A-Z]+)\s*(?:DE|\/)\s*(\d{4})\b/);
  if (m && MESES[m[1]]){
    return { dataDDMM: null, mes: MESES[m[1]], ano: m[2] };
  }
  return { dataDDMM: null, mes: null, ano: null };
}

export function mesPorNumero(mm){
  const nums = {"01":"JAN","02":"FEV","03":"MAR","04":"ABR","05":"MAI","06":"JUN","07":"JUL","08":"AGO","09":"SET","10":"OUT","11":"NOV","12":"DEZ"};
  return nums[mm] || null;
}
function numeroPorMesAbrev(abrev){
  const map = {"JAN":"01","FEV":"02","MAR":"03","ABR":"04","MAI":"05","JUN":"06","JUL":"07","AGO":"08","SET":"09","OUT":"10","NOV":"11","DEZ":"12"};
  return map[abrev] || null;
}

// Campos "extra" apenas informativos (não entram no nome, mas aparecem na conferência)
export function findExtras(rawText){
  const extras = {};
  let m = rawText.match(/APTO?\.?\s*n?º?\s*[:\-]?\s*(\d{1,4}[A-Za-z]?)/i);
  if (m) extras.apartamento = m[1];
  m = rawText.match(/PROTOCOLO\s*n?º?\s*[:\-]?\s*(\d{2,8})/i);
  if (m) extras.numeroProtocolo = m[1];
  return extras;
}

// Roda os detectores de DOCUMENT_TYPES em ordem e devolve o primeiro que produzir um nome válido.
export function identifyDocument(rawText, ocrConfidence){
  const norm = normalize(rawText);
  const extras = findExtras(rawText);

  for (const docType of DOCUMENT_TYPES){
    if (!docType.test(norm)) continue;
    const fields = docType.extract(norm, rawText);
    const nome = docType.format(fields);
    if (!nome) continue; // detector reconheceu o tipo mas faltou campo obrigatório -> tenta o próximo (mais genérico)
    let confidence = docType.confidence(fields);
    if (ocrConfidence != null) confidence = confidence * (0.5 + 0.5 * ocrConfidence); // penaliza OCR ruim
    // Corte duro: sem condomínio resolvido, nunca deixa passar do limiar de auto-aceite, mesmo que
    // tipo+data sozinhos já somem confiança suficiente (ver RULES_SEM_CONDOMINIO acima).
    if (!fields.condominio && !RULES_SEM_CONDOMINIO.has(docType.id)){
      confidence = Math.min(confidence, CONFIDENCE_THRESHOLD - 0.01);
    }
    confidence = Math.min(confidence, 1);
    return { nome, confidence, ruleId: docType.id, fields: { ...fields, ...extras } };
  }
  return { nome: null, confidence: 0, ruleId: null, fields: extras };
}
