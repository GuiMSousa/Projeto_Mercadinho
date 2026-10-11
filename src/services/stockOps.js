const { Prisma } = require('@prisma/client');
const httpError = require('../lib/httpError');
const { today } = require('../lib/calendar');

const { Decimal } = Prisma;

// Bem abaixo da capacidade da coluna Decimal(12,3) (~999.999.999,999) —
// impede que somas repetidas eventualmente estourem a coluna.
const MAX_STOCK = 50_000_000;

// Aplica um delta ao estoque de forma atômica: um UPDATE condicional cujo
// WHERE já garante que o resultado fica dentro de [0, MAX_STOCK], usando
// `increment` (a soma é feita pelo próprio banco, nunca "ler em JS e
// escrever de volta um valor absoluto"). Sem isso, duas requisições
// concorrentes para o mesmo produto podem ler o mesmo valor "antes", cada
// uma calcular seu próprio "depois" e a segunda escrita sobrescrever
// silenciosamente a primeira — um "lost update" clássico. Reproduzido ao
// vivo: 30 entradas simultâneas de +1 no mesmo produto resultavam num
// estoque final de 16 em vez de 30, com as 30 movimentações de auditoria
// registradas mesmo assim — o extrato dizia uma coisa, o saldo real dizia outra.
//
// Chamado por moveStock (abaixo), por onde passa toda rota que soma/subtrai de
// Product.currentStock: venda, entradas, ajustes/perdas, cancelamento e importação.
//
// `requireActive` é true por padrão (entradas/ajustes são ações deliberadas
// sobre um produto presumivelmente ativo), mas o cancelamento de venda passa
// `false`: se o produto foi descontinuado depois da venda, cancelar a venda
// ainda precisa devolver o estoque físico — a mercadoria existe fisicamente
// independente do produto estar ou não à venda no momento do cancelamento.
//
// `insufficient(product)` troca o erro de saldo insuficiente (a venda responde
// 409 com o nome do produto em vez do 400 genérico).
async function applyStockDelta(tx, productId, quantity, { notFoundMessage = 'Produto não encontrado.', requireActive = true, insufficient } = {}) {
  const bound = quantity >= 0 ? { lte: (MAX_STOCK - quantity).toFixed(3) } : { gte: (-quantity).toFixed(3) };
  const updateResult = await tx.product.updateMany({
    where: { id: productId, ...(requireActive ? { active: true } : {}), currentStock: bound },
    data: { currentStock: { increment: quantity } },
  });
  if (updateResult.count === 0) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product || (requireActive && !product.active)) throw httpError(404, notFoundMessage);
    if (quantity < 0 && insufficient) throw insufficient(product);
    throw httpError(400, quantity < 0 ? 'Essa operação deixaria o estoque negativo.' : 'Essa operação deixaria o estoque acima do limite permitido pelo sistema.');
  }
  // Novo valor lido dentro da MESMA transação: reflete com exatidão o que a
  // própria transação acabou de gravar, mesmo que outras transações
  // concorrentes ainda não enxerguem essa mudança.
  const updated = await tx.product.findUnique({ where: { id: productId } });
  const newStock = Number(updated.currentStock);
  const previousStock = (newStock - quantity).toFixed(3);
  return { updated, previousStock, newStock: newStock.toFixed(3) };
}

// ---------- Lotes ----------
// O saldo do produto é a soma do `remaining` dos seus lotes. Toda escrita em
// lotes acontece DEPOIS do UPDATE atômico do produto, na mesma transação: esse
// UPDATE trava a linha do produto até o commit, então as operações sobre os
// lotes de um mesmo produto já ficam em fila, sem precisar de outro lock.

const BY_EXPIRY = [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }];

async function addBatch(tx, productId, quantity, expiryDate) {
  const amount = new Decimal(quantity).toFixed(3);
  const batch = await tx.stockBatch.create({
    data: { productId, quantity: amount, remaining: amount, expiryDate },
    include: { product: { select: { name: true, unit: true } } },
  });
  return { batch, allocations: [{ batchId: batch.id, quantity: amount }] };
}

// PVPS (Primeiro que Vence, Primeiro que Sai). Venda: lotes válidos pela validade
// mais próxima (sem validade por último), vencidos só se faltar — vender uma
// unidade boa não pode "sumir" com as vencidas que seguem na prateleira. Perda e
// ajuste: validade mais antiga primeiro, vencidos inclusive — é o que faz o
// "Vencido" lançado sem lote zerar o lote vencido.
async function consumeBatches(tx, productId, amount, order) {
  const open = await tx.stockBatch.findMany({ where: { productId, remaining: { gt: 0 } }, orderBy: BY_EXPIRY });
  let queue = open;
  if (order === 'SALE') {
    const firstSellableDay = today();
    const expired = (b) => b.expiryDate !== null && b.expiryDate < firstSellableDay;
    queue = [...open.filter((b) => !expired(b)), ...open.filter(expired)];
  }

  let left = new Decimal(amount);
  let emptiedBatch = false;
  const allocations = [];
  for (const batch of queue) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, batch.remaining);
    await tx.stockBatch.update({ where: { id: batch.id }, data: { remaining: { decrement: take } } });
    allocations.push({ batchId: batch.id, quantity: take.negated() });
    if (take.eq(batch.remaining)) emptiedBatch = true;
    left = left.minus(take);
  }
  // O saldo do produto já passou na checagem atômica: faltar lote significa que a
  // soma dos lotes deixou de bater com o saldo (alguém mexeu no banco por fora).
  if (left.gt(0)) throw new Error(`Lotes do produto ${productId} somam menos que o saldo (faltaram ${left} na baixa).`);
  return { allocations, emptiedBatch };
}

async function changeBatch(tx, productId, batchId, quantity) {
  const batch = await tx.stockBatch.findFirst({ where: { id: batchId, productId } });
  if (!batch) throw httpError(404, 'Lote não encontrado neste produto.');
  const delta = new Decimal(quantity);
  if (batch.remaining.plus(delta).lt(0)) throw httpError(400, 'Essa operação deixaria o saldo do lote negativo.');
  await tx.stockBatch.update({ where: { id: batchId }, data: { remaining: { increment: delta } } });
  return [{ batchId, quantity: delta }];
}

// Devolve aos lotes de origem o que uma movimentação tirou deles.
async function restoreAllocations(tx, allocations) {
  const restored = [];
  for (const a of allocations) {
    const amount = new Decimal(a.quantity).negated();
    await tx.stockBatch.update({ where: { id: a.batchId }, data: { remaining: { increment: amount } } });
    restored.push({ batchId: a.batchId, quantity: amount });
  }
  return restored;
}

// Product.expiryDate = validade mais próxima entre os lotes com saldo (null sem lotes).
async function refreshNextExpiry(tx, productId) {
  const { _min } = await tx.stockBatch.aggregate({ where: { productId, remaining: { gt: 0 } }, _min: { expiryDate: true } });
  await tx.product.update({ where: { id: productId }, data: { expiryDate: _min.expiryDate } });
}

// Trava a linha do produto até o commit, na mesma ordem (produto, depois lotes)
// de toda operação de estoque — duas transações nunca se travam mutuamente.
const lockProduct = (tx, productId) => tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() } });

// Toda alteração de saldo passa por aqui: saldo atômico do produto, lotes, a
// movimentação com o rastro por lote e a validade derivada do produto.
// Positiva sem `batchId` cria um lote (com `expiryDate`); com `batchId` mexe só
// naquele lote; negativa sem lote baixa pelo PVPS na `order` pedida ('SALE' ou
// 'LOSS'); `restore` devolve as alocações de uma venda cancelada.
async function moveStock(tx, { productId, quantity, type, reason = null, userId, saleId = null, expiryDate = null, batchId = null, restore = null, order = 'LOSS', ...guard }) {
  const { previousStock, newStock } = await applyStockDelta(tx, productId, quantity, guard);

  let batch = null;
  let allocations;
  let expiryMayChange = true;
  if (restore) allocations = await restoreAllocations(tx, restore);
  else if (batchId) allocations = await changeBatch(tx, productId, batchId, quantity);
  else if (quantity > 0) ({ batch, allocations } = await addBatch(tx, productId, quantity, expiryDate));
  // A validade do produto é a menor entre os lotes com saldo: uma baixa só a muda
  // quando zera algum lote — pular o recálculo no resto poupa 2 consultas por item.
  else ({ allocations, emptiedBatch: expiryMayChange } = await consumeBatches(tx, productId, -quantity, order));

  const movement = await tx.stockMovement.create({
    data: { productId, type, quantity: new Decimal(quantity).toFixed(3), previousStock, newStock, reason, userId, saleId, batches: { create: allocations } },
  });
  if (expiryMayChange) await refreshNextExpiry(tx, productId);
  return { previousStock, newStock, batch, movement };
}

// Validade pedida para o produto inteiro (tela de produto ou planilha). Igual à
// atual não muda nada — a tela de edição reenvia a validade a cada salvamento.
// Diferente, só é aplicada sem ambiguidade: todos os lotes com saldo com a mesma validade.
function expiryChange(current, openExpiries, requested) {
  const time = (d) => (d ? d.getTime() : null);
  if (time(requested) === time(current)) return 'unchanged';
  if (openExpiries.length === 0) return 'no-stock';
  return new Set(openExpiries.map(time)).size === 1 ? 'apply' : 'mixed';
}

async function openBatchExpiries(tx, productId) {
  const open = await tx.stockBatch.findMany({ where: { productId, remaining: { gt: 0 } }, select: { expiryDate: true } });
  return open.map((b) => b.expiryDate);
}

async function setOpenBatchesExpiry(tx, productId, expiryDate) {
  await tx.stockBatch.updateMany({ where: { productId, remaining: { gt: 0 } }, data: { expiryDate } });
  await refreshNextExpiry(tx, productId);
}

module.exports = {
  MAX_STOCK,
  applyStockDelta,
  moveStock,
  refreshNextExpiry,
  lockProduct,
  expiryChange,
  openBatchExpiries,
  setOpenBatchesExpiry,
};
