# Contexto — Renomeador de Documentos

> Cole este arquivo (ou peça pra Claude ler `C:\Dev\Renomeador\CONTEXTO_PROJETO.md`) no início do próximo chat pra retomar de onde parou.

## O que é
App client-side (PDF.js + Tesseract.js + JSZip + pdf-lib) que lê PDFs digitalizados de condomínio e sugere nome de arquivo padronizado. Deploy do front: GitHub Pages (`https://vinycarnauba06.github.io/Renomeador/`).

**Mudança de arquitetura (25/ago):** a restrição "sem backend" foi abandonada de propósito. Motor de regras (`DOCUMENT_TYPES`/`CONDOMINIOS`) era fechado — só reconhecia o que já tinha sido ensinado manualmente (whitelist de condomínios Prolar, tipos de documento pré-cadastrados). Qualquer coisa fora disso, mesmo com OCR perfeito, caía em "não identificado". Em vez de continuar ampliando regex pra sempre, foi adicionado um backend serverless (Vercel, `api/extract.js`) que faz proxy autenticado pra Claude API (visão): documentos que o motor de regras local não resolver são mandados como imagem pro backend e voltam já com tipo/condomínio/data/nome sugerido extraídos por IA, sem precisar de regra pré-cadastrada.

## Arquitetura
- `index.html` / `style.css` — carrega libs via CDN (PDF.js, Tesseract.js, JSZip, pdf-lib) + `main.js` (ES modules). Inclui painel de configuração da IA (sem `window.prompt()`), barra de filtros/busca e modal de preview embutido do PDF.
- `pdf-utils.js` — utilitários puros: sanitização de nome de arquivo (`sanitizeFilename`, evita subpastas/caracteres inválidos no ZIP/Windows), escape HTML, abertura/renderização de PDF com fundo branco e liberação de memória de canvas (`releaseCanvas`).
- `state.js` — estado compartilhado da sessão (`items`, `usedNames` normalizado sem `.pdf`, `mergeQueueIds` e dica de condomínio do lote). Elimina o import circular entre `ui.js` e `pdf-merge.js`.
- `config.js` — `CONDOMINIOS` (~30 condomínios), `DOCUMENT_TYPES` (regras ordenadas), `MESES`, `CONFIDENCE_THRESHOLD`, `RULES_SEM_CONDOMINIO` e chaves de configuração da IA.
- `rules-engine.js` — Tier 1 (motor de regras local): `identifyDocument()`, `findCondominioFallback()`, `findData()`, aprendizado em `localStorage`.
- `ocr-pipeline.js` — Tier 3 (OCR local puro, sem dependência de IA): pré-processamento por percentil (2%–98%), binarização adaptativa Bradley-Roth (Integral Image) sob demanda quando a leitura em cinza fica fraca e na revisão profunda, Tesseract com `preserve_interword_spaces=1` e `user_defined_dpi=200`, auto-rotação `[0, 90, 270, 180]`, `OCR_KEYWORDS` atualizado e fallback pra página 2 na revisão profunda.
- `ai-extraction.js` — Tier 2 + orquestração principal (`identifyDocumentSmart` e `reviewDocumentSmart`): abre o PDF uma única vez, reaproveita o canvas no fallback pro OCR, envia `loteCondominio` no contexto pra IA, normaliza condomínio contra a whitelist e sempre fecha o PDF com `pdf.destroy()`.
- `pdf-merge.js` — junção vetorial de PDFs via pdf-lib usando `state.js` e callback `onMerged`.
- `ui.js` — orquestração de DOM: concorrência controlada (3x quando IA ativa, 1x no OCR local), edição inline em qualquer linha (inclusive alta confiança), remoção individual, download individual ou `.zip`, filtros/busca e preview embutido.
- `api/extract.js` — função serverless Vercel (CommonJS): valida `X-Renomeador-Secret` com `crypto.timingSafeEqual`, CORS incluindo `https://renomeador.carnauba.dev.br` (CNAME) + `github.io` + localhost, timeout de 25s na chamada Anthropic e sanitização de `hint`/`nome_sugerido`.
- `tests/renomeador.test.mjs` — suíte automatizada em Node (`npm test` / `node --test`).

## Deploy do backend (pendente — Viny precisa fazer manualmente)
1. `npm i -g vercel` (se ainda não tiver) e `vercel login`.
2. Na pasta do projeto: `vercel` (primeira vez, cria o projeto) → depois `vercel --prod`.
3. No dashboard do Vercel (Project Settings → Environment Variables), configurar `ANTHROPIC_API_KEY` e `RENOMEADOR_SHARED_SECRET` (gerar com `openssl rand -hex 32`) — ver `.env.example`.
4. Copiar a URL de produção que o Vercel gerar (ex.: `https://renomeador-api.vercel.app`) e colar em `AI_EXTRACT_ENDPOINT`, no topo de `script.js` (hoje está com um placeholder).
5. Adicionar essa mesma URL de produção em `ALLOWED_ORIGINS` só se o domínio do front mudar — hoje já cobre `https://vinycarnauba06.github.io`.
6. Abrir o app, colar o valor de `RENOMEADOR_SHARED_SECRET` quando ele pedir "chave de acesso do backend de IA" (fica salvo no `localStorage`, só precisa colar uma vez por navegador).

## Regra de ouro de engenharia deste projeto (revisada)
Antes: "o gargalo nunca foi OCR, é cobertura de regras". Isso ainda vale pro caminho local (Tier 1), mas agora não é mais o teto do sistema — o que ele não cobrir vai pra IA (Tier 2), que generaliza sem precisar de regra nova por tipo/condomínio. Ainda assim, se um padrão aparecer com muita frequência, vale a pena promovê-lo pra `DOCUMENT_TYPES`: é mais rápido, roda offline e não gasta chamada de API.

## ⚠️ Regra que não pode ser quebrada
**Nunca rodar `git` (nem `git status` read-only) via Bash contra `C:\Dev\Renomeador`.** Isso já travou o repositório do usuário com `.git/index.lock` várias vezes (pasta montada não permite deletar o lock via ferramentas). Toda operação git é só instrução em texto pro usuário rodar no PowerShell dele. Editar arquivos: sempre via Read/Edit direto no path do Windows.

## Workflow de verificação usado (repetir quando o usuário mandar PDFs novos)
1. Ler os PDFs em `/sessions/.../mnt/uploads/`.
2. `pdftotext` pra checar se tem texto nativo (raro — a maioria é só imagem).
3. Se só imagem: `pdftoppm -singlefile -r 200` (ou 150 se o arquivo for grande/lento) → `convert -colorspace Gray -normalize` → `tesseract --psm 6 -l por --tessdata-dir <path> -c tessedit_create_txt=1`.
4. Extrair a "lógica pura" do `script.js` (tudo antes do marcador `UI / ORQUESTRAÇÃO`) pra um arquivo Node standalone, com `global.pdfjsLib` e `global.loteCondominioSelect` stubados.
5. Rodar `identifyDocument(textoOCR, 0.75)` pra cada arquivo e comparar com o esperado.
6. Pra cada gap: inspecionar o texto OCR bruto, achar o padrão real (nem sempre óbvio — OCR garbling é comum: "GERENCIADOR"→"GERENCIADQÃQ", "referentes"→"iefef-L-r-tei", "Maio"→"Malo"), ajustar regra, re-testar.
7. tessdata do português está cacheado em `/sessions/.../mnt/outputs/tessdata/por.traineddata` (via `npm pack @tessdata/por`, porque cdnjs/jsdelivr/unpkg estavam bloqueados na sandbox).

## Regras adicionadas nas últimas sessões (13/ago)
- `fatura_gas_algas` — fatura de gás ALGÁS.
- `extrato_conta_corrente` — ampliado pra aceitar "SAC CAIXA"/"OUVIDORIA" como alternativa a "GERENCIADOR" (logo que o OCR quase nunca lê).
- `MESES["MALO"] = "MAI"` — variante de OCR de "Maio".
- `FIM_NOME_CONDOMINIO` — corrigido bug estrutural: um símbolo de ruído (ex.: `*`) logo após o nome travava a captura antes de chegar na quebra de linha.
- `recibo_generico` — regex mais tolerante a ruído entre "Recebi/Recebemos" e "do/de"; passou a cobrir também o título "RECIBO DE PRESTAÇÃO DE SERVIÇOS" com campo "Destinatário:".
- `extrato_conta_corrente_sicredi` (novo) — extrato de conta corrente do Internet Banking Sicredi ("Associado: X ... Extrato").
- `darf_receita_federal` (novo) — DARF / Documento de Arrecadação de Receitas Federais.
- `fatura_agua_ambiental` (novo) — fatura de água/esgoto da concessionária AMBIENTAL.

Todas essas mudanças estão **editadas localmente, ainda não confirmadas como enviadas ao GitHub** (o usuário roda o push manualmente). Comando pendente sugerido:
```
git add script.js
git commit -m "corrige bug de captura de condominio, adiciona regras de extrato Sicredi, DARF e fatura de agua"
git push
```

## Casos ainda em aberto (não são bug de regra, são limite de OCR/escopo)
- `doc12903920250911195922.pdf` — orçamento/proposta comercial (JOAPE), categoria de documento diferente (não é fatura/recibo). Se o usuário quiser, dá pra criar um tipo `proposta_comercial`.
- `doc12974520250915133916.pdf` — scan muito torto/de baixa qualidade, OCR virou ruído em todos os ângulos testados manualmente. Pode se comportar melhor no pipeline real do app (que testa 4 rotações automaticamente) ou precisar do botão "revisar baixa confiança".
- `doc13058920250918142234.pdf` — recibo manuscrito/foto ruim, sem condomínio nem data extraíveis — corretamente cai em baixa confiança.

## Convenções de nome de arquivo por tipo (pra referência rápida)
- `PROTOCOLO {data}` — entrega de boletos (sem condomínio).
- `PROTOCOLO RESERVA {condominio}` / `TERMO {condominio} {data}` — salão de festas.
- `FATURA EQUATORIAL|CLARO|GAS|AGUA {condominio} {mês} {ano}`
- `COMPROVANTE PIX|BOLETO {condominio} {data}`
- `EXTRATO [APLICACAO|CAPTACAO] {condominio} {mês} {ano}`
- `RECIBO [CARTORIO] {condominio} {data}`
- `NADA CONSTA|DECLARACAO {condominio} {unidade}`
- `BOLETO RATEIO {condominio} {unidade} {mês} {ano}`
- `RELATORIO DESPESAS {condominio} {categoria} {data}`
- `NOTA COBRANCA {condominio} {data}`
- `DARF {condominio} {data}`
- `BOLETO {condominio} {data}` (genérico)

## Preferências do usuário (Viny)
pt-BR sempre, zero yapping, tom de colega sênior, SOLID/Clean Architecture, edições cirúrgicas (diff, não reescrever arquivo inteiro) quando o arquivo já existe, nomear o arquivo em comentário no topo de blocos de código novos.
