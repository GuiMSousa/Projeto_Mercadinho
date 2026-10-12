# Proposal

## Why

O dono precisa saber se a loja dá lucro, não só quanto vendeu: faturamento, custo das mercadorias vendidas (CMV), lucro, margem e ticket médio no período, por forma de pagamento e por produto. Hoje o item da venda não guarda o custo — só o produto tem o custo atual — então não dá para calcular o CMV com o custo do momento da venda.

## What Changes

- O item da venda passa a gravar o custo unitário do produto no momento da venda (`SaleItem.unitCost`). Na migração, as vendas já feitas recebem o custo atual do produto, a melhor informação disponível.
- Novo `GET /api/reports/financial?startDate=AAAA-MM-DD&endDate=AAAA-MM-DD` (ADMIN): faturamento bruto, CMV, lucro (faturamento − CMV), margem %, número de vendas, ticket médio, totais e percentuais por forma de pagamento e os 10 produtos que mais deram lucro (quantidade, faturamento, custo, lucro, margem). Produto vendido com custo zero ("custo não informado") conta como custo R$ 0,00, margem 100% e vem marcado. Sem vendas, margem e ticket médio vêm `null` (sem divisão por zero).
- O PDV não tem desconto: o lucro é faturamento − CMV; quando houver desconto, ele entra no faturamento gravado da venda.
- `GET /api/reports/sales-summary` agrupa os dias no fuso da loja (`TZ`), não mais em UTC — venda depois das 21h no horário de Brasília caía no dia seguinte.
- Frontend: a aba Relatórios vira o painel financeiro (atalhos Hoje, 7 dias, 30 dias, Este mês e datas livres; cards; barras por forma de pagamento; tabela dos produtos mais lucrativos), mantendo vendas por dia e produtos parados no mesmo período.

## Capabilities

### Modified Capabilities
- `reports`: painel financeiro; resumo de vendas por dia no fuso da loja.

## Impact

- `prisma/schema.prisma` + migração, `src/routes/sales.js`, `prisma/simulateSales.js`, `src/routes/reports.js`, `src/lib/queryHelpers.js`, `openspec/openapi.yaml`.
- `public/app.html`, `public/js/app.js`, `public/css/style.css`; testes de integração e E2E.
