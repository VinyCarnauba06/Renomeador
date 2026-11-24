// config.js
// Configuração de negócio: condomínios conhecidos, tipos de documento (regras aprendidas dos exemplos
// reais) e constantes globais do pipeline. Dado puro, sem lógica de orquestração.
//
// DOCUMENT_TYPES importa helpers de rules-engine.js (normalize, resolverCondominio, findData, etc.) porque
// os detectores precisam deles pra funcionar; rules-engine.js importa DOCUMENT_TYPES de volta (identifyDocument
// itera esse array). É um import circular entre os dois módulos, intencional e seguro: os helpers só são
// CHAMADOS de dentro dos closures test/extract/format/confidence, nunca no topo do módulo — nesse ponto o
// grafo de módulos ES já terminou de avaliar tudo, então as bindings estão inicializadas.
import { normalize, semEspacos, resolverCondominio, findData, mesPorNumero, findCondominio, findCondominioFallback, findTipoGenerico } from './rules-engine.js';

/* ============================================================
   CONFIGURAÇÃO — edite aqui para ensinar novos vocabulários
   ============================================================
   Calibrado a partir de 7 documentos reais digitalizados (protocolos de
   entrega de boletos, fichas de reserva de salão, termos de requisição
   com vistoria, e listas de proprietários). Todos eram PDFs só-imagem
   (sem texto pesquisável) e vários vinham rotacionados 90°.
*/

// Condomínios conhecidos. Adicione novos nomes aqui (maiúsculo, como devem aparecer no nome do arquivo).
// "aliases" são variações/erros de OCR que devem mapear para o nome canônico.
// Isto é só um atalho de alta confiança — se o condomínio não estiver na lista,
// o sistema ainda tenta extrair o nome do cabeçalho do documento (ver findCondominioFallback).
export const CONDOMINIOS = [
  { nome: "VIA VERDE",             aliases: ["VIA VERDE"] },
  { nome: "DOM PIETRO",             aliases: ["DOM PIETRO", "DOM PIETR0", "DOMPIETRO"] },
  { nome: "VIVANT",                 aliases: ["VIVANT"] },
  { nome: "MIRAGE",                 aliases: ["MIRAGE"] },
  { nome: "PEROLA MAR",             aliases: ["PEROLA MAR", "PÉROLA MAR", "PEROLAMAR"] },
  { nome: "ATMOSPHERA",             aliases: ["ATMOSPHERA", "ATMOSFERA"] },
  { nome: "GRAND FORTUNE",          aliases: ["GRAND FORTUNE"] },
  { nome: "NIRVANA",                aliases: ["NIRVANA"] },
  { nome: "ALAMEDAS DAS MANGABEIRAS", aliases: ["ALAMEDAS DAS MANGABEIRAS"] },
  { nome: "LIV RESIDENCE",          aliases: ["LIV RESIDENCE"] },
  { nome: "JARDINS DE PROVENCE",    aliases: ["JARDINS DE PROVENCE"] },
  { nome: "DUETTO",                 aliases: ["DUETTO"] },
  { nome: "BELIEVE",                aliases: ["BELIEVE"] },
  { nome: "HIT RESIDENCE",          aliases: ["HIT RESIDENCE"] },
  { nome: "MONT REALE",             aliases: ["MONT REALE"] },
  { nome: "MAISON DU VITRE",        aliases: ["MAISON DU VITRE"] },
  { nome: "PIAZZA D'ITALIA",        aliases: ["PIAZZA D'ITALIA", "PIAZZA D ITALIA", "PIAZZA DITALIA"] },
  { nome: "GRAND ROYALE",           aliases: ["GRAND ROYALE"] },
  { nome: "INNOVARE",               aliases: ["INNOVARE"] },
  { nome: "MARES DO SUL",           aliases: ["MARES DO SUL"] },
  { nome: "CARUMAN",                aliases: ["CARUMAN"] },
  { nome: "GRAND VERSAILLES",       aliases: ["GRAND VERSAILLES"] },
  { nome: "ONE RESIDENCE",          aliases: ["ONE RESIDENCE"] },
  { nome: "MAISON LA CONCORDE",     aliases: ["MAISON LA CONCORDE"] },
  { nome: "HENRI MATISSE",          aliases: ["HENRI MATISSE"] },
  { nome: "PALAZZO FIRENZE",        aliases: ["PALAZZO FIRENZE"] },
  { nome: "SILVIA REGINA",          aliases: ["SILVIA REGINA"] },
  // Documentos financeiros/administrativos (faturas, extratos, comprovantes) — segunda leva de exemplos
  { nome: "ARQUIPELAGO DO SOL",     aliases: ["ARQUIPELAGO DO SOL", "ARQUIPÉLAGO DO SOL", "ARQUIP DO SOL", "ARQUIP. DO SOL", "ARQ. DO SOL", "ARQ DO SOL", "LOT. ARQ. DO SOL", "LT ARQUIPELAGO DO SOL"] },
  { nome: "DON J DE SAN MARTIN",    aliases: ["DON J DE SAN MARTIN", "DON J SAN MARTIN", "EDIF DON J DE SAN MARTIN"] },
  { nome: "MAISON SAINT TROPEZ",    aliases: ["MAISON SAINT TROPEZ"] },
];

export const MESES = {
  "JANEIRO":"JAN","FEVEREIRO":"FEV","MARÇO":"MAR","MARCO":"MAR","ABRIL":"ABR","MAIO":"MAI","MALO":"MAI", // "MALO" = "Maio" com "i" lido como "l" (achado 13/ago, extrato Caixa)
  "JUNHO":"JUN","JULHO":"JUL","AGOSTO":"AGO","SETEMBRO":"SET","OUTUBRO":"OUT","NOVEMBRO":"NOV","DEZEMBRO":"DEZ"
};

export const CONFIDENCE_THRESHOLD = 0.7; // abaixo disso vira "⚠ CONFERIR" e entra na fila do botão "revisar baixa confiança"
export const MIN_TEXT_LEN_TO_SKIP_OCR = 20; // se o PDF já tiver texto pesquisável com pelo menos isso, não faz OCR

// ==== Extração via IA (backend serverless — a chave da Anthropic nunca fica no navegador) ====
// DOCUMENT_TYPES/CONDOMINIOS continuam sendo o caminho rápido (grátis, offline, determinístico) pros casos
// que já aprendemos. A IA entra só quando esse caminho não resolve: PDF só-imagem, condomínio fora da
// whitelist, tipo de documento nunca visto. Ver identifyDocumentSmart() em ai-extraction.js.
export const AI_EXTRACT_ENDPOINT = '/api/extract'; // same-origin no Vercel (pode ser sobrescrito na UI se hospedar separado)
export const AI_SECRET_STORAGE_KEY = 'renomeador_ai_secret_v1';
export const AI_ENABLED_STORAGE_KEY = 'renomeador_ai_enabled_v1';
export const AI_ENDPOINT_STORAGE_KEY = 'renomeador_ai_endpoint_v1';

// Regras cujo nome final NUNCA leva condomínio por design (ver comentários nas próprias regras em
// DOCUMENT_TYPES). Para todas as outras, condomínio ausente nunca pode resultar em auto-aceite: mesmo que
// tipo+data pontuem alto o bastante pra passar de CONFIDENCE_THRESHOLD sozinhos (ex.: "TERMO 08.08" sem
// condomínio já batia 0.75 e virava "✓ ALTA CONFIANÇA" sem chance de correção), o documento é o dado mais
// importante do nome do arquivo pra esse fluxo — por isso fica de fora do cálculo de score e vira um corte
// duro em identifyDocument() (ver rules-engine.js).
export const RULES_SEM_CONDOMINIO = new Set(['reservas_fim_de_semana', 'protocolo_entrega_boletos', 'comprovante_pagamento_consumo_sicredi']);

/* ============================================================
   TIPOS DE DOCUMENTO — regras de negócio aprendidas dos exemplos reais
   ============================================================
   Cada detector é avaliado em ordem; o primeiro cujo `test` retornar true
   decide o nome. São regras específicas (aprendidas de casos reais) antes
   de regras genéricas de fallback — quanto mais específico, maior prioridade.

   Para ensinar um novo tipo de documento: adicione um objeto novo neste
   array, na posição adequada (regras mais específicas primeiro).
*/
export const DOCUMENT_TYPES = [
  {
    // Planilha-mestre de reservas do fim de semana (várias linhas "TERMO", vários condomínios)
    id: "reservas_fim_de_semana",
    test: (norm) => /RESERVA\s+SAL[AÃ]O\s+DE\s+FESTA/.test(norm) && (norm.match(/\bTERMO\b/g) || []).length >= 3,
    extract: () => ({}),
    format: () => "RESERVAS FIM DE SEMANA",
    confidence: () => 0.9
  },
  {
    // Protocolo de entrega do setor de boletos (uma ou várias linhas de condomínio) — nome NUNCA leva condomínio.
    // Teste tolerante a ruído de OCR: aceita tanto o título completo quanto a combinação de cabeçalhos de
    // coluna típicos dessa tabela (CONDOMÍNIO/DESCRIÇÃO/ENVIADO/RECEBIDO), caso o título saia mal lido.
    id: "protocolo_entrega_boletos",
    test: (norm) => {
      const semEspacosNorm = semEspacos(norm);
      if (/PROTOCOLO\s+DE\s+ENTREGA/.test(norm) || semEspacosNorm.includes('PROTOCOLODEENTREGA')) return true;
      // A linha de título nem sempre sobrevive ao OCR (fonte pequena/rotacionada). O conjunto de
      // cabeçalhos de coluna sozinho já é uma "impressão digital" confiável desta tabela específica.
      if (/CONDOMINIO/.test(norm) && /DESCRI[CÇ][AÃ]O/.test(norm) && (/ENVIADO/.test(norm) || /RECEBIDO/.test(norm))) return true;
      // Páginas de continuação/verso da planilha do setor de boletos não repetem o cabeçalho — só trazem
      // linhas de "COMUNICADO SALÃO" e/ou múltiplas linhas "BOLETO TAXA DE CONDOMÍNIO/CONSUMO/EXTRA" + datas.
      if (norm.includes('COMUNICADO SALAO')) return true;
      const linhasBoleto = norm.match(/BOLETO\s+TAXA\s+(?:DE\s+(?:CONDOMINIO|CONSUMO)|EXTRA)|BOLETO\s+MULTA/g) || [];
      return linhasBoleto.length >= 2;
    },
    extract: (norm, raw) => {
      const d = findData(raw);
      return { dataDDMM: d.dataDDMM, mes: d.mes, ano: d.ano };
    },
    format: f => f.dataDDMM ? `PROTOCOLO ${f.dataDDMM}` : null,
    confidence: f => f.dataDDMM ? 0.9 : 0.35
  },
  {
    // Lista de proprietários/inquilinos/locatários usada como comprovante de entrega da taxa de condomínio
    // (cobre também o layout Condomínio21 / PRO-LAR: "PROTOCOLO ... Referência: TAXA DE CONDOMÍNIO - MÊS/AAAA ... Proprietário/Locatário").
    id: "lista_proprietarios_taxa",
    test: (norm) => /(LISTA\s+DE\s+PROPRIETARIOS|PROPRIETARIOS?\s*\/\s*(INQUILINOS?|LOCATARIOS?))/.test(norm) && /TAXA\s+DE\s+CONDOMINIO/.test(norm),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      // Nesta regra o nome final leva o mês por extenso (ex.: "JULHO"), não abreviado — é assim que aparece nos exemplos reais.
      const m = norm.match(/TAXA\s+DE\s+CONDOMINIO\s*[-–]?\s*([A-Z]+)\s*\/\s*(\d{4})/);
      const mesCompleto = m && MESES[m[1]] ? m[1] : null;
      return { condominio, mesCompleto, ano: m ? m[2] : null };
    },
    format: f => f.condominio && f.mesCompleto ? `PROTOCOLO ${f.condominio} ${f.mesCompleto}` : null,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mesCompleto ? 0.4 : 0)
  },
  {
    // Termo de requisição/responsabilidade COM vistoria estruturada (antes/depois da festa) — leva condomínio + data do uso.
    // Sinal específico: "VISTORIA ... NO DIA DD/MM/AAAA" ou seção "ANTES DA FESTA" — não basta a palavra "vistoria" aparecer solta
    // (pode ser só uma observação manuscrita em outro tipo de documento, como numa ficha de reserva).
    id: "termo_com_vistoria",
    test: (norm) => /VISTORIA[^.\n]{0,40}NO\s+DIA\s+\d{2}\D\d{2}\D\d{4}/.test(norm) || /ANTES\s+DA\s+FESTA/.test(norm),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      let m = raw.match(/NO\s+DIA\s+(\d{2}\D\d{2}\D\d{4})/i);
      const dataDDMM = m ? findData(m[1]).dataDDMM : findData(raw).dataDDMM;
      return { condominio, dataDDMM };
    },
    format: f => f.condominio && f.dataDDMM ? `TERMO ${f.condominio} ${f.dataDDMM}` : null,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Ficha de reserva / termo de requisição do salão de festas SEM vistoria estruturada — só protocolo + condomínio, sem data
    id: "protocolo_reserva_salao",
    test: (norm) => /(FICHA\s+DE\s+RESERVA|TERMO\s+DE\s+REQUISI[CÇ][AÃ]O)/.test(norm) && /SAL[AÃ]O\s+DE\s+FESTAS/.test(norm),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw) }),
    format: f => f.condominio ? `PROTOCOLO RESERVA ${f.condominio}` : null,
    confidence: f => f.condominio ? 0.85 : 0.3
  },
  {
    // Lista de proprietários usada como comprovante genérico (sem "taxa de condomínio" explícita) — protocolo + condomínio
    id: "lista_proprietarios_generico",
    test: (norm) => /(LISTA\s+DE\s+PROPRIETARIOS|PROPRIETARIOS?\s*\/\s*(INQUILINOS?|LOCATARIOS?))/.test(norm),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw) }),
    format: f => f.condominio ? `PROTOCOLO ${f.condominio}` : null,
    confidence: f => f.condominio ? 0.6 : 0.2
  },
  /* ---- Documentos financeiros/administrativos (faturas, extratos, comprovantes) ----
     Categoria totalmente diferente dos protocolos/termos: sem "regra de conferência" própria
     nos próprios documentos, o padrão de nome abaixo foi definido junto com o usuário. */
  /* Nas 8 regras financeiras abaixo, o `format` NUNCA devolve null: uma vez que o `test` reconhece a
     marca/sistema (Equatorial, Claro, Sicredi, cartório etc.), o documento fica "comprometido" com aquele
     tipo — mesmo que falte campo, ele gera um nome parcial (ex.: "FATURA EQUATORIAL" sozinho) com confiança
     baixa. Isso evita que uma extração mal-sucedida "escape" para uma regra genérica errada — foi assim que
     rodapés de nota fiscal eletrônica ("Protocolo de autorização: ...") viraram "PROTOCOLO {condomínio}"
     por engano em faturas de energia. As janelas de regex entre rótulo e valor (ex.: [\s\S]{0,25}?) são
     propositalmente largas, porque o OCR costuma inserir espaços/quebras de linha extras entre os dois. */
  {
    // Fatura de energia elétrica (Equatorial). O mesmo condomínio pode ter vários medidores/UCs
    // cobrados no mesmo mês — por isso o nome leva os 4 últimos dígitos da UC como diferenciador.
    id: "fatura_energia_equatorial",
    // Achado real num lote de 91 documentos (12/ago): um "DEMONSTRATIVO DE RECEITAS E DESPESAS" (relatório
    // administrativo PRO-LAR que apenas CITA a Equatorial como um item de despesa pago) casou com o teste
    // antigo (só `includes('EQUATORIAL')`) e virou "FATURA EQUATORIAL" por engano — mesmo problema que o
    // comentário acima já descreve para "Protocolo de autorização" de DANFE. Fatura de verdade sempre tem
    // "CONTA MÊS" ou "NÚMERO DA UC" impressos (são os próprios campos que o extract() já busca abaixo);
    // relatório administrativo que só cita o nome da concessionária, não.
    test: (norm) => norm.includes('EQUATORIAL')
      && (norm.includes('CONTA MES') || norm.includes('CONTA MÊS') || norm.includes('NUMERO DA UC') || norm.includes('NÚMERO DA UC'))
      && !norm.includes('DEMONSTRATIVO DE RECEITAS')
      && !norm.includes('DESPESAS POR GRUPO'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const contaMes = raw.match(/CONTA\s*M[EÊ]S[\s\S]{0,15}?(\d{2})\s*\/\s*(\d{4})/i);
      let mes = null, ano = null;
      if (contaMes){
        mes = mesPorNumero(contaMes[1]);
        ano = contaMes[2];
      } else {
        // fallback: se "Conta Mês" não sair no OCR (comum — o QR code no meio da fatura quebra o layout e o
        // texto entre o rótulo e o valor fica cheio de ruído), tenta de novo com janela bem mais larga antes
        // de desistir e cair pro vencimento.
        const contaMesLargo = raw.match(/CONTA\s*M[EÊ]S[\s\S]{0,60}?(\d{2})\s*\/\s*(\d{4})/i);
        if (contaMesLargo){
          mes = mesPorNumero(contaMesLargo[1]);
          ano = contaMesLargo[2];
        } else {
          // último recurso: vencimento (1 mês depois do consumo, mas melhor que nada)
          const venc = raw.match(/VENCIMENTO[\s\S]{0,40}?(\d{2})\D(\d{2})\D(\d{4})/i);
          if (venc){ mes = mesPorNumero(venc[2]); ano = venc[3]; }
        }
      }
      const uc = raw.match(/N[UÚ]MERO\s+DA\s+UC[\s\S]{0,10}?([\d.]{6,})/i);
      const ucDigits = uc ? uc[1].replace(/\D/g, '') : null;
      const ucSuffix = ucDigits ? ucDigits.slice(-4) : null;
      return { condominio, mes, ano, ucSuffix };
    },
    format: f => `FATURA EQUATORIAL${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}${f.ucSuffix ? ' UC' + f.ucSuffix : ''}`,
    confidence: f => (f.condominio ? 0.35 : 0.1) + (f.mes && f.ano ? 0.35 : 0) + (f.ucSuffix ? 0.2 : 0)
  },
  {
    // Fatura de gás encanado (ALGÁS/Gás de Alagoas) — mesmo princípio da fatura_energia_equatorial, mas o
    // rótulo de competência sai como "Mês/Anº: MM/AAAA" no OCR (o "o" de "Ano" costuma virar "º"). Achado
    // 13/ago numa fatura real da ALGÁS para o Palazzo Firenze — o texto em torno do QR code/tabela de
    // consumo sai bem ruidoso, mas "ALGAS", o rótulo de competência e o vencimento sobrevivem limpos.
    id: "fatura_gas_algas",
    test: (norm) => norm.includes('ALGAS') || (norm.includes('GAS NATURAL') && norm.includes('FATURA')),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      let mes = null, ano = null;
      const competencia = raw.match(/M[EÊ]S\s*\/\s*AN[OºO]?[\s\S]{0,10}?(\d{2})\s*\/\s*(\d{4})/i);
      if (competencia){
        mes = mesPorNumero(competencia[1]);
        ano = competencia[2];
      } else {
        const venc = raw.match(/VENCIMENTO[\s\S]{0,20}?(\d{2})\D(\d{2})\D(\d{2,4})/i);
        if (venc){
          mes = mesPorNumero(venc[2]);
          ano = venc[3].length === 2 ? '20' + venc[3] : venc[3];
        }
      }
      return { condominio, mes, ano };
    },
    format: f => `FATURA GAS${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Fatura de água/esgoto (AMBIENTAL - concessionária de saneamento da região metropolitana de Maceió).
    // Achado 13/ago numa digitalização de baixíssima qualidade (texto quase todo ilegível) — mesmo assim o
    // nome da concessionária e o rótulo "COND" antes do nome do condomínio sobrevivem limpos o bastante,
    // então vale reconhecer o tipo mesmo quando a data não sai (confiança cai, mas evita "não identificado").
    id: "fatura_agua_ambiental",
    test: (norm) => norm.includes('AMBIENTAL') && (norm.includes('AGUA') || norm.includes('ESGOTO')),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw), ...findData(raw) }),
    format: f => `FATURA AGUA${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // Fatura de telecom (Claro Empresas) — usa o mês/ano do vencimento (não há "mês de referência" impresso).
    id: "fatura_telecom_claro",
    test: (norm) => /CLARO[\s\-]*EMPRESAS/.test(norm),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const m = raw.match(/VENCIMENTO[\s\S]{0,20}?(\d{2}\D\d{2}\D\d{4})/i);
      const d = m ? findData(m[1]) : { mes: null, ano: null };
      return { condominio, mes: d.mes, ano: d.ano };
    },
    format: f => `FATURA CLARO${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Comprovante de pagamento via Pix (qualquer banco) — usa a data em que a transação foi realizada.
    // Achado no lote de 91 (12/ago): a variante Sicoob ("COMPROVANTE DE EFETIVAÇÃO DE PAGAMENTO PIX") usa
    // o rótulo "Data do pagamento" em vez de "Realizado em" — adicionado como rótulo alternativo de data,
    // mantendo os dois exigidos juntos no teste (evita casar com qualquer menção solta a "pagamento pix"
    // dentro de um extrato genérico, que teria linhas de PIX sem nenhum desses rótulos de data ao lado).
    id: "comprovante_pix",
    test: (norm) => (/PAGAMENTO\s+PIX/.test(norm) || semEspacos(norm).includes('PAGAMENTOPIX'))
      && (/REALIZADO\s+EM/.test(norm) || semEspacos(norm).includes('REALIZADOEM') || /DATA\s+D[OE]\s+PAGAMENTO/.test(norm)),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      let m = raw.match(/REALIZADO\s+EM[\s\S]{0,15}?(\d{2}\D\d{2}\D\d{4})/i);
      if (!m) m = raw.match(/DATA\s+D[OE]\s+PAGAMENTO[\s\S]{0,15}?(\d{2}\D\d{2}\D\d{4})/i);
      const dataDDMM = m ? findData(m[1]).dataDDMM : null;
      return { condominio, dataDDMM };
    },
    format: f => `COMPROVANTE PIX${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Comprovante de pagamento de boleto (Sicredi/Caixa/Banco Cooperativo) — usa a data do pagamento,
    // extraída preferencialmente do campo PAGADOR (não do BENEFICIÁRIO, que é outra empresa/fornecedor).
    // Não exige "SICREDI" no texto — é logotipo estilizado e o OCR quase nunca lê. A frase "Pagamento de
    // Boleto(s)" já é específica o bastante sozinha. Singular incluído (12/ago): um comprovante Caixa Econômica
    // real saiu do OCR como "PAGAMENTO DE BOLETO BANCOS" — o "S" de "BOLETOS" tinha virado espaço antes de
    // "BANCOS", quebrando o teste que só aceitava o plural.
    id: "comprovante_boleto_sicredi",
    test: (norm) => /PAGAMENTO\s+DE\s+BOLETOS?\b/.test(norm) || semEspacos(norm).includes('PAGAMENTODEBOLETO'),
    extract: (norm, raw) => {
      // Nomes de condomínio às vezes quebram em 2 linhas no OCR (ex.: "MAISON SAINT\nTROPEZ") — captura
      // uma janela maior e deixa o normalize() (que colapsa quebras de linha) juntar de volta.
      const pagadorLine = raw.match(/PAGADOR[\s\S]{0,15}NOME[\s\S]{0,5}?([\s\S]{1,60})/i);
      let condominio = null;
      if (pagadorLine) condominio = findCondominio(normalize(pagadorLine[1])) || findCondominioFallback(pagadorLine[1]);
      if (!condominio) condominio = resolverCondominio(norm, raw);
      const m = raw.match(/DATA\s+D[OE]\s+PAGAMENTO[\s\S]{0,10}?(\d{2}\D\d{2}\D\d{4})/i);
      const dataDDMM = m ? findData(m[1]).dataDDMM : null;
      return { condominio, dataDDMM };
    },
    format: f => `COMPROVANTE BOLETO${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Extrato de conta corrente (sistema "Gerenciador Caixa") — usa o mês do período do extrato.
    id: "extrato_conta_corrente",
    // "GERENCIADOR" é logotipo estilizado da Caixa e o OCR quase nunca lê certo (saiu "GERENCIADQÃQ",
    // "GERENOADQR" em exemplos reais de 12/ago — mesma classe de problema que "SICREDI" já tinha em outras
    // regras). "SAC CAIXA"/"OUVIDORIA" são texto normal no rodapé do extrato e saem limpos do OCR mesmo
    // quando o topo da página está ruim, então servem de sinal alternativo tão confiável quanto o logotipo.
    test: (norm) => (norm.includes('GERENCIADOR') || norm.includes('SAC CAIXA') || norm.includes('OUVIDORIA'))
      && (/EXTRATO\s+POR\s+PER[IÍ]ODO/.test(norm) || semEspacos(norm).includes('EXTRATOPORPERIODO')),
    extract: (norm, raw) => {
      const cliente = raw.match(/CLIENTE[\s\S]{0,5}?([^\n]+)/i);
      let condominio = cliente ? (findCondominio(normalize(cliente[1])) || findCondominioFallback(cliente[1])) : null;
      if (!condominio) condominio = resolverCondominio(norm, raw);
      const m = raw.match(/M[EÊ]S[\s\S]{0,5}?([A-Zà-úÀ-Ú]+)\s*\/\s*(\d{4})/i);
      const mes = m && MESES[normalize(m[1])] ? MESES[normalize(m[1])] : null;
      const ano = m ? m[2] : null;
      return { condominio, mes, ano };
    },
    format: f => `EXTRATO${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Extrato de aplicação/investimento (Sicredi) — usa o mês/ano do período de consulta.
    // Idem: não depende de "SICREDI" (logotipo). "Extrato de Aplicação" + "Depósito a Prazo" juntos já bastam.
    id: "extrato_aplicacao_sicredi",
    test: (norm) => (/EXTRATO\s+DE\s+APLICA[CÇ][AÃ]O/.test(norm) || semEspacos(norm).includes('EXTRATODEAPLICACAO'))
      && (/DEP[OÓ]SITO\s+A\s+PRAZO/.test(norm) || semEspacos(norm).includes('DEPOSITOAPRAZO')),
    extract: (norm, raw) => {
      const associado = raw.match(/ASSOCIADO[\s\S]{0,5}?([^\n]+)/i);
      let condominio = associado ? (findCondominio(normalize(associado[1])) || findCondominioFallback(associado[1])) : null;
      if (!condominio) condominio = resolverCondominio(norm, raw);
      const m = raw.match(/PER[IÍ]ODO\s+DE\s+CONSULTA[\s\S]{0,10}?(\d{2})\s*\/\s*(\d{4})/i);
      const mes = m ? mesPorNumero(m[1]) : null;
      const ano = m ? m[2] : null;
      return { condominio, mes, ano };
    },
    format: f => `EXTRATO APLICACAO${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Extrato "Captação Remunerada" (Sicoob) — variante de extrato de aplicação com rótulos diferentes do
    // extrato_aplicacao_sicredi acima ("Captação Remunerada"/"Extrato Consolidado" em vez de "Extrato de
    // Aplicação"/"Depósito a Prazo", e "PERÍODO: MÊS/ANO" em vez de "Período de consulta"). Achado 12/ago
    // com texto de OCR limpo (condomínio e período 100% legíveis), não é regra especulativa.
    id: "extrato_captacao_sicoob",
    test: (norm) => norm.includes('CAPTACAO REMUNERADA'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const m = raw.match(/PER[IÍ]ODO:?\s*([A-Za-zà-úÀ-Ú]+)\s*\/\s*(\d{4})/i);
      const mes = m && MESES[normalize(m[1])] ? MESES[normalize(m[1])] : null;
      const ano = m ? m[2] : null;
      return { condominio, mes, ano };
    },
    format: f => `EXTRATO CAPTACAO${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Extrato de conta corrente do Internet Banking Sicredi ("Associado: X ... Extrato ... Dados referentes
    // ao período DD/MM/AAAA a DD/MM/AAAA") — diferente do extrato_conta_corrente (Caixa/Gerenciador) e do
    // extrato_aplicacao_sicredi (conta de investimento/depósito a prazo): este é o extrato de movimentação
    // da conta corrente do próprio associado. Achado 13/ago em 4 exemplos reais do mesmo lote. Usa o mês
    // final do período como referência (o extrato normalmente cobre um único mês corrido).
    // O rótulo "Dados/Dadas referentes ao período" costuma sair bem mal do OCR (achado real: "iefef-L-r-tei
    // ao panini-:." para "referentes ao período") — não é confiável como parte do teste. "Associado" +
    // "Extrato" juntos já são específicos o bastante desse template do Internet Banking Sicredi.
    id: "extrato_conta_corrente_sicredi",
    test: (norm) => norm.includes('ASSOCIADO') && norm.includes('EXTRATO'),
    extract: (norm, raw) => {
      const associado = raw.match(/ASSOCIADO\s*:?\s*([^\n]+)/i);
      let condominio = associado ? (findCondominio(normalize(associado[1])) || findCondominioFallback(associado[1])) : null;
      if (!condominio) condominio = resolverCondominio(norm, raw);
      // "DD/MM/AAAA a DD/MM/AAAA" — usa a segunda data (fim do período) como referência do extrato. Grupos
      // capturados separadamente (não a string inteira) porque o separador da 2ª data às vezes não é uma
      // barra de verdade (achado real: "31/07i2025", o "/" lido como "i") — findData() exige um dos
      // separadores [/\-.] explicitamente, então repassar a string capturada pra ela falharia de novo.
      const periodo = raw.match(/\d{2}\D(\d{2})\D\d{4}\s*a\s*\d{2}\D(\d{2})\D(\d{4})/i);
      let mes = null, ano = null;
      if (periodo){ mes = mesPorNumero(periodo[2]); ano = periodo[3]; }
      else { const d = findData(raw); mes = d.mes; ano = d.ano; }
      return { condominio, mes, ano };
    },
    format: f => `EXTRATO${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Comprovante de pagamento por débito automático (Internet Banking Sicredi) — cobrança recorrente
    // debitada direto da conta do condomínio (ex.: seguradora, concessionária). Achado 13/ago num
    // comprovante da Tokio Marine Seguradora. Usa a "Data de pagamento" (preferível à "Data de vencimento",
    // que pode ser alguns dias antes se o débito atrasar).
    id: "comprovante_debito_automatico_sicredi",
    test: (norm) => (norm.includes('DEBITO AUTOMATICO') || semEspacos(norm).includes('DEBITOAUTOMATICO')) && norm.includes('ASSOCIADO'),
    extract: (norm, raw) => {
      const associado = raw.match(/ASSOCIADO\s*:?\s*([^\n]+)/i);
      let condominio = associado ? (findCondominio(normalize(associado[1])) || findCondominioFallback(associado[1])) : null;
      if (!condominio) condominio = resolverCondominio(norm, raw);
      let m = raw.match(/DATA\s+DE\s+PAGAMENTO[\s\S]{0,10}?(\d{2}\D\d{2}\D\d{4})/i);
      if (!m) m = raw.match(/DATA\s+DE\s+VENCIMENTO[\s\S]{0,10}?(\d{2}\D\d{2}\D\d{4})/i);
      const dataDDMM = m ? findData(m[1]).dataDDMM : null;
      return { condominio, dataDDMM };
    },
    format: f => `COMPROVANTE DEBITO AUTOMATICO${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Certidão de Regularidade do FGTS (CRF) — Caixa Econômica Federal. Usa a data inicial do período de
    // validade como referência (a "Informação obtida em" é só o timestamp da consulta, não do documento).
    id: "certidao_fgts",
    test: (norm) => norm.includes('CERTIFICADO DE REGULARIDADE') && norm.includes('FGTS'),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw), ...findData(raw) }),
    format: f => `CERTIDAO FGTS${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // Certidão Negativa de Débitos Trabalhistas (CNDT) — Justiça do Trabalho. Usa a data de expedição.
    id: "certidao_cndt",
    test: (norm) => norm.includes('DEBITOS TRABALHISTAS'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      let m = raw.match(/EXPEDI[CÇ][AÃ]O[\s\S]{0,10}?(\d{2}\D\d{2}\D\d{4})/i);
      const dataDDMM = m ? findData(m[1]).dataDDMM : findData(raw).dataDDMM;
      return { condominio, dataDDMM };
    },
    format: f => `CERTIDAO TRABALHISTA${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Informativo mensal de aplicação CDB (Caixa) — extrato de rendimento de investimento do condomínio.
    // Usa o mês/ano de referência impresso no topo (coluna "Mês"), igual ao recibo_pagamento_salario.
    id: "informativo_cdb_caixa",
    test: (norm) => norm.includes('INFORMATIVO MENSAL') && norm.includes('CDB'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const comp = normalize(raw).match(/\b([A-Z]+)\/(\d{4})\b/);
      const mes = comp && MESES[comp[1]] ? MESES[comp[1]] : null;
      const ano = comp ? comp[2] : null;
      return { condominio, mes, ano };
    },
    format: f => `INFORMATIVO CDB${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Recibo de cartório — usa a data por extenso do rodapé ("Maceió - AL, ..., DD de MÊS de AAAA").
    id: "recibo_cartorio",
    test: (norm) => /CART[OÓ]RIO/.test(norm) && /RECIBO/.test(norm),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const dataDDMM = findData(raw).dataDDMM;
      return { condominio, dataDDMM };
    },
    format: f => `RECIBO CARTORIO${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Declarações emitidas por administradoras (ex.: PRO-LAR) — "Declaração de Nada Consta" e
    // "Declaração de Quitação" usam o mesmo layout de cabeçalho (Cond./Condomínio do Edifício X,
    // Unidade(s): N, Identificador: ...), mudando só o texto do título. Convenção de nome deduzida dos
    // próprios arquivos que o usuário já vinha renomeando manualmente: "nada consta" vira "NADA CONSTA
    // <condominio> <unidade>"; as demais declarações (quitação etc.) viram "DECLARACAO <condominio> <unidade>".
    id: "declaracao_condominio",
    test: (norm) => /DECLARA[CÇ][AÃ]O\s+DE/.test(norm) || norm.includes('NADA CONSTA'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const u = raw.match(/UNIDADE\(?S?\)?\s*:?\s*([\dA-Za-z\-\.\/]{1,10})/i);
      const unidade = u ? u[1].replace(/[.,;:]+$/, '') : null;
      const ehNadaConsta = norm.includes('NADA CONSTA');
      return { condominio, unidade, ehNadaConsta };
    },
    format: f => {
      if (!f.condominio) return null; // sem condomínio não dá pra montar um nome confiável — deixa cair pro genérico
      const prefixo = f.ehNadaConsta ? 'NADA CONSTA' : 'DECLARACAO';
      return `${prefixo} ${f.condominio}${f.unidade ? ' ' + f.unidade : ''}`;
    },
    confidence: f => (f.condominio ? 0.5 : 0.1) + (f.unidade ? 0.3 : 0) + 0.1
  },
  {
    // Boleto de rateio interno do sistema "Recibo do Pagador" (ex.: Grand Bahama/Itaú) — um boleto por
    // unidade/lote, por isso o nome leva a "Unidade" impressa como diferenciador. Se a unidade não for
    // encontrada (campo mais sensível a ruído de OCR), a confiança cai para forçar conferência manual —
    // é melhor pedir revisão do que arriscar sobrescrever o boleto de outra unidade com o mesmo nome.
    // Teste tolerante: o layout de 2 colunas (Beneficiário | Unidade) às vezes faz o OCR intercalar texto
    // no meio de "Recibo do Pagador", então checa as palavras separadamente em vez de exigir frase inteira.
    id: "boleto_rateio_unidade",
    test: (norm) => norm.includes('RECIBO') && norm.includes('PAGADOR') && norm.includes('UNIDADE') && norm.includes('BENEFICIARIO'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      let m = raw.match(/RECIBO\s+DO\s+PAGADOR[\s\S]{0,30}?(\d{2})\s*\/\s*(\d{4})/i);
      let mes = m ? mesPorNumero(m[1]) : null;
      let ano = m ? m[2] : null;
      if (!mes || !ano){
        // fallback: usa o vencimento (o boleto costuma vencer no mês seguinte ao rateio, mas é melhor que nada)
        const venc = raw.match(/VENCIMENTO[\s\S]{0,20}?(\d{2})\D(\d{2})\D(\d{4})/i);
        if (venc){ mes = mesPorNumero(venc[2]); ano = venc[3]; }
      }
      // O código da unidade é curto (ex.: "CAYMAN ETA"). Se o que veio logo após "Unidade" for na verdade
      // o início do parágrafo do beneficiário (nome de associação, endereço), descarta — layout de 2
      // colunas confunde a ordem de leitura do OCR com frequência nesse tipo de documento.
      // Classe de caracteres inclui acentos — sem isso, "ASSOCIAÇÃO" cortava em "ASSOCIA" antes do filtro
      // de sanidade abaixo conseguir reconhecer a palavra inteira e descartá-la.
      const u = raw.match(/UNIDADE[\s\S]{0,10}?([A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 ]{1,24})/i);
      let unidade = u ? normalize(u[1]).trim() : null;
      // Se o trecho capturado contém (em qualquer posição, não só no início) uma dessas palavras, é o
      // parágrafo do beneficiário vazando pro campo errado, não um código de unidade de verdade.
      if (unidade && /ASSOCIA|CONDOMINIO|PROPRIETARIOS|MORADORES|LOTEAMENTO|BENEFICIARIO|\bRUA\b/.test(unidade)){
        unidade = null;
      }
      return { condominio, mes, ano, unidade };
    },
    format: f => `BOLETO RATEIO${f.condominio ? ' ' + f.condominio : ''}${f.unidade ? ' ' + f.unidade : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.35 : 0.1) + (f.mes && f.ano ? 0.35 : 0) + (f.unidade ? 0.2 : 0)
  },
  /* ---- Regras adicionadas a partir do lote real de 91 documentos testado em 12/ago ---- */
  {
    // Relatório administrativo "DESPESAS POR GRUPO E CLASSE" (sistema PRO-LAR). O condomínio aparece como
    // texto solto logo abaixo do título (ex.: "Maison Grand Versailles") — resolverCondominio já pega isso
    // via busca no texto inteiro, sem precisar de regex de posição. O diferenciador é o Grupo/Classe do
    // relatório (ex.: Extintores, Investimentos, Manutenção) — um mesmo condomínio/data gera vários desses
    // relatórios no mesmo lote (um por classe de despesa), por isso a categoria entra no nome.
    id: "relatorio_despesas_prolar",
    test: (norm) => norm.includes('DESPESAS POR GRUPO E CLASSE'),
    extract: (norm, raw) => {
      const condominio = resolverCondominio(norm, raw);
      const grupoM = raw.match(/Grupo:\s*([A-Za-zÀ-ÖØ-öø-ÿ\s]{2,30}?)\s*Classe/i);
      const classeM = raw.match(/Classe:\s*([A-Za-zÀ-ÖØ-öø-ÿ\s]{2,30}?)\s*(?:Fornecedor|[\n\r])/i);
      const generico = v => !v || ['TODOS', 'TODAS'].includes(normalize(v).trim());
      const classe = classeM ? classeM[1].trim() : null;
      const grupo = grupoM ? grupoM[1].trim() : null;
      const categoria = !generico(classe) ? classe : (!generico(grupo) ? grupo : null);
      return { condominio, categoria, ...findData(raw) };
    },
    format: f => `RELATORIO DESPESAS${f.condominio ? ' ' + f.condominio : ''}${f.categoria ? ' ' + f.categoria.toUpperCase() : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.condominio ? 0.4 : 0.1) + (f.categoria ? 0.2 : 0) + (f.dataDDMM ? 0.3 : 0) + 0.1
  },
  {
    // Relatório "Despesas Diversas" (variante do relatorio_despesas_prolar, título diferente e sem
    // Grupo/Classe — achado 13/ago). O condomínio aparece direto como "CONDOMINIO X" logo abaixo do título.
    id: "relatorio_despesas_diversas",
    test: (norm) => norm.includes('RELATORIO DE DESPESAS DIVERSAS'),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw), ...findData(raw) }),
    format: f => `RELATORIO DESPESAS${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // Recibo de pagamento de salário (folha de pagamento de funcionário do condomínio — porteiro, zelador
    // etc., sistema "Group Software"). Usa o mês/ano de competência impresso no topo (ex.: "JANEIRO/2026"),
    // não a data de admissão nem a de pagamento em si — é a referência que mais importa pro arquivo. O nome
    // do condomínio vem do campo "Departamento:", que às vezes cola direto no rótulo seguinte ("Seção:") sem
    // pontuação — por isso o corte de " SEÇÃO"/" SECAO" residual abaixo, além do fix geral de FIM_NOME_CONDOMINIO.
    id: "recibo_pagamento_salario",
    test: (norm) => norm.includes('RECIBO DE PAGAMENTO') && (norm.includes('SALARIO') || norm.includes('FUNCIONARIO')),
    extract: (norm, raw) => {
      let condominio = resolverCondominio(norm, raw);
      if (condominio) condominio = condominio.replace(/\s+SE[CÇ][AÃ]O$/i, '').trim();
      const comp = normalize(raw).match(/\b([A-Z]+)\/(\d{4})\b/);
      const mes = comp && MESES[comp[1]] ? MESES[comp[1]] : null;
      const ano = comp ? comp[2] : null;
      return { condominio, mes, ano };
    },
    format: f => `RECIBO PAGAMENTO${f.condominio ? ' ' + f.condominio : ''}${f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : ''}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + (f.mes && f.ano ? 0.4 : 0)
  },
  {
    // Comprovante Sicredi de "Pagamento de Contas de Consumo" (água/luz/etc. de terceiro pago via convênio) —
    // achado 13/ago numa conta da BRK Ambiental. Este layout nunca imprime o nome do condomínio (só dados da
    // empresa conveniada e do convênio bancário), então fica em RULES_SEM_CONDOMINIO — tipo+empresa+data já
    // bastam pra um nome útil, exigir condomínio aqui derrubaria toda vez à toa.
    id: "comprovante_pagamento_consumo_sicredi",
    test: (norm) => norm.includes('PAGAMENTO DE CONTAS DE CONSUMO'),
    extract: (norm, raw) => {
      const empresaM = raw.match(/NOME:\s*([^\n]+)/i);
      const empresa = empresaM ? empresaM[1].split(/[-–—]/)[0].trim() : null;
      return { empresa, ...findData(raw) };
    },
    format: f => `COMPROVANTE PAGAMENTO${f.empresa ? ' ' + f.empresa.toUpperCase() : ''}${f.dataDDMM ? ' ' + f.dataDDMM : ''}`,
    confidence: f => (f.empresa ? 0.5 : 0.15) + (f.dataDDMM ? 0.4 : 0)
  },
  {
    // Recibo avulso sem layout formal de boleto/cartório — prestadores pequenos (dedetização, extintor,
    // retirada de entulho) e recibos "Recebi(emos) de" do sistema PRO-LAR. Sinal: frase "RECEBI(EMOS)
    // DO/DE ..." — não depende da palavra "RECIBO" aparecer (vários exemplos reais do lote de 91 nem
    // imprimem essa palavra, só "RECEBI DO CONDOMÍNIO X..."). Fica por último entre as regras financeiras
    // porque o sinal é genérico o bastante pra não competir com boleto_rateio_unidade/recibo_cartorio, que
    // são mais específicos e já tiveram sua chance antes desta na lista.
    // Achado 13/ago: "Recebi (emos) de" com o "o" de "emos" lido como "º" pelo OCR ("(EMºS)") não casava
    // com o "(\(EMOS\))?" literal antigo — a janela livre [\s\S]{0,15}? no lugar do grupo exato tolera
    // qualquer ruído entre "Recebi/Recebemos" e o "do/de" que vem depois, sem depender do texto exato do
    // parêntese. Também cobre o título alternativo "RECIBO DE PRESTAÇÃO DE SERVIÇOS" (sem a frase "recebi de"
    // em lugar nenhum do documento — o condomínio aparece só como "Destinatário:", que os rótulos padrão de
    // findCondominioFallback já não cobrem, mas o "EDF."/"ED"/etc dentro do valor capturado ainda funciona).
    // Terceiro gatilho (13/ago): recibo/vale de ressarcimento avulso ("A quantia/importância de R$ X...
    // referente a...") — modelo antigo de recibo escrito à mão ou em formulário simples, sem "recebi(emos)"
    // nem título "RECIBO" impresso. Achado num vale de ressarcimento de material hidráulico.
    id: "recibo_generico",
    test: (norm) => /RECEB(I|EMOS)[\s\S]{0,15}?\b(DO|DE)\b/.test(norm) || norm.includes('RECIBO DE PRESTACAO DE SERVICO')
      || /A\s+IMPORT[AÂ]NCIA\s+DE/.test(norm),
    extract: (norm, raw) => {
      let condominio = resolverCondominio(norm, raw);
      if (!condominio){
        const dest = raw.match(/DESTINAT[AÁ]RIO[\s\S]{0,5}?([^\n]+)/i);
        if (dest) condominio = findCondominio(normalize(dest[1])) || findCondominioFallback(dest[1]);
      }
      return { condominio, ...findData(raw) };
    },
    format: f => `RECIBO${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // Nota de cobrança/débito formal de prestador de serviço com contrato (manutenção de elevador,
    // NFS-e de prefeitura etc.) — identificada pelo rótulo padrão "Tomador de Serviço(s)" que empresas
    // prestadoras e sistemas de nota fiscal eletrônica usam pra identificar o cliente (aqui, o condomínio).
    // Achado 12/ago numa nota da OTIS Elevadores ("Tomador de Serviços: COND ED REVENANT NERI") — o mesmo
    // rótulo também aparece nas NFS-e da Prefeitura de Marechal Deodoro do mesmo lote, então cobre as duas.
    id: "nota_cobranca_tomador_servico",
    test: (norm) => /TOMADOR\s+DE\s+SERVI[CÇ]OS?/.test(norm),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw), ...findData(raw) }),
    format: f => `NOTA COBRANCA${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // DARF (Documento de Arrecadação de Receitas Federais) — guia de recolhimento de tributo federal (INSS/CP
    // Patronal etc.) emitida pelo sistema SENDA. Achado 13/ago: "Receita Federal" some quase por completo no
    // OCR ("RECEIÍEI Federal de Receitas Federais"), mas o título "Documento de Arrecadação" sobrevive limpo
    // — sinal suficiente sozinho. Usa o vencimento (primeira data dd/mm/aaaa que aparece, logo após o CNPJ/
    // Razão Social) como referência.
    id: "darf_receita_federal",
    test: (norm) => norm.includes('DOCUMENTO DE ARRECADACAO'),
    extract: (norm, raw) => ({ condominio: resolverCondominio(norm, raw), ...findData(raw) }),
    format: f => `DARF${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // Boleto bancário genérico (ficha de compensação/recibo do pagador de qualquer banco/beneficiário) —
    // pega o layout padrão impresso em praticamente todo boleto brasileiro, quando nenhuma regra mais
    // específica (Sicredi, rateio por unidade etc.) reconheceu o sistema por trás. Achado 12/ago num boleto
    // Bradesco: o texto "PAGÁVEL PREFERENCIALMENTE" se repete 2-3x na página (via costumam imprimir a mesma
    // ficha em duplicata/triplicata) — mesmo que uma cópia saia com OCR ruim, as outras cobrem.
    // Segundo sinal (13/ago): boletos gerados por plataforma de cobrança (Pix + QR code, sem "ficha de
    // compensação" tradicional) não têm essa frase, mas sempre imprimem os 3 campos juntos — Beneficiário,
    // Pagador e Vencimento — o que já é uma assinatura confiável de boleto bancário nesse layout também.
    // Terceiro sinal (13/ago): ficha "Recibo do/de Pagador" do Banco do Brasil — mesmo layout do
    // boleto_rateio_unidade só que sem coluna de "Unidade" (não é rateio por lote). Achado com OCR bem ruim,
    // onde BENEFICIÁRIO/PAGADOR/VENCIMENTO saíram todos garbled ("Bulmnlw'lliº", "Fºam", "Vena/manto") mas o
    // título "Reclbo do Pagador"/"Recibo de Pagador" sobrevive (só a vogal do meio de "Recibo" varia: i↔l).
    // Quarto sinal (13/ago): fatura gerada por plataforma de cobrança tipo Asaas ("Olá, {condomínio} / Aqui
    // está seu boleto." + "Como realizar o pagamento:" + "Linha digitável") — nem tem BENEFICIÁRIO/PAGADOR
    // impressos, é um layout totalmente diferente (mensagem personalizada + linha digitável + QR code). A
    // linha "Olá, {condomínio}" é extraída primeiro porque é mais confiável que a busca genérica por rótulo
    // aqui (o nome vem sem nenhum rótulo tipo "CONDOMÍNIO"/"EDIFÍCIO" na frente sempre, só depois de "Olá,").
    id: "boleto_bancario_generico",
    test: (norm) => /PAG[AÁ]VEL\s+PREFERENCIALMENTE/.test(norm) || semEspacos(norm).includes('PAGAVELPREFERENCIALMENTE')
      || (norm.includes('BENEFICIARIO') && norm.includes('PAGADOR') && norm.includes('VENCIMENTO'))
      || /REC[IL]BO\s+D[OE]\s+(PAGADOR|SACADO)/.test(norm)
      || (norm.includes('COMO REALIZAR O PAGAMENTO') && norm.includes('LINHA DIGITAVEL')),
    extract: (norm, raw) => {
      const ola = raw.match(/OL[AÁ],?\s*([^\n]+)/i);
      let condominio = ola ? (findCondominio(normalize(ola[1])) || findCondominioFallback(ola[1])) : null;
      if (!condominio) condominio = resolverCondominio(norm, raw);
      return { condominio, ...findData(raw) };
    },
    format: f => `BOLETO${f.condominio ? ' ' + f.condominio : ''}${f.dataDDMM ? ' ' + f.dataDDMM : (f.mes && f.ano ? ' ' + f.mes + ' ' + f.ano : '')}`,
    confidence: f => (f.condominio ? 0.5 : 0.15) + ((f.dataDDMM || (f.mes && f.ano)) ? 0.4 : 0)
  },
  {
    // Genérico: PROTOCOLO/TERMO + condomínio + data completa
    id: "generico_tipo_condominio_data",
    test: (norm) => !!findTipoGenerico(norm),
    extract: (norm, raw) => ({
      tipo: findTipoGenerico(norm),
      condominio: resolverCondominio(norm, raw),
      ...findData(raw)
    }),
    format: f => {
      if (f.tipo && f.condominio && f.dataDDMM) return `${f.tipo} ${f.condominio} ${f.dataDDMM}`;
      if (f.tipo && f.condominio && f.mes && f.ano) return `${f.tipo} ${f.condominio} ${f.mes} ${f.ano}`;
      if (f.tipo && f.condominio) return `${f.tipo} ${f.condominio}`;
      if (f.tipo && f.dataDDMM) return `${f.tipo} ${f.dataDDMM}`;
      if (f.tipo && f.mes && f.ano) return `${f.tipo} ${f.mes} ${f.ano}`;
      if (f.tipo) return f.tipo;
      return null;
    },
    confidence: f => {
      let score = 0.3;
      if (f.tipo) score += 0.25;
      if (f.condominio) score += 0.2;
      if (f.dataDDMM || (f.mes && f.ano)) score += 0.2;
      return score;
    }
  }
];
