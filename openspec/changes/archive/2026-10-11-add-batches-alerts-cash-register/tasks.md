# Tasks

## 1. Modelo de dados e migration

- [x] 1.1 Adicionar ao `prisma/schema.prisma` o enum `PaymentMethod`, os modelos `StockBatch`, `StockMovementBatch` e `CashSession` e as colunas `Sale.paymentMethod`/`Sale.cashSessionId`; verificar com `npx prisma validate`
- [x] 1.2 Criar a migration com `npm run prisma:migrate -- --create-only --name add_batches_and_cash_sessions` e acrescentar o preenchimento (um lote por produto com saldo, validade nula nos produtos sem saldo); verificar no banco de desenvolvimento que a soma dos lotes bate com `currentStock` em todos os produtos e que `prisma migrate diff` não acusa drift
- [x] 1.3 Atualizar `resetDb` em `test/helpers/db.js` para apagar as tabelas novas na ordem das chaves estrangeiras; verificar que `npm test` continua passando

## 2. Lotes e baixa por PVPS

- [x] 2.1 Implementar em `src/services/stockOps.js` a criação de lote, a baixa por PVPS (ordem de venda, ordem de perda e lote indicado), a devolução de alocações e o recálculo da validade do produto, com `Prisma.Decimal`; verificar pelos testes da tarefa 2.6
- [x] 2.2 Ligar lotes em `routes/stock.js`: entrada com `expiryDate`, ajuste com `batchId`/`expiryDate`, `GET /api/stock/batches` e `PUT /api/stock/batches/{id}`; verificar pelos testes da tarefa 2.6
- [x] 2.3 Ligar lotes em `routes/sales.js`: baixa por PVPS com alocações na venda e devolução aos lotes de origem no cancelamento (venda antiga sem alocação volta num lote novo); verificar pelos testes da tarefa 2.6
- [x] 2.4 Ligar lotes em `routes/products.js`: estoque inicial cria o primeiro lote e a regra de edição da validade (igual ignora, uniforme aplica, sem saldo 400, divergente 409); verificar pelos testes da tarefa 2.6
- [x] 2.5 Ligar lotes em `routes/imports.js`: aumento de saldo cria lote com a validade da linha, redução baixa pela ordem de perda e validade em linha sem lote segue a regra do produto com aviso na conferência; verificar com os testes de importação existentes e um novo
- [x] 2.6 Cobrir em `test/integration.test.js`: ordem PVPS da venda, venda pulando lote vencido, perda baixando o vencido, cancelamento devolvendo ao lote de origem, soma dos lotes igual ao saldo, consulta e correção de lote, edição de validade (ignorada, aplicada e 409); verificar com `npm test`
- [x] 2.7 Fazer `prisma/seedProducts.js` e `prisma/simulateSales.js` usarem lotes; verificar rodando os dois no banco de desenvolvimento e conferindo a soma dos lotes
- [x] 2.8 Documentar em `openspec/openapi.yaml` as rotas e campos de lotes (entrada, ajuste, `GET`/`PUT /api/stock/batches`); verificar com `npm run spec:check`

## 3. Semáforo de urgência

- [x] 3.1 Criar `src/services/urgency.js` (vermelho, amarelo, verde e motivos, com "hoje" no calendário do servidor) e incluir `urgency`, `urgencyReasons` e `daysToExpiry` em toda resposta de produto; verificar pelos testes da tarefa 3.3
- [x] 3.2 Aceitar `GET /api/products?urgency=` combinável com os demais filtros e a paginação, com 400 para valor inválido; verificar pelos testes da tarefa 3.3
- [x] 3.3 Cobrir em `test/integration.test.js` os quatro casos do semáforo e o filtro; verificar com `npm test`
- [x] 3.4 Documentar o semáforo e o filtro em `openspec/openapi.yaml` e `TZ` no `.env.example` e no `docker-compose.yml`; verificar com `npm run spec:check`

## 4. Lista de compras

- [x] 4.1 Criar `src/routes/shoppingList.js` (`GET /api/shopping-list`, JSON e `format=text`) e montar em `src/app.js`; verificar pelos testes da tarefa 4.2
- [x] 4.2 Cobrir em `test/integration.test.js`: produto no mínimo entra, acima do mínimo e desativado ficam de fora, texto agrupado por categoria e formato inválido 400; verificar com `npm test`
- [x] 4.3 Documentar a rota em `openspec/openapi.yaml`; verificar com `npm run spec:check`

## 5. Caixa e forma de pagamento

- [x] 5.1 Aceitar `paymentMethod` (padrão `CASH`) na venda e devolvê-lo na criação, no histórico e no detalhe; ligar a venda ao caixa aberto com lock compartilhado; verificar pelos testes da tarefa 5.3
- [x] 5.2 Criar `src/routes/cashSessions.js` (abrir, atual, fechar com conciliação gravada, histórico e detalhe; fechamento cego para CASHIER) e montar em `src/app.js`; verificar pelos testes da tarefa 5.3
- [x] 5.3 Cobrir em `test/integration.test.js`: conta do esperado só com dinheiro, venda cancelada fora do esperado, segunda abertura 409, fechamento cego, histórico 403 para CASHIER e vendas simultâneas ao fechamento; verificar com `npm test`
- [x] 5.4 Documentar as rotas de caixa e o `paymentMethod` em `openspec/openapi.yaml`; verificar com `npm run spec:check`

## 6. Integração final

- [x] 6.1 Rodar `npm test` e `npm run spec:check` do zero e confirmar 100% verde
- [x] 6.2 Atualizar `README.md` e `DOCUMENTATION.md` (funcionalidades, modelo de dados e rotas novas); verificar que os comandos documentados rodam
- [x] 6.3 Smoke test de todas as rotas contra o servidor rodando, validando cada resposta pelo `openapi.yaml`
