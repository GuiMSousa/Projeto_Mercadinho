# Proposal

## Why

O controle de caixa (abertura, vendas por forma de pagamento, fechamento com quebra) já existe, mas faltam duas coisas do dia a dia do balcão: registrar dinheiro que sai da gaveta no meio do dia (sangria: depósito no banco, pagamento de fornecedor) ou que entra (suprimento: mais troco), e impedir venda com o caixa fechado — hoje ela é aceita e fica fora de qualquer fechamento, o que desmonta a conciliação. Com o sistema aberto em mais de um aparelho (PC e iPhone), só o servidor consegue barrar com segurança a venda feita depois que outro aparelho fechou o caixa.

## What Changes

- **Sangria e suprimento**: `POST /api/cash-sessions/current/movements` com tipo (`WITHDRAWAL` = sangria, `DEPOSIT` = suprimento), valor maior que zero e motivo obrigatório, no caixa aberto. Tabela nova `CashMovement`.
- **Dinheiro esperado** passa a ser: fundo de troco + vendas em dinheiro − sangrias + suprimentos — no resumo ao vivo, no fechamento gravado e no histórico. O resumo do ADMIN traz os totais e a lista de movimentações.
- **BREAKING**: venda sem caixa aberto passa a receber 409.
- Os nomes pedidos (`/api/caixa/status`, `abrir`, `movimentacao`, `resumo`, `fechar`) ficam nos endpoints que já existem, no padrão em inglês da API: `GET /api/cash-sessions/current` (status e resumo), `POST /api/cash-sessions` (abrir), `POST /api/cash-sessions/current/movements` (novo), `POST /api/cash-sessions/current/close` (fechar).

## Capabilities

### Modified Capabilities
- `cash-register`: sangria e suprimento; esperado com as movimentações; venda bloqueada sem caixa aberto.

## Impact

- `prisma/schema.prisma` + migração, `src/routes/cashSessions.js`, `src/routes/sales.js`, `openspec/openapi.yaml`, `test/helpers/db.js`.
- Frontend: botões e modal de sangria/suprimento na aba Caixa, resumo com sobra/falta ao vivo no fechamento do ADMIN (o do CASHIER continua cego), PDV bloqueado com caixa fechado.
