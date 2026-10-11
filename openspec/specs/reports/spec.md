# reports Specification

## Purpose
Relatórios gerenciais do administrador: previsão de esgotamento de estoque, resumo de vendas por período e por dia, ranking de produtos mais vendidos e produtos parados com o capital imobilizado neles. Contrato HTTP: operações da tag `Reports` em `openspec/openapi.yaml`.

## Requirements

### Requirement: Acesso exclusivo do administrador
Todas as rotas de `/api/reports` MUST exigir sessão de ADMIN: sem sessão a resposta SHALL ser 401 e para CASHIER SHALL ser 403.

#### Scenario: Caixa tenta abrir relatório
- **WHEN** um CASHIER chama `GET /api/reports/sales-summary`
- **THEN** a API responde 403

### Requirement: Previsão de esgotamento
`GET /api/reports/forecast` SHALL calcular, para cada produto ativo, a média diária de unidades vendidas em vendas não canceladas nos últimos `FORECAST_WINDOW_DAYS` dias (padrão 30) e os dias até esgotar (saldo dividido pela média, com uma casa decimal, ou `null` sem vendas), do mais urgente para o menos urgente, com os sem previsão por último.

#### Scenario: Produto com giro
- **WHEN** um produto vendeu 30 unidades nos últimos 30 dias e tem saldo 10
- **THEN** a previsão mostra `avgDailySales` 1 e `daysUntilStockout` 10

#### Scenario: Venda cancelada
- **WHEN** a única venda de um produto na janela foi cancelada
- **THEN** `avgDailySales` é 0, `daysUntilStockout` é `null` e o produto fica no fim da lista

### Requirement: Resumo de vendas
`GET /api/reports/sales-summary` SHALL somar o total e contar as vendas não canceladas entre `from` e `to` (ambos opcionais) e agrupar o total por dia no formato `AAAA-MM-DD`, com o dia calculado em UTC. Datas inválidas MUST receber 400.

#### Scenario: Período sem filtro
- **WHEN** o administrador pede o resumo sem `from` nem `to`
- **THEN** recebe o total, a contagem e `byDay` de todas as vendas não canceladas

#### Scenario: Data inválida
- **WHEN** o cliente envia `from=lixo`
- **THEN** a API responde 400 com uma mensagem indicando o formato de data esperado

### Requirement: Produtos mais vendidos
`GET /api/reports/top-products` SHALL ranquear os produtos pela receita no período (`from` e `to`), devolvendo a quantidade vendida e a receita, com `limit` padrão 10 e máximo 50. Vendas canceladas MUST ficar de fora.

#### Scenario: Ranking do mês
- **WHEN** o administrador pede `top-products` com `from` no dia 1 do mês
- **THEN** recebe até 10 produtos ordenados pela receita do período

### Requirement: Produtos parados
`GET /api/reports/slow-moving` SHALL listar os produtos ativos com saldo maior que zero e nenhuma venda não cancelada nos últimos `days` dias (padrão 60, de 1 a 365), com `capitalParado` igual ao saldo multiplicado pelo preço de custo.

#### Scenario: Capital imobilizado
- **WHEN** um produto com 12 unidades de custo R$ 7,90 não vende há 60 dias
- **THEN** ele aparece com `capitalParado` 94,8
