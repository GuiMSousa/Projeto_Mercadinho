# Design

## Context

Ver proposal.md (Why). Estado atual que molda a solução:

- O saldo vive em `Product.currentStock`. Toda alteração passa por um `UPDATE` condicional atômico (`services/stockOps.js` e a baixa da venda); esse `UPDATE` também segura o lock da linha do produto até o fim da transação — é o que hoje impede venda além do estoque e "lost update".
- A validade é um campo único `Product.expiryDate`, lido pelo painel (`expiring`), pelo e-mail diário, pela listagem de produtos e pela importação.
- O frontend atual precisa continuar funcionando sem mudanças: o formulário de edição de produto **sempre reenvia** `expiryDate`; a entrada de estoque não envia validade; o ajuste da tela é sempre uma perda negativa (`type: LOSS`) sem lote; a venda envia só os itens.
- Perfis continuam `ADMIN` (único) e `CASHIER`; estoque, relatórios e usuários são exclusivos do ADMIN.

## Goals / Non-Goals

**Goals:**
- Lotes com o invariante "soma dos saldos dos lotes = `currentStock`", mantido na mesma transação de toda operação de estoque.
- Rastreabilidade por lote em cada movimentação, para o cancelamento devolver exatamente ao lote de origem.
- Fechamento de caixa exato mesmo com vendas acontecendo no instante do fechamento.
- Compatibilidade total com o frontend e com os testes existentes.

**Non-Goals:**
- Telas novas no frontend (o pedido é só backend).
- Troco e valor recebido, validação "valor pago menor que o total", comprovante por WhatsApp e PDF (itens do relatório fora deste pedido).
- App mobile/offline-first (Flutter/Firebase do relatório): a API atual continua sendo o backend.
- Mudança de perfis do relatório (esposa com acesso total; sobrinho/funcionário lançando entradas de lote). Hoje existe um único ADMIN e só ele mexe em estoque — mudar isso é decisão de negócio à parte.
- Vários caixas abertos ao mesmo tempo, sangria/suprimento e código de lote do fornecedor.

## Decisions

1. **Lotes em tabela própria (`StockBatch`) + alocação por movimentação (`StockMovementBatch`)**, mantendo `Product.currentStock`.
   O `UPDATE` condicional do produto segue como trava de concorrência e fonte de leitura rápida; os lotes são atualizados logo depois, na mesma transação. Como o lock da linha do produto fica preso até o commit, toda escrita em lotes de um produto já é serializada sem locks novos (ordem fixa: produto → lotes).
   *Alternativas:* calcular o saldo só pela soma dos lotes (quebraria a trava atômica e todos os leitores atuais); lotes sem alocação (o cancelamento não saberia para qual lote devolver).

2. **`Product.expiryDate` vira a validade mais próxima entre os lotes com saldo**, recalculada na mesma transação de cada operação.
   Painel, e-mail diário, listagem, importação e semáforo continuam lendo um campo só, sem join. *Alternativa:* calcular na leitura com `groupBy` (consulta extra em toda listagem).

3. **Duas ordens de PVPS.** Venda: lotes não vencidos pela validade mais próxima, sem validade por último, desempate pelo mais antigo; vencidos só se faltar. Perda/ajuste negativo sem lote: validade mais antiga primeiro, vencidos inclusive.
   Assim o "Vencido" lançado pela tela atual (sem lote) zera o lote vencido, e a venda de uma unidade boa não "esconde" unidades vencidas que ainda estão na prateleira. *Alternativas:* PVPS puro também na venda (o alerta de vencido sumiria sem a mercadoria ter saído); bloquear a venda quando só restam vencidos (pararia o caixa sempre que uma perda não foi lançada). Ficou sem bloqueio; trocar para bloqueio é uma mudança localizada.

4. **Conta exata com `Prisma.Decimal`** na distribuição entre lotes (quantidades fracionadas como 0,5 kg não acumulam erro de ponto flutuante).

5. **Validade editada pelo produto só quando é inequívoca.** Igual à atual: ignorada (a tela reenvia sempre). Diferente: aplicada se todos os lotes com saldo têm a mesma validade; 400 sem saldo; 409 com validades diferentes, apontando `PUT /api/stock/batches/{id}`. A importação usa a mesma regra, mas como aviso, para não descartar o resto da linha.

6. **Semáforo calculado na leitura** a partir de `currentStock`, `minStock` e da validade derivada; limites fixos de 7 e 30 dias (definidos pelo relatório). "Hoje" é a data de calendário do servidor; `TZ=America/Sao_Paulo` no ambiente faz isso valer o calendário da loja.

7. **Um caixa aberto por vez via coluna única anulável `isOpen`** (`true` enquanto aberto, `null` depois de fechado). O índice único do PostgreSQL aceita vários `NULL`, então só um caixa pode estar aberto, inclusive com aberturas simultâneas (a segunda recebe P2002 → 409). *Alternativa:* índice parcial em SQL cru — o Prisma 5 não o representa e o `migrate dev` acusaria drift.

8. **Venda × fechamento sem corrida.** A venda faz `SELECT … FOR SHARE` na linha do caixa aberto no início da transação e grava o vínculo; o fechamento faz um `UPDATE` condicional (lock exclusivo) antes de somar as vendas. Fechamento espera vendas em andamento; vendas não se bloqueiam entre si; venda que chega depois do fechamento não encontra caixa aberto. *Alternativas:* somar por janela de horário (perde vendas em trânsito); lock exclusivo por venda (serializaria todas as vendas da loja).

9. **Esperado = fundo + vendas em dinheiro não canceladas ligadas ao caixa**, gravado no fechamento junto com o contado. Cancelamentos depois do fechamento não reescrevem o fechamento. Totais por forma de pagamento são calculados na leitura.

10. **Fechamento cego para CASHIER** (só vê o que informou) e histórico só para ADMIN — consequência direta da regra já existente de que o funcionário não vê números financeiros.

11. **`paymentMethod` opcional com padrão `CASH`**, para a tela atual continuar vendendo; com isso, até o frontend mandar a forma de pagamento, toda venda conta como dinheiro (o comportamento de hoje).

12. **Lista de compras reaproveita `getStockForecast()`** (já calcula `lowStock`, média diária e dias até esgotar) e só acrescenta a categoria; `format=text` gera o texto para WhatsApp.

13. **Vendas anteriores aos lotes** (sem alocação registrada) voltam, no cancelamento, num lote novo com a validade atual do produto.

14. **Rotas**: lotes ficam no roteador de estoque (`/api/stock/batches`, ADMIN); lista de compras e caixa ganham roteadores próprios; `/api/cash-sessions/current` é declarada antes de `/:id`.

## Risks / Trade-offs

- [Venda pode consumir lote vencido quando os válidos acabam] → o lote vencido segue no semáforo até a perda ser lançada; bloqueio pode ser adotado depois sem mexer no modelo.
- [Uma consulta a mais por venda (lock compartilhado no caixa)] → custo desprezível no volume de um mercadinho; vendas não se bloqueiam entre si.
- [Invariante quebrado por edição manual no banco] → a operação falha com erro registrado no log em vez de gravar saldo errado.
- ["Dias para vencer" depende do fuso do servidor] → `TZ` documentado no `.env.example` e no `docker-compose.yml`.
- [Produtos sem saldo perdem a validade na migração] → a validade só tem sentido com mercadoria; volta a existir na próxima entrada.

## Migration Plan

1. `npm run prisma:deploy` aplica a migration: cria `StockBatch`, `StockMovementBatch`, `CashSession`, o enum `PaymentMethod` e as colunas novas de `Sale`; cria um lote por produto com saldo (validade = a do produto) e zera a validade dos produtos sem saldo.
2. Sobe a versão nova do código.
3. Rollback: o código anterior funciona com o schema novo (colunas novas têm padrão ou aceitam nulo e as tabelas novas são ignoradas); para desfazer o schema, restaurar o backup do banco.
