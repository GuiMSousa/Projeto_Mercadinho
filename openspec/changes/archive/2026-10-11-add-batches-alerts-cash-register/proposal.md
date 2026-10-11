# Proposal

## Why

O relatório de requisitos do Mercadinho ataca três perdas do dia a dia: produto vencido na prateleira, produto em falta e diferença no fechamento do caixa. Hoje o sistema guarda uma única validade por produto (não por lote), dá baixa sem critério de validade, não gera lista de compras e não tem abertura nem fechamento de caixa — então nada disso é controlado.

## What Changes

- Estoque passa a ser organizado em **lotes**: cada entrada cria um lote com quantidade e validade (opcional); toda saída baixa dos lotes e cada movimentação registra quanto mexeu em cada lote. O estoque já existente vira um lote por produto na migração.
- Baixa por **PVPS** (Primeiro que Vence, Primeiro que Sai): vendas consomem primeiro o lote válido que vence antes; perdas e ajustes sem lote indicado consomem primeiro os vencidos. O cancelamento de venda devolve a mercadoria aos mesmos lotes.
- A validade exibida do produto (`expiryDate`) passa a ser a **mais próxima entre os lotes com saldo**. Editar a validade pelo produto só é aceito quando ela é inequívoca; lotes podem ter a validade corrigida individualmente.
- **Semáforo de urgência** em todo produto (`GREEN`, `YELLOW`, `RED`, com os motivos) e filtro `GET /api/products?urgency=`.
- **Lista de compras** automática (`GET /api/shopping-list`) com os produtos de estoque menor ou igual ao mínimo, também em texto pronto para o WhatsApp.
- **Caixa**: abertura com fundo de troco, vínculo das vendas ao caixa aberto, forma de pagamento na venda (dinheiro, Pix, débito, crédito; padrão dinheiro) e fechamento que compara o dinheiro contado com o esperado. Para o caixa (funcionário) o fechamento é cego; o administrador vê esperado, diferença e totais por forma de pagamento, além do histórico.
- Compatível com o frontend atual: nenhum campo novo é obrigatório e nenhuma resposta perde campos.

## Capabilities

### New Capabilities
- `shopping-list`: lista de compras gerada a partir do estoque mínimo, em JSON e em texto para WhatsApp.
- `cash-register`: abertura e fechamento de caixa, vínculo das vendas, conciliação do dinheiro e histórico.

### Modified Capabilities
- `stock`: entradas criam lotes com validade; ajustes e perdas podem mirar um lote; baixa por PVPS; consulta e correção de lotes.
- `products`: validade derivada dos lotes, regras para editar a validade, semáforo de urgência e filtro por urgência.
- `sales`: forma de pagamento, baixa por PVPS e cancelamento que devolve aos lotes de origem.
- `product-import`: linhas que somam estoque criam lotes com a validade da planilha; validade em linhas sem lote novo segue a regra do produto.

## Impact

- **Banco (nova migration Prisma)**: tabelas `StockBatch`, `StockMovementBatch` e `CashSession`; enum `PaymentMethod`; colunas `Sale.paymentMethod` e `Sale.cashSessionId`; preenchimento dos lotes a partir do estoque atual.
- **Contrato HTTP (`openspec/openapi.yaml`)**: novas rotas `GET /api/stock/batches`, `PUT /api/stock/batches/{id}`, `GET /api/shopping-list` e `/api/cash-sessions` (abrir, atual, fechar, histórico, detalhe); campos novos e opcionais em produtos, entradas, ajustes e vendas.
- **Código**: `services/stockOps.js` (lotes e PVPS), novo `services/urgency.js`, rotas de produtos, estoque, vendas e importação, novas rotas `shoppingList.js` e `cashSessions.js`; scripts `seedProducts.js` e `simulateSales.js` passam a usar lotes.
- **Configuração**: `TZ` recomendado no `.env` para que "dias para vencer" use o calendário da loja.
- **Sem dependências novas.**
