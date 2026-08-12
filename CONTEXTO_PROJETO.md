# Contexto — Renomeador de Documentos

> Cole este arquivo (ou peça pra Claude ler `C:\Dev\Renomeador\CONTEXTO_PROJETO.md`) no início do próximo chat pra retomar de onde parou.

## O que é
App client-side (PDF.js + Tesseract.js + JSZip + pdf-lib) que lê PDFs digitalizados de condomínio (OCR) e sugere nome de arquivo padronizado via engine de regras. Deploy: GitHub Pages (`https://vinycarnauba06.github.io/Renomeador/`). 100% no navegador — nada sai da máquina do usuário. **Restrição dura: sem backend, sem servidor, grátis.**

## Arquitetura
- `index.html` — carrega libs via CDN (cdnjs) + `script.js`.
- `style.css`
- `script.js` — tudo:
  - `CONDOMINIOS`: whitelist de ~30 condomínios (nome + aliases).
  - `DOCUMENT_TYPES`: array ordenado de detectores `{id, test, extract, format, confidence}` — primeiro que casar decide o nome. Mais específico primeiro.
  - `CONDOMINIO_LABELS` + `regexDoRotulo()`: extração data-driven do nome do condomínio a partir de rótulos no cabeçalho (CONDOMÍNIO, EDIFÍCIO, EDF, ED, RES, RESIDENCIAL, COND, CON etc., com/sem acento, com/sem ponto).
  - `identifyDocument()`: roda os detectores, aplica penalidade por confiança de OCR, e um corte duro (`RULES_SEM_CONDOMINIO`) que impede auto-aceite sem condomínio resolvido.
  - Pipeline de OCR: texto nativo primeiro → senão renderiza pág. 1 (PDF.js canvas), pré-processa (grayscale + contraste), testa rotações 0/90/180/270 com Tesseract, `ocrQualityScore()` escolhe a melhor.
  - Botão "revisar baixa confiança": reprocessa em resolução maior (3.5) testando 3 PSM × 4 rotações.
  - Feature de junção de PDFs: checkbox por linha → fila reordenável → `mergeSelectedPdfs()` via pdf-lib.
  - Marcador `UI / ORQUESTRAÇÃO` no arquivo separa lógica pura (testável em Node) do DOM.

## Regra de ouro de engenharia deste projeto
O gargalo NUNCA foi qualidade de OCR (confiança média ~70%+ em lotes reais) — é cobertura de regras/padrões em `DOCUMENT_TYPES` e nos rótulos de condomínio. Toda vez que aparece um "não identificado", o caminho é: extrair o texto OCR real do PDF, achar o padrão que falhou, e ou (a) ampliar um `test()` existente, ou (b) criar um novo tipo em `DOCUMENT_TYPES`.

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
