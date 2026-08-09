# Renomeador de Documentos

Ferramenta web para renomear em lote documentos digitalizados (PDFs) de condomínios com base no conteúdo do próprio arquivo — sem servidor, sem instalação e sem enviar nenhum documento para a internet.

**[Acessar a aplicação »](https://vinycarnauba06.github.io/Renomeador/)**

---

## Sobre o projeto

Rotinas de digitalização em massa (dezenas ou centenas de arquivos por lote) geram PDFs com nomes genéricos (`scan001.pdf`, `doc12345.pdf`...), exigindo renomeação manual, um a um, pra identificar tipo de documento, condomínio e data. Este projeto automatiza essa etapa: você arrasta os PDFs, a aplicação lê o conteúdo (texto nativo ou OCR), identifica o tipo de documento e sugere um nome padronizado — deixando para conferência manual apenas os casos de baixa confiança.

Todo o processamento acontece **no navegador do usuário**. Nenhum arquivo, imagem ou texto extraído é enviado a qualquer servidor — a aplicação é 100% estática e funciona até offline, após o primeiro carregamento.

## Funcionalidades

- **Leitura de PDF com fallback para OCR** — tenta extrair texto nativo primeiro; se o PDF for só imagem (digitalização comum), aciona OCR local via [Tesseract.js](https://github.com/naptha/tesseract.js).
- **Correção automática de rotação** — testa o documento em 0°/90°/180°/270° e usa o resultado de maior qualidade, comum em digitalizações feitas com celular.
- **Motor de regras por tipo de documento** — cada tipo (protocolo, termo, fatura, comprovante, extrato, recibo, boleto de rateio etc.) tem um detector dedicado que extrai campos específicos (condomínio, data, unidade, número de UC, entre outros) e monta o nome final.
- **Pontuação de confiança** — cada sugestão vem com um percentual de confiança; abaixo de 70% o documento é marcado para conferência manual em vez de ser renomeado "no escuro".
- **Revisão aprofundada sob demanda** — botão dedicado que reprocessa, com métodos de OCR mais lentos e completos, apenas os documentos que ficaram abaixo do limiar de confiança.
- **Visualização do arquivo original** — abre o PDF numa aba nova para conferência visual antes de confirmar o nome.
- **Aprendizado por correção manual** — ao confirmar manualmente o nome de um condomínio, a aplicação memoriza essa informação (salva localmente, no navegador) e passa a reconhecer esse condomínio automaticamente nos próximos documentos e lotes.
- **Exportar/importar aprendizado** — a lista de condomínios aprendidos pode ser exportada em `.json` e importada em outro navegador ou computador, permitindo levar o conhecimento acumulado entre ambientes.
- **Processamento em lote com download em `.zip`** — todos os arquivos renomeados são baixados de uma vez, já compactados.
- **Separação por lotes** — botão para encerrar o lote atual e começar um novo, sem misturar arquivos já baixados com os próximos.

## Como funciona (privacidade)

| Etapa | Onde acontece |
|---|---|
| Leitura do PDF | No navegador (PDF.js) |
| OCR | No navegador (Tesseract.js, modelo baixado uma vez e reaproveitado) |
| Identificação e nomeação | No navegador (regras em JavaScript puro) |
| Geração do `.zip` | No navegador (JSZip) |
| Aprendizado de condomínios | `localStorage` do navegador — nunca sai da máquina |

Não há backend, banco de dados ou API própria. A única comunicação de rede é o carregamento inicial das bibliotecas (PDF.js, Tesseract.js, JSZip) via CDN — os documentos em si nunca trafegam pela rede.

## Como usar

1. Acesse a aplicação (link acima) ou abra o arquivo `index.html` localmente, sem necessidade de servidor.
2. Arraste os PDFs digitalizados para a área indicada (ou clique para selecionar).
3. Aguarde o processamento — cada documento recebe um nome sugerido e um selo de confiança.
4. Documentos com selo **⚠ CONFERIR** ou **⚠ NÃO IDENTIFICADO**: confira o arquivo original (botão "ver arquivo"), ajuste o nome manualmente se necessário, ou use "🎓 ensinar condomínio" quando o problema for só o nome do condomínio não reconhecido.
5. Opcional: clique em "REVISAR BAIXA CONFIANÇA" para reprocessar os casos incertos com um método de OCR mais lento e completo.
6. Clique em "BAIXAR TODOS (.ZIP)" para exportar o lote inteiro já renomeado.
7. Clique em "LIMPAR LISTA / NOVO LOTE" antes de processar o próximo grupo de arquivos.

## Adicionando novos tipos de documento ou condomínios

As regras de nomenclatura ficam concentradas no início do arquivo `index.html`, nas constantes:

- `CONDOMINIOS` — lista de condomínios conhecidos e seus apelidos/variações de OCR.
- `DOCUMENT_TYPES` — lista ordenada de detectores (tipo de documento, teste de reconhecimento, extração de campos e formato do nome final).

Cada novo tipo de documento segue o mesmo contrato: um `test()` que reconhece o documento pelo conteúdo, um `extract()` que pega os campos relevantes do texto, e um `format()` que monta o nome final a partir desses campos. A ordem da lista importa — regras mais específicas devem vir antes das genéricas.

## Stack técnica

- JavaScript puro (sem framework, sem build step)
- [PDF.js](https://mozilla.github.io/pdf.js/) — leitura e renderização de PDF
- [Tesseract.js](https://github.com/naptha/tesseract.js) — OCR (idioma português)
- [JSZip](https://stuk.github.io/jszip/) — geração do arquivo `.zip` de saída

## Limitações conhecidas

- A qualidade da identificação depende diretamente da qualidade da digitalização — documentos muito tortos, borrados ou com contraste baixo podem exigir nomeação manual mesmo após a revisão aprofundada.
- Tipos de documento totalmente novos (fora dos já cobertos por `DOCUMENT_TYPES`) não são reconhecidos automaticamente; é preciso adicionar uma regra nova no código.
- O aprendizado de condomínios fica salvo por navegador/origem — trocar de navegador, computador ou domínio de acesso (por exemplo, rodar localmente e depois via GitHub Pages) exige exportar e importar a lista aprendida manualmente.

