// tests/renomeador.test.mjs
// Suíte de testes automatizados em Node (sem dependências externas, via node:test).
// Rodar com: node --test tests/renomeador.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Stub mínimo de localStorage para o rules-engine.js carregar em Node
globalThis.localStorage = {
  _map: new Map(),
  getItem(k){ return this._map.has(k) ? this._map.get(k) : null; },
  setItem(k, v){ this._map.set(k, String(v)); },
  removeItem(k){ this._map.delete(k); },
};

const { sanitizeFilename, stripPdfExt, ensurePdfExt, escapeHtml } = await import('../pdf-utils.js');
const {
  reserveUniqueName,
  releaseName,
  replaceReservedName,
  removeItemById,
  clearAllState,
  items,
  mergeQueueIds,
} = await import('../state.js');
const { identifyDocument, findData, findCondominioFallback, setLoteHintProvider, resolveZipMonthFolder } = await import('../rules-engine.js');
const { CONFIDENCE_THRESHOLD } = await import('../config.js');

const require = createRequire(import.meta.url);
const extractHandler = require('../api/extract.js');
const healthHandler = require('../api/health.js');
const condominiosHandler = require('../api/condominios.js');

test('pdf-utils: sanitizeFilename remove caracteres inválidos e barras (evita subpasta no ZIP)', () => {
  assert.equal(sanitizeFilename('NADA CONSTA VIVANT 101/102'), 'NADA CONSTA VIVANT 101.102');
  assert.equal(sanitizeFilename('FATURA: GAS* "TESTE"? <1>|2'), 'FATURA GAS TESTE 1 2');
  assert.equal(sanitizeFilename('   ...   '), 'DOCUMENTO');
  assert.equal(stripPdfExt('ARQUIVO.PDF'), 'ARQUIVO');
  assert.equal(ensurePdfExt('COMPROVANTE 05/08/2026'), 'COMPROVANTE 05.08.2026.pdf');
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('state: reserveUniqueName e releaseName liberam nomes corretamente (com ou sem .pdf)', () => {
  clearAllState();
  const n1 = reserveUniqueName('FATURA GAS VIVANT AGO 2026');
  const n2 = reserveUniqueName('FATURA GAS VIVANT AGO 2026');
  assert.equal(n1, 'FATURA GAS VIVANT AGO 2026.pdf');
  assert.equal(n2, 'FATURA GAS VIVANT AGO 2026 (2).pdf');

  // Libera o primeiro nome (passando com .pdf) e garante que pode ser reutilizado sem virar (3)
  releaseName(n1);
  const n3 = reserveUniqueName('FATURA GAS VIVANT AGO 2026');
  assert.equal(n3, 'FATURA GAS VIVANT AGO 2026.pdf');

  // Edição manual substitui a reserva anterior
  const renamed = replaceReservedName(n3, 'NOVO NOME: 10/08');
  assert.equal(renamed, 'NOVO NOME 10.08.pdf');
  assert.equal(reserveUniqueName('FATURA GAS VIVANT AGO 2026'), 'FATURA GAS VIVANT AGO 2026.pdf');

  clearAllState();
});

test('state: removeItemById remove de items, usedNames e mergeQueueIds', () => {
  clearAllState();
  const nome = reserveUniqueName('DOC TESTE');
  items.push({ id: 'a1', suggestedName: nome });
  mergeQueueIds.push('a1');

  removeItemById('a1');
  assert.equal(items.length, 0);
  assert.equal(mergeQueueIds.length, 0);
  assert.equal(reserveUniqueName('DOC TESTE'), 'DOC TESTE.pdf');
  clearAllState();
});

test('rules-engine: findData ignora valor monetário 0.00 e lê datas válidas', () => {
  assert.equal(findData('Total R$ 0.00').dataDDMM, null);
  const d1 = findData('Emitido em 14/08/2026');
  assert.equal(d1.dataDDMM, '14.08');
  assert.equal(d1.mes, 'AGO');
  assert.equal(d1.ano, '2026');

  const d2 = findData('Maceió, 05 de julho de 2026');
  assert.equal(d2.dataDDMM, '05.07');
  assert.equal(d2.mes, 'JUL');
  assert.equal(d2.ano, '2026');
});

test('rules-engine: findCondominioFallback tolera ruído de OCR (* e :)', () => {
  assert.equal(findCondominioFallback('CONDOMÍNIO EDIFÍCIO SOL NASCENTE * 123'), 'SOL NASCENTE');
  assert.equal(findCondominioFallback('Departamento: CONDOMINIO CERRO CATEDRAL Seção: PORTEIRO'), 'CERRO CATEDRAL');
});

test('rules-engine: detectores principais de DOCUMENT_TYPES', () => {
  setLoteHintProvider(() => null);

  // Protocolo de entrega (sem condomínio)
  const prot = identifyDocument('PROTOCOLO DE ENTREGA DE BOLETOS\nData: 08/08/2026', null);
  assert.equal(prot.ruleId, 'protocolo_entrega_boletos');
  assert.equal(prot.nome, 'PROTOCOLO 08.08');
  assert.ok(prot.confidence >= CONFIDENCE_THRESHOLD);

  // Continuação de protocolo de entrega sem cabeçalho (padrão real do lote de 420 PDFs)
  const protCont = identifyDocument('BOSSA NOVA BOLETO TAXA DE CONSUMO NOVEMBRO/2026 48 12/11/2026\nINNOVARE COMUNICADO SALÃO 12/11/2026', null);
  assert.equal(protCont.ruleId, 'protocolo_entrega_boletos');
  assert.equal(protCont.nome, 'PROTOCOLO 12.11');
  assert.equal(protCont.fields.ano, '2026');

  // Lista Proprietário/Locatário (Condomínio21 / PRO-LAR)
  const propLoc = identifyDocument('PRO-LAR ADMINISTRADORA\nPROTOCOLO\nCondomínio do Edifício Breezes\nReferência: TAXA DE CONDOMÍNIO - SETEMBRO/2026\nUnidade | Proprietário/Locatário | Correio', null);
  assert.equal(propLoc.ruleId, 'lista_proprietarios_taxa');
  assert.equal(propLoc.nome, 'PROTOCOLO BREEZES SETEMBRO');
  assert.ok(propLoc.confidence >= CONFIDENCE_THRESHOLD);

  // Equatorial fatura real vs demonstrativo que só cita Equatorial
  const eq = identifyDocument('EQUATORIAL ENERGIA\nCONDOMINIO VIVANT\nCONTA MÊS: 07/2026\nNÚMERO DA UC: 1020304567', null);
  assert.equal(eq.ruleId, 'fatura_energia_equatorial');
  assert.equal(eq.nome, 'FATURA EQUATORIAL VIVANT JUL 2026 UC4567');

  const demo = identifyDocument('DEMONSTRATIVO DE RECEITAS E DESPESAS\nCONDOMINIO VIVANT\nEQUATORIAL ENERGIA - CONTA MES 07/2026', null);
  assert.notEqual(demo.ruleId, 'fatura_energia_equatorial');

  // Extrato Caixa com "MALO" (erro comum de OCR de Maio) e "SAC CAIXA"
  const caixa = identifyDocument('SAC CAIXA\nExtrato por Período\nCliente: DOM PIETRO\nMês: Malo/2026', null);
  assert.equal(caixa.ruleId, 'extrato_conta_corrente');
  assert.equal(caixa.nome, 'EXTRATO DOM PIETRO MAI 2026');

  // DARF
  const darf = identifyDocument('DOCUMENTO DE ARRECADACAO DE RECEITAS FEDERAIS\nCONDOMINIO PALAZZO FIRENZE\nVencimento: 20/08/2026', null);
  assert.equal(darf.ruleId, 'darf_receita_federal');
  assert.equal(darf.nome, 'DARF PALAZZO FIRENZE 20.08');
});

test('rules-engine: corte duro sem condomínio e uso da dica de lote', () => {
  setLoteHintProvider(() => null);
  const semCondo = identifyDocument('DOCUMENTO DE ARRECADACAO DE RECEITAS FEDERAIS\nVencimento: 20/08/2026', null);
  assert.ok(semCondo.confidence < CONFIDENCE_THRESHOLD);

  setLoteHintProvider(() => 'VIVANT');
  const comLote = identifyDocument('DOCUMENTO DE ARRECADACAO DE RECEITAS FEDERAIS\nVencimento: 20/08/2026', null);
  assert.equal(comLote.nome, 'DARF VIVANT 20.08');
  assert.ok(comLote.confidence >= CONFIDENCE_THRESHOLD);
  setLoteHintProvider(() => null);
});

test('rules-engine: resolveZipMonthFolder organiza em pastas MES.AAAA ou SEM DATA', () => {
  // Mês e ano direto no nome sugerido
  assert.equal(resolveZipMonthFolder({ suggestedName: 'FATURA EQUATORIAL VIVANT OUT 2026 UC4567.pdf' }), 'OUT.2026');
  // DD.MM no nome + ano nos campos ou no texto OCR
  assert.equal(resolveZipMonthFolder({ suggestedName: 'DARF VIVANT 20.11.pdf', fields: { ano: '2026' } }), 'NOV.2026');
  // DD.MM no nome + ano vindo do timestamp do scanner no arquivo original
  assert.equal(resolveZipMonthFolder({ suggestedName: 'PROTOCOLO 08.10.pdf', originalName: 'doc11122420260925135247.pdf' }), 'OUT.2026');
  // Edição manual no nome tem prioridade sobre fields antigos
  assert.equal(resolveZipMonthFolder({ suggestedName: 'RECIBO VIVANT 15.11.2026.pdf', fields: { mes: 'OUT', ano: '2026' } }), 'NOV.2026');
  // Campos da IA (mesAno / data)
  assert.equal(resolveZipMonthFolder({ suggestedName: 'COMPROVANTE VIVANT.pdf', fields: { data: '05/12/2026' } }), 'DEZ.2026');
  assert.equal(resolveZipMonthFolder({ suggestedName: 'EXTRATO VIVANT.pdf', fields: { mesAno: 'AGO/2026' } }), 'AGO.2026');
  // Mês por extenso no nome (lista_proprietarios_taxa)
  assert.equal(resolveZipMonthFolder({ suggestedName: 'PROTOCOLO VIVANT JULHO.pdf', fields: { ano: '2026' } }), 'JUL.2026');
  // Sem nenhuma data identificável
  assert.equal(resolveZipMonthFolder({ suggestedName: 'PROTOCOLO RESERVA VIVANT.pdf', fields: {} }), 'SEM DATA');
});

test('api/extract.js: CORS para domínio customizado, métodos e autenticação', async () => {
  const prevSecret = process.env.RENOMEADOR_SHARED_SECRET;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.RENOMEADOR_SHARED_SECRET = 'segredo-teste-123';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';

  function mockRes(){
    const headers = {};
    let statusCode = 200;
    let body = null;
    return {
      setHeader(k, v){ headers[k] = v; },
      status(code){ statusCode = code; return this; },
      json(obj){ body = obj; return this; },
      end(){ return this; },
      get result(){ return { statusCode, headers, body }; },
    };
  }

  try {
    // OPTIONS do domínio customizado (CNAME)
    const rOpt = mockRes();
    await extractHandler({ method: 'OPTIONS', headers: { origin: 'https://renomeador.carnauba.dev.br' } }, rOpt);
    assert.equal(rOpt.result.statusCode, 204);
    assert.equal(rOpt.result.headers['Access-Control-Allow-Origin'], 'https://renomeador.carnauba.dev.br');

    // Origem desconhecida não recebe Access-Control-Allow-Origin
    const rBadOrigin = mockRes();
    await extractHandler({ method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }, rBadOrigin);
    assert.equal(rBadOrigin.result.headers['Access-Control-Allow-Origin'], undefined);

    // GET bloqueado
    const rGet = mockRes();
    await extractHandler({ method: 'GET', headers: {} }, rGet);
    assert.equal(rGet.result.statusCode, 405);

    // Segredo errado -> 401
    const rAuth = mockRes();
    await extractHandler({ method: 'POST', headers: { 'x-renomeador-secret': 'errado' }, body: {} }, rAuth);
    assert.equal(rAuth.result.statusCode, 401);

    // Segredo certo sem imagem -> 400
    const rMissing = mockRes();
    await extractHandler({ method: 'POST', headers: { 'x-renomeador-secret': 'segredo-teste-123' }, body: {} }, rMissing);
    assert.equal(rMissing.result.statusCode, 400);
    assert.equal(rMissing.result.body.error, 'missing_image');

    // Same-origin em preview *.vercel.app é aceito automaticamente
    const rPreview = mockRes();
    await extractHandler({ method: 'OPTIONS', headers: { origin: 'https://renomeador-preview.vercel.app', host: 'renomeador-preview.vercel.app' } }, rPreview);
    assert.equal(rPreview.result.statusCode, 204);
    assert.equal(rPreview.result.headers['Access-Control-Allow-Origin'], 'https://renomeador-preview.vercel.app');

    // Health endpoint reporta provedor sem expor segredo
    const rHealth = mockRes();
    healthHandler({ method: 'GET', headers: {} }, rHealth);
    assert.equal(rHealth.result.statusCode, 200);
    assert.equal(rHealth.result.body.ok, true);
    assert.equal(rHealth.result.body.provider, 'anthropic');

    // /api/condominios bloqueia sem segredo e retorna 503 se SUPABASE_URL não configurado
    const rCondoUnauth = mockRes();
    await condominiosHandler({ method: 'GET', headers: {} }, rCondoUnauth);
    assert.equal(rCondoUnauth.result.statusCode, 401);

    const rCondoNoDb = mockRes();
    await condominiosHandler({ method: 'GET', headers: { 'x-renomeador-secret': 'segredo-teste-123' } }, rCondoNoDb);
    assert.equal(rCondoNoDb.result.statusCode, 503);
  } finally {
    if (prevSecret === undefined) delete process.env.RENOMEADOR_SHARED_SECRET;
    else process.env.RENOMEADOR_SHARED_SECRET = prevSecret;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
