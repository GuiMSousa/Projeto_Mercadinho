# Delta for reports

## ADDED Requirements

### Requirement: Painel financeiro
`GET /api/reports/financial` SHALL calcular, para as vendas não canceladas entre `startDate` e `endDate` (dias `AAAA-MM-DD` no fuso da loja, ambos inclusive; padrão: do primeiro dia do mês até hoje): o faturamento bruto (soma dos totais das vendas), o custo das mercadorias vendidas (soma de quantidade × custo unitário gravado no item no momento da venda), o lucro (faturamento − CMV), a margem (lucro ÷ faturamento × 100), o número de vendas, o ticket médio (faturamento ÷ vendas), o total e o percentual do faturamento de cada forma de pagamento e os 10 produtos de maior lucro com quantidade, faturamento, custo, lucro e margem. Sem vendas, margem e ticket médio MUST vir `null`. Produto vendido com custo zero SHALL contar custo R$ 0,00 e vir marcado como custo não informado. Data inválida ou `startDate` depois de `endDate` MUST receber 400.

#### Scenario: Cálculo do período
- **WHEN** o período tem 3 vendas não canceladas — R$ 30,00 em dinheiro (custo R$ 12,00), R$ 10,00 no Pix (custo não informado) e R$ 19,95 no débito (custo R$ 15,00) — e uma venda cancelada
- **THEN** o faturamento é R$ 59,95, o CMV R$ 27,00, o lucro R$ 32,95, a margem 54,96%, o ticket médio R$ 19,98 e o dinheiro é 50,04% do faturamento

#### Scenario: Custo do momento da venda
- **WHEN** o custo do produto muda depois da venda
- **THEN** o CMV daquela venda continua com o custo gravado nela

#### Scenario: Período sem vendas
- **WHEN** o período não tem vendas
- **THEN** faturamento, CMV e lucro são 0 e margem e ticket médio vêm `null`

## MODIFIED Requirements

### Requirement: Resumo de vendas
`GET /api/reports/sales-summary` SHALL somar o total e contar as vendas não canceladas entre `from` e `to` (ambos opcionais) e agrupar o total por dia no formato `AAAA-MM-DD`, com o dia no fuso da loja (`TZ`). Datas inválidas MUST receber 400.

#### Scenario: Período sem filtro
- **WHEN** o administrador pede o resumo sem `from` nem `to`
- **THEN** recebe o total, a contagem e `byDay` de todas as vendas não canceladas

#### Scenario: Venda à noite
- **WHEN** uma venda é feita às 22h no horário de Brasília
- **THEN** ela entra no dia da venda, não no dia seguinte

#### Scenario: Data inválida
- **WHEN** o cliente envia `from=lixo`
- **THEN** a API responde 400 com uma mensagem indicando o formato de data esperado
