# product-import Specification

## Purpose
Importação do catálogo a partir da planilha que o comerciante já tem (Excel, CSV ou dados colados), com reconhecimento automático de colunas, conferência linha a linha antes de gravar e gravação auditada no extrato de estoque. Contrato HTTP: operações da tag `Imports` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Acesso exclusivo do administrador
Todas as rotas de `/api/imports` MUST exigir sessão de ADMIN, inclusive o download do modelo: sem sessão a resposta SHALL ser 401 e para CASHIER SHALL ser 403.

#### Scenario: Caixa tenta gravar em massa
- **WHEN** um CASHIER chama `POST /api/imports/products/commit`
- **THEN** a API responde 403 e nada é gravado

### Requirement: Formatos de entrada
`POST /api/imports/products/parse` SHALL ler arquivos `.xlsx`/`.xlsm` e `.csv`/`.txt`/`.tsv` (UTF-8 ou Windows-1252, delimitador `;`, `,`, tab ou `|` detectado sozinho) enviados no campo `file` em multipart, ou texto colado em `{ "text": ... }`. Arquivos `.xls`/`.ods`, acima de 5 MB, vazios ou com mais de 1.000 linhas de dados MUST receber 400 com orientação em pt-BR.

#### Scenario: Excel antigo
- **WHEN** o administrador envia um arquivo `.xls`
- **THEN** a API responde 400 pedindo para salvar como `.xlsx` ou `.csv`

#### Scenario: CSV do Excel em português
- **WHEN** um CSV salvo em Windows-1252 contém "Café"
- **THEN** o texto é lido como "Café", sem caracteres corrompidos

### Requirement: Reconhecimento automático de colunas
A leitura SHALL devolver a grade (`headers` e `rows`, até 40 colunas), a lista de campos importáveis e um palpite de mapeamento campo→coluna feito pelos nomes do cabeçalho, sem acento e sem diferenciar maiúsculas (ex.: `EAN` vira código de barras e `VLR VENDA` vira preço de venda), sem gravar nada.

#### Scenario: Planilha de fornecedor
- **WHEN** os cabeçalhos são `DESCRICAO`, `EAN`, `VLR VENDA`, `QTDE` e `VENCIMENTO`
- **THEN** o mapeamento sugerido é `{ name: 0, barcode: 1, salePrice: 2, stock: 3, expiryDate: 4 }`

### Requirement: Conversão de valores escritos à mão
O sistema SHALL interpretar números no formato brasileiro (`R$ 1.234,56`) e internacional (`1,234.56`), datas como `31/12/2026`, `31-12-26`, ISO e número de série do Excel, e códigos de barras numéricos sem notação científica. Um valor que não puder ser convertido MUST virar erro daquela linha, nunca um valor adivinhado.

#### Scenario: Preço brasileiro
- **WHEN** a célula de custo contém `R$ 1.234,56`
- **THEN** o custo gravado é 1234,56

### Requirement: Conferência idêntica à gravação
`POST /api/imports/products/preview` SHALL classificar cada linha como `create`, `update`, `skip` ou `error`, com motivos, avisos e valores antes e depois, sem gravar nada. `POST /api/imports/products/commit` MUST recalcular e executar exatamente o mesmo plano a partir dos mesmos dados.

#### Scenario: Conferência antes de gravar
- **WHEN** o administrador envia a grade para `preview`
- **THEN** recebe o resumo por ação e o plano linha a linha, e o banco não muda

### Requirement: Opções de aplicação
A importação SHALL aceitar `mode` (`upsert` por padrão, `createOnly` ou `updateOnly`), `matchBy` (`barcode` por padrão, ou `name`, comparado sem acento e sem diferenciar maiúsculas) e `stockMode` (`ignore` por padrão, `set` para substituir o saldo ou `add` para somar ao saldo).

#### Scenario: Somente atualizar
- **WHEN** `mode` é `updateOnly` e a linha não corresponde a nenhum produto
- **THEN** a linha fica como `skip`, com o motivo

### Requirement: Proteções de integridade
Uma linha MUST virar erro, nunca uma sobrescrita silenciosa, quando o código de barras se repete no arquivo, quando o código pertence a outro produto, quando o nome corresponde a mais de um produto, quando o estoque resultante ficaria negativo ou quando um produto novo não tem preço de venda.

#### Scenario: Código de barras de outro produto
- **WHEN** a linha traz um código de barras que já pertence a um produto diferente do identificado
- **THEN** a linha é recusada e o produto dono do código não é alterado

#### Scenario: Código repetido no arquivo
- **WHEN** duas linhas trazem o mesmo código de barras
- **THEN** a segunda é recusada e o produto é cadastrado uma única vez

### Requirement: Gravação por linha com auditoria
O commit SHALL gravar cada linha em uma transação própria, para que a falha de uma não desfaça as demais, e MUST registrar toda alteração de saldo no extrato (ENTRY para estoque inicial e soma, ADJUSTMENT para acerto de saldo). Aumentos de saldo MUST criar um lote com a validade da linha, e reduções SHALL baixar pela ordem de perda do PVPS. A resposta SHALL trazer `created`, `updated`, `skipped`, `failed` e as falhas por linha.

#### Scenario: Acerto de saldo
- **WHEN** a planilha traz estoque 25 para um produto com saldo 10 e `stockMode` é `set`
- **THEN** o saldo passa a 25 e o extrato registra um ADJUSTMENT de 10 para 25

#### Scenario: Entrada pela planilha
- **WHEN** a linha traz estoque 12 e validade 31/12/2026 com `stockMode` igual a `add`
- **THEN** o produto ganha um lote de 12 unidades que vence em 2026-12-31

### Requirement: Modelo de planilha
`GET /api/imports/products/template` SHALL devolver um arquivo `.xlsx` com as colunas esperadas e duas linhas de exemplo.

#### Scenario: Download do modelo
- **WHEN** o administrador baixa o modelo
- **THEN** recebe `modelo-produtos.xlsx` com as colunas Nome, Código de barras, Categoria, Unidade, Preço de custo, Preço de venda, Estoque, Estoque mínimo e Validade

### Requirement: Validade em linhas que não criam lote
Numa linha que atualiza um produto sem criar lote, a validade SHALL seguir a regra da edição de produto: igual à atual é ignorada e, diferente, é aplicada aos lotes com saldo quando todos têm a mesma validade. Nos demais casos a linha MUST seguir sem alterar validades e com um aviso, que já aparece na conferência.

#### Scenario: Produto com lotes de validades diferentes
- **WHEN** a planilha traz nova validade para um produto cujos lotes com saldo vencem em datas diferentes
- **THEN** a linha atualiza os outros campos e avisa que a validade não foi aplicada
