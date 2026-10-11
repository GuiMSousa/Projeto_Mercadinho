# products Specification

## Purpose
Catálogo de produtos do mercadinho: consulta por todos os usuários (com preço de custo e margem restritos ao administrador), cadastro, edição, desativação lógica e reativação. O saldo de estoque só muda por movimentações (capacidade `stock`). Contrato HTTP: operações da tag `Products` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Consulta do catálogo
`GET /api/products` SHALL estar disponível a qualquer usuário autenticado e listar os produtos ativos em ordem alfabética, com filtros opcionais `query` (trecho do nome, sem diferenciar maiúsculas), `category` (valor exato) e `lowStock=true` (saldo menor ou igual ao mínimo). `includeInactive=true` SHALL incluir os desativados somente para ADMIN.

#### Scenario: Busca por nome
- **WHEN** um caixa busca `query=arroz`
- **THEN** recebe os produtos ativos cujo nome contém "arroz", em qualquer combinação de maiúsculas

#### Scenario: Caixa pede produtos desativados
- **WHEN** um CASHIER envia `includeInactive=true`
- **THEN** a resposta contém apenas produtos ativos

### Requirement: Paginação opcional
Sem `page` nem `pageSize`, a listagem SHALL devolver o array completo. Com qualquer um dos dois SHALL devolver `{ totalCount, page, pageSize, products }`, com `pageSize` padrão 20 e máximo 100; valores ausentes, inválidos ou fora da faixa MUST cair no padrão.

#### Scenario: Página explícita
- **WHEN** o cliente pede `page=2&pageSize=10`
- **THEN** recebe até 10 produtos a partir do 11º e o `totalCount` geral

### Requirement: Preço de custo restrito ao administrador
Os campos `costPrice` e `margin` (preço de venda menos custo) MUST aparecer somente nas respostas para ADMIN e MUST ser omitidos para CASHIER em todas as rotas de produtos.

#### Scenario: Caixa consulta produtos
- **WHEN** um CASHIER lista ou detalha produtos
- **THEN** nenhuma resposta contém `costPrice` nem `margin`

### Requirement: Detalhe do produto
`GET /api/products/{id}` SHALL devolver o produto. Produto inexistente MUST receber 404, e produto desativado MUST receber 404 para quem não é ADMIN.

#### Scenario: Caixa acessa produto desativado pelo id
- **WHEN** um CASHIER pede o detalhe de um produto desativado
- **THEN** a API responde 404

### Requirement: Cadastro de produto
`POST /api/products` (ADMIN) SHALL validar os campos do cadastro com os limites do contrato HTTP, inclusive validade `AAAA-MM-DD` existente no calendário. Código de barras repetido MUST receber 409. Estoque inicial maior que zero MUST criar o primeiro lote do produto, com a validade informada, e uma movimentação ENTRY na mesma transação; sem estoque inicial a validade SHALL ser descartada, porque só existe validade em lote com saldo.

#### Scenario: Data impossível
- **WHEN** a validade enviada é `2026-02-30`
- **THEN** a API responde 400 e nada é gravado

#### Scenario: Estoque inicial
- **WHEN** um produto é cadastrado com `initialStock: 12` e validade 2026-12-31
- **THEN** o saldo nasce em 12, num lote que vence em 2026-12-31, e o extrato registra a entrada "Estoque inicial no cadastro" de 0 para 12

#### Scenario: Validade sem estoque inicial
- **WHEN** um produto é cadastrado com validade e `initialStock: 0`
- **THEN** o produto é criado sem lotes e com `expiryDate` nula

#### Scenario: Código de barras repetido
- **WHEN** o código de barras já pertence a outro produto
- **THEN** a API responde 409

### Requirement: Edição de produto
`PUT /api/products/{id}` (ADMIN) SHALL aceitar atualização parcial dos campos do cadastro e de `active`, sem alterar o saldo. Uma `expiryDate` igual à validade atual SHALL ser ignorada; diferente, SHALL ser aplicada aos lotes com saldo quando todos têm a mesma validade, MUST receber 400 se o produto está sem saldo e 409 se os lotes têm validades diferentes. Código de barras de outro produto MUST receber 409, e produto inexistente MUST receber 404.

#### Scenario: Correção de preço
- **WHEN** o administrador envia `salePrice` junto com a mesma validade que o produto já tem
- **THEN** só o preço de venda muda e o saldo e os lotes permanecem iguais

#### Scenario: Validade de um lote único
- **WHEN** o produto tem um único lote com saldo e o administrador envia outra validade
- **THEN** o lote passa a ter a nova validade

#### Scenario: Lotes com validades diferentes
- **WHEN** o produto tem lotes com saldo que vencem em datas diferentes e o administrador envia outra validade
- **THEN** a API responde 409 orientando a corrigir a validade pelo lote

### Requirement: Desativação lógica e reativação
`DELETE /api/products/{id}` (ADMIN) SHALL apenas marcar o produto como desativado, sem apagá-lo, preservando as vendas e movimentações ligadas a ele. Um produto desativado MUST sair das vendas e da listagem padrão, e SHALL poder ser reativado com `PUT /api/products/{id}` enviando `active: true`.

#### Scenario: Desativar e reativar
- **WHEN** o administrador desativa um produto e depois envia `active: true`
- **THEN** o produto volta à listagem padrão com o mesmo histórico

### Requirement: Validade do produto vem dos lotes
A `expiryDate` devolvida para um produto SHALL ser a validade mais próxima entre os seus lotes com saldo, incluindo lotes já vencidos, e MUST ser `null` quando o produto não tem saldo ou nenhum lote com saldo tem validade.

#### Scenario: Dois lotes com saldo
- **WHEN** um produto tem lotes com saldo que vencem em 2026-11-10 e 2027-01-05
- **THEN** a `expiryDate` do produto é 2026-11-10

#### Scenario: Lote esgotado
- **WHEN** o lote que vencia primeiro é todo vendido
- **THEN** a `expiryDate` passa a ser a do próximo lote com saldo

### Requirement: Semáforo de urgência
Toda resposta de produto SHALL trazer `urgency`, `urgencyReasons` e `daysToExpiry` (dias de calendário até a validade, ou `null`). `RED` MUST valer para saldo zerado (`OUT_OF_STOCK`), validade vencida (`EXPIRED`) ou em até 7 dias (`EXPIRES_SOON`); `YELLOW` para saldo menor ou igual ao mínimo (`LOW_STOCK`) ou validade entre 8 e 30 dias (`EXPIRING`); `GREEN` nos demais casos, sem motivos.

#### Scenario: Vence em 5 dias
- **WHEN** a validade mais próxima de um produto com saldo acima do mínimo é daqui a 5 dias
- **THEN** o produto é `RED` com o motivo `EXPIRES_SOON` e `daysToExpiry` 5

#### Scenario: Estoque baixo e validade próxima
- **WHEN** o saldo está igual ao mínimo e a validade é daqui a 20 dias
- **THEN** o produto é `YELLOW` com os motivos `LOW_STOCK` e `EXPIRING`

#### Scenario: Estoque zerado
- **WHEN** o saldo do produto é 0
- **THEN** o produto é `RED` com o motivo `OUT_OF_STOCK`

#### Scenario: Tudo em ordem
- **WHEN** o saldo está acima do mínimo e a validade é daqui a mais de 30 dias, ou não existe
- **THEN** o produto é `GREEN` e `urgencyReasons` vem vazio

### Requirement: Filtro por urgência
`GET /api/products?urgency=RED|YELLOW|GREEN` SHALL devolver só os produtos naquele nível, combinável com os demais filtros e com a paginação. Valor inválido MUST receber 400.

#### Scenario: Produtos vermelhos
- **WHEN** um usuário filtra `urgency=RED`
- **THEN** recebe só produtos com saldo zerado, vencidos ou que vencem em até 7 dias

#### Scenario: Filtro inválido
- **WHEN** o cliente envia `urgency=AZUL`
- **THEN** a API responde 400 indicando os valores aceitos
