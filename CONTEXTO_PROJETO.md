# Contexto — Renomeador de Documentos

> Cole este arquivo (ou peça pra Claude ler `C:\Dev\Renomeador\CONTEXTO_PROJETO.md`) no início do próximo chat pra retomar de onde parou.

## O que é
App client-side (PDF.js + Tesseract.js + JSZip + pdf-lib) que lê PDFs digitalizados de condomínio e sugere nome de arquivo padronizado. Deploy do front: GitHub Pages (`https://vinycarnauba06.github.io/Renomeador/`).

**Mudança de arquitetura (25/ago):** a restrição "sem backend" foi abandonada de propósito. Motor de regras (`DOCUMENT_TYPES`/`CONDOMINIOS`) era fechado — só reconhecia o que já tinha sido ensinado manualmente (whitelist de condomínios Prolar, tipos de documento pré-cadastrados). Qualquer coisa fora disso, mesmo com OCR perfeito, caía em "não identificado". Em vez de continuar ampliando regex pra sempre, foi adicionado um backend serverless (Vercel, `api/extract.js`) que faz proxy autenticado pra Claude API (visão): documentos que o motor de regras local não resolver são mandados como imagem pro backend e voltam já com tipo/condomínio/data/nome sugerido extraídos por IA, sem precisar de regra pré-cadastrada.

## Arquitetura
- `index.html` — carrega libs via CDN (cdnjs) + `script.js`.
- `style.css`
- `script.js` — tudo do front:
  - `CONDOMINIOS`: whitelist de ~30 condomínios (nome + aliases) — atalho de alta confiança pro caminho local, não é mais o único jeito de reconhecer condomínio (a IA reconhece qualquer um pelo conteúdo).
  - `DOCUMENT_TYPES`: array ordenado de detectores `{id, test, extract, format, confidence}` — primeiro que casar decide o nome. Continua sendo o caminho RÁPIDO/GRÁTIS/OFFLINE pros casos já ensinados.
  - `identifyDocument()`: motor de regras local original — roda os detectores, aplica penalidade por confiança de OCR, corte duro (`RULES_SEM_CONDOMINIO`) sem condomínio resolvido. Inalterado.
  - `identifyDocumentSmart(file)` (NOVO): orquestrador principal, chamado no lugar de `extractPdfText`+`identifyDocument` direto. Ordem: (1) texto nativo do PDF + `identifyDocument()` local — se confiança >= `CONFIDENCE_THRESHOLD`, retorna na hora, sem rede; (2) senão, renderiza pág. 1 em canvas e chama `extractWithAI()` — o backend devolve JSON já formatado (`nome_sugerido`, `condominio`, `confidence`, etc.); (3) se a IA falhar (sem chave, sem rede, backend fora do ar), cai pro pipeline antigo de OCR local (Tesseract) + `identifyDocument()`, como último recurso pra nunca deixar o app 100% sem funcionar.
  - `extractWithAI(canvas, {hint})` / `getAiSecret()` / `canvasToBase64Jpeg()`: cliente HTTP pro backend. A "chave" pedida ao usuário (`localStorage`, prompt na primeira vez) é só o segredo compartilhado do backend (`RENOMEADOR_SHARED_SECRET`), NUNCA a chave da Anthropic.
  - Pipeline de OCR local (Tesseract) continua existindo intacto — vira fallback de rede indisponível, não é mais o caminho principal pra PDF só-imagem.
  - Botão "revisar baixa confiança" (`reviewDocument`): agora tenta IA em resolução maior (3.5) com uma dica de contexto primeiro; só cai pro `ocrDeepReview` (3 PSM × 4 rotações local) se a IA falhar.
  - Feature de junção de PDFs: checkbox por linha → fila reordenável → `mergeSelectedPdfs()` via pdf-lib. Inalterado.
  - Marcador `UI / ORQUESTRAÇÃO` no arquivo separa lógica pura (testável em Node) do DOM. Inalterado.
- `api/extract.js` (NOVO) — função serverless Vercel. Recebe `{ image (base64), mimeType, hint? }`, valida `X-Renomeador-Secret` contra `RENOMEADOR_SHARED_SECRET`, chama `POST https://api.anthropic.com/v1/messages` (modelo `claude-haiku-4-5-20251001`, vision) com a chave `ANTHROPIC_API_KEY` (env var, nunca exposta), parseia o JSON da resposta e devolve pro front. CORS restrito a `ALLOWED_ORIGINS` (github.io do Viny + localhost pra dev).
- `package.json` / `.env.example` / `.gitignore` (NOVOS) — infra mínima pro deploy Vercel.

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
