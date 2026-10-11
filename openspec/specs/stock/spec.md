# stock Specification

## Purpose
Controle do saldo de estoque e da trilha de auditoria: entradas de mercadoria, ajustes e perdas lançados pelo administrador, consulta do extrato e as garantias de atomicidade que valem para toda alteração de saldo no sistema. Contrato HTTP: operações da tag `Stock` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Acesso exclusivo do administrador
Todas as rotas de `/api/stock` MUST exigir sessão de ADMIN: sem sessão a resposta SHALL ser 401 e para CASHIER SHALL ser 403.

#### Scenario: Caixa tenta lançar entrada
- **WHEN** um CASHIER chama `POST /api/stock/entries`
- **THEN** a API responde 403 e o saldo não muda

### Requirement: Entrada de mercadoria
`POST /api/stock/entries` SHALL somar uma quantidade maior que zero (até 1.000.000) ao saldo de um produto ativo, criando um lote novo com essa quantidade e a validade informada (`AAAA-MM-DD` existente no calendário, opcional), e registrar uma movimentação ENTRY com o motivo informado ou "Entrada de estoque (compra)". A resposta SHALL trazer o lote criado. Produto inexistente ou desativado MUST receber 404.

#### Scenario: Compra registrada
- **WHEN** o administrador lança entrada de 24 unidades com validade 2026-12-31 num produto com saldo 6
- **THEN** a API responde 201 com `currentStock` 30 e o lote criado com saldo 24 e validade 2026-12-31
- **AND** o extrato ganha uma ENTRY de 6 para 30

#### Scenario: Produto sem validade
- **WHEN** a entrada não informa validade (ex.: produto de limpeza)
- **THEN** o lote é criado sem validade

### Requirement: Ajuste e perda
`POST /api/stock/adjustments` SHALL aplicar uma quantidade positiva ou negativa, diferente de zero e de até 1.000.000 em módulo, com motivo obrigatório e tipo `ADJUSTMENT` (padrão) ou `LOSS`. Com `batchId`, o ajuste MUST mexer só naquele lote do produto; sem ele, uma quantidade positiva SHALL criar um lote novo (com `expiryDate` opcional) e uma negativa SHALL baixar pela ordem de perda do PVPS. Saldo negativo no produto ou no lote MUST ser recusado com 400.

#### Scenario: Perda por validade
- **WHEN** o administrador lança `LOSS` de -3 com o motivo "Vencido", sem indicar lote, num produto com um lote vencido de 3 unidades
- **THEN** o lote vencido é zerado e o extrato registra a perda com o motivo

#### Scenario: Ajuste num lote específico
- **WHEN** o administrador lança -2 informando o `batchId` de um lote do produto
- **THEN** só aquele lote diminui 2

#### Scenario: Lote de outro produto
- **WHEN** o `batchId` informado não pertence ao produto
- **THEN** a API responde 404 e nada muda

#### Scenario: Baixa maior que o saldo
- **WHEN** o ajuste deixaria o saldo abaixo de zero
- **THEN** a API responde 400 com `{ "error": "Essa operação deixaria o estoque negativo." }`

### Requirement: Saldo atômico sob concorrência
Toda alteração de saldo (venda, entrada, ajuste, perda, cancelamento de venda e importação) MUST ser aplicada de forma atômica pelo banco, de modo que operações simultâneas no mesmo produto nunca percam atualizações, nunca deixem o saldo negativo e nunca o levem acima de 50.000.000.

#### Scenario: Entradas simultâneas
- **WHEN** 30 entradas de +1 chegam ao mesmo tempo para o mesmo produto
- **THEN** o saldo final aumenta exatamente 30

### Requirement: Trilha de auditoria imutável
Cada alteração de saldo MUST gerar exatamente uma movimentação com tipo, quantidade com sinal, saldo anterior, saldo novo, motivo, usuário responsável e data, e o saldo anterior e o novo MUST ser os reais daquela operação, mesmo sob concorrência. A API MUST NOT oferecer edição nem exclusão de movimentações.

#### Scenario: Vendas simultâneas no extrato
- **WHEN** 10 vendas de 1 unidade de um produto com saldo 10 acontecem ao mesmo tempo
- **THEN** o extrato registra as transições 10→9, 9→8 … 1→0, uma por venda

### Requirement: Consulta do extrato
`GET /api/stock/movements` SHALL listar as movimentações da mais recente para a mais antiga, com filtros `productId`, `type` (`ENTRY`, `SALE`, `ADJUSTMENT`, `LOSS`), `from` e `to`. Tipo ou data inválidos MUST receber 400. Sem paginação SHALL devolver as 200 mais recentes; com `page` ou `pageSize` SHALL devolver `{ totalCount, page, pageSize, movements }`.

#### Scenario: Filtro inválido
- **WHEN** o cliente envia `type=XYZ`
- **THEN** a API responde 400 indicando os valores aceitos

### Requirement: Estoque organizado em lotes
O saldo de cada produto SHALL estar distribuído em lotes, cada um com quantidade recebida, saldo restante, validade opcional e data de entrada. Depois de qualquer operação, a soma dos saldos dos lotes MUST ser igual ao saldo do produto, e cada movimentação MUST registrar quanto alterou em cada lote. Na migração, o estoque existente SHALL virar um lote por produto, com a validade que o produto tinha.

#### Scenario: Soma dos lotes
- **WHEN** um produto recebe duas entradas e vende parte delas
- **THEN** a soma dos saldos dos lotes continua igual ao `currentStock` do produto

#### Scenario: Migração do estoque antigo
- **WHEN** a migration roda num banco com produtos que já têm saldo e validade
- **THEN** cada produto com saldo ganha um lote com esse saldo e essa validade

### Requirement: Baixa por PVPS
Vendas MUST baixar primeiro dos lotes não vencidos com a validade mais próxima, deixando os lotes sem validade por último e desempatando pelo lote mais antigo; lotes vencidos só SHALL ser usados quando os válidos não bastarem. Perdas e ajustes negativos sem lote indicado MUST baixar primeiro do lote de validade mais antiga, inclusive os vencidos, para que o descarte de vencidos zere esses lotes.

#### Scenario: Venda leva o lote que vence primeiro
- **WHEN** um produto tem um lote que vence em 10 dias e outro em 60 dias, e uma venda leva 3 unidades
- **THEN** as 3 unidades saem do lote que vence em 10 dias

#### Scenario: Venda não leva lote vencido
- **WHEN** um produto tem um lote vencido e um lote válido com saldo suficiente
- **THEN** a venda baixa só do lote válido e o lote vencido continua aparecendo nos alertas

#### Scenario: Descarte de vencidos
- **WHEN** o administrador lança uma perda sem indicar lote num produto com um lote vencido
- **THEN** a perda baixa primeiro o lote vencido

### Requirement: Consulta de lotes
`GET /api/stock/batches` (ADMIN) SHALL listar os lotes com saldo, com produto, quantidade recebida, saldo, validade, dias para vencer e urgência pela validade (`RED` vencido ou em até 7 dias, `YELLOW` de 8 a 30 dias, `GREEN` nos demais casos e sem validade), da validade mais próxima para a mais distante (sem validade por último), com filtros `productId` e `urgency`. Urgência inválida MUST receber 400.

#### Scenario: Lotes de um produto
- **WHEN** o administrador filtra os lotes de um produto
- **THEN** recebe só os lotes com saldo daquele produto, do que vence primeiro ao que vence por último

### Requirement: Correção da validade de um lote
`PUT /api/stock/batches/{id}` (ADMIN) SHALL alterar a validade de um lote para outra data `AAAA-MM-DD` existente ou para `null`, sem mudar saldos, e a validade exibida do produto MUST ser recalculada. Lote inexistente MUST receber 404.

#### Scenario: Validade digitada errada
- **WHEN** o administrador corrige a validade de um lote de 2026-01-31 para 2027-01-31
- **THEN** o lote passa a vencer em 2027-01-31 e o semáforo do produto é recalculado
