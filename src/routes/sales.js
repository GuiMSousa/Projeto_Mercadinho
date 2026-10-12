const express = require('express');
const { z } = require('zod');
const { PaymentMethod } = require('@prisma/client');
const prisma = require('../db');
const validate = require('../middleware/validate');
const httpError = require('../lib/httpError');
const { authenticate, authorize } = require('../middleware/auth');
const { parseDateParam, clampIntParam } = require('../lib/queryHelpers');
const { moveStock } = require('../services/stockOps');

const router = express.Router();
router.use(authenticate);

// Limite bem abaixo da capacidade da coluna Decimal(12,2) do banco
// (até 9.999.999.999,99). Mantém uma margem enorme de segurança: mesmo o
// pior caso (100 itens, cada um neste teto) nunca se aproxima do limite do
// tipo de dado, então uma venda jamais pode disparar um erro de overflow
// numérico no PostgreSQL — o limite de negócio é sempre atingido primeiro.
const MAX_SALE_TOTAL = 5_000_000;

const saleSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().finite().positive().max(10_000),
      }),
    )
    .min(1, 'A venda precisa de ao menos um item.')
    .max(100),
  // Opcional: a tela atual ainda não envia, e até lá tudo conta como dinheiro.
  paymentMethod: z.enum(Object.values(PaymentMethod)).default('CASH'),
});

router.post('/', validate(saleSchema), async (req, res) => {
  const { items, paymentMethod } = req.body;

  const productIds = items.map((i) => i.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw httpError(400, 'Itens duplicados na venda; agrupe as quantidades em um único item.');
  }

  const sale = await prisma.$transaction(async (tx) => {
    // Lock compartilhado no caixa aberto: o fechamento (lock exclusivo) espera esta
    // venda terminar antes de somar o caixa, e uma venda que chega depois do
    // fechamento já não o encontra aberto. Vendas não se bloqueiam entre si.
    const [openSession] = await tx.$queryRaw`SELECT "id" FROM "CashSession" WHERE "isOpen" = true FOR SHARE`;
    const created = await tx.sale.create({
      data: { sellerId: req.user.sub, totalAmount: '0', paymentMethod, cashSessionId: openSession?.id ?? null },
    });

    // Uma única consulta para todos os itens, em vez de um SELECT por item
    // dentro do laço (N+1). Numa venda de 20 itens isso troca 20 idas ao
    // banco por 1 só, encurtando a duração da transação — o que também
    // reduz o tempo que a linha de cada produto fica travada pelo UPDATE
    // atômico logo abaixo.
    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    const productById = new Map(products.map((p) => [p.id, p]));

    // Em centavos: cada item é arredondado e o total é a soma dos itens, como no cupom.
    // Somar os valores sem arredondar fazia o total diferir da soma do recibo em R$ 0,01
    // com quantidade fracionada (ex.: 0,333 kg).
    let totalCents = 0;
    const saleItems = [];

    for (const item of items) {
      const product = productById.get(item.productId);
      if (!product || !product.active) throw httpError(404, 'Um dos produtos da venda não foi encontrado.');

      const unitPrice = Number(product.salePrice);
      const subtotalCents = Math.round(unitPrice * item.quantity * 100);
      totalCents += subtotalCents;
      const subtotal = subtotalCents / 100;
      const total = totalCents / 100;
      // Barreira de segurança: nunca deixa o total computado em memória chegar
      // perto da capacidade da coluna numeric(12,2) do banco. Sem isso, uma
      // combinação extrema de preço × quantidade × itens estouraria a coluna
      // e o PostgreSQL rejeitaria o INSERT com um erro interno não tratado.
      if (subtotal > MAX_SALE_TOTAL || total > MAX_SALE_TOTAL) {
        throw httpError(400, 'O valor da venda excede o limite permitido pelo sistema.');
      }

      // UPDATE condicional atômico (nunca vende além do saldo, nem com vendas
      // simultâneas do mesmo item), baixa dos lotes na ordem PVPS de venda e o
      // extrato com o saldo real relido na própria transação.
      await moveStock(tx, {
        productId: item.productId,
        quantity: -item.quantity,
        type: 'SALE',
        reason: 'Venda',
        userId: req.user.sub,
        saleId: created.id,
        order: 'SALE',
        notFoundMessage: 'Um dos produtos da venda não foi encontrado.',
        insufficient: (current) =>
          httpError(409, `Estoque insuficiente para "${product.name}" (disponível: ${Number(current.currentStock)}).`),
      });
      saleItems.push({
        saleId: created.id,
        productId: item.productId,
        quantity: item.quantity.toFixed(3),
        unitPrice: unitPrice.toFixed(2),
        subtotal: subtotal.toFixed(2),
      });
    }
    await tx.saleItem.createMany({ data: saleItems }); // um INSERT só, em vez de um por item

    return tx.sale.update({
      where: { id: created.id },
      data: { totalAmount: (totalCents / 100).toFixed(2) },
      include: { items: { include: { product: { select: { name: true, unit: true } } } } },
    });
  }, { timeout: 15_000, maxWait: 5_000 });
  // Timeout maior que o padrão do Prisma (5s): uma venda com até 100 itens faz
  // várias consultas sequenciais por item dentro da mesma transação, e sob
  // carga isso poderia estourar o limite padrão e falhar sem necessidade.

  res.status(201).json({
    id: sale.id,
    totalAmount: Number(sale.totalAmount),
    paymentMethod: sale.paymentMethod,
    createdAt: sale.createdAt,
    itemCount: sale.items.length,
    items: sale.items.map((i) => ({
      product: i.product.name,
      unit: i.product.unit,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      subtotal: Number(i.subtotal),
    })),
  });
});

router.get('/', async (req, res) => {
  const page = clampIntParam(req.query.page, { min: 1, max: 1_000_000, fallback: 1 });
  const pageSize = clampIntParam(req.query.pageSize, { min: 1, max: 100, fallback: 20 });
  const from = parseDateParam(req.query.from, 'from');
  const to = parseDateParam(req.query.to, 'to');

  const where = { canceled: false };
  // Funcionário (caixa) só enxerga as próprias vendas; só o administrador vê todas.
  if (req.user.role !== 'ADMIN') where.sellerId = req.user.sub;
  if (from || to) where.createdAt = {};
  if (from) where.createdAt.gte = from;
  if (to) where.createdAt.lte = to;

  const [sales, totalCount] = await Promise.all([
    prisma.sale.findMany({
      where,
      include: { seller: { select: { name: true } }, _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.sale.count({ where }),
  ]);

  res.json({
    totalCount,
    page,
    pageSize,
    sales: sales.map((s) => ({
      id: s.id,
      seller: s.seller.name,
      totalAmount: Number(s.totalAmount),
      paymentMethod: s.paymentMethod,
      itemCount: s._count.items,
      createdAt: s.createdAt,
    })),
  });
});

router.get('/:id', async (req, res) => {
  const sale = await prisma.sale.findUnique({
    where: { id: req.params.id },
    include: { seller: { select: { name: true } }, items: { include: { product: { select: { name: true } } } } },
  });
  if (!sale) throw httpError(404, 'Venda não encontrada.');
  if (req.user.role !== 'ADMIN' && sale.sellerId !== req.user.sub) {
    throw httpError(403, 'Sem permissão para ver esta venda.');
  }

  res.json({
    id: sale.id,
    seller: sale.seller.name,
    totalAmount: Number(sale.totalAmount),
    paymentMethod: sale.paymentMethod,
    canceled: sale.canceled,
    createdAt: sale.createdAt,
    items: sale.items.map((i) => ({
      product: i.product.name,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      subtotal: Number(i.subtotal),
    })),
  });
});

router.post('/:id/cancel', authorize('ADMIN'), async (req, res) => {
  const sale = await prisma.$transaction(async (tx) => {
    const existing = await tx.sale.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { product: { select: { expiryDate: true } } } } },
    });
    if (!existing) throw httpError(404, 'Venda não encontrada.');
    // Compare-and-set: com dois cancelamentos simultâneos da mesma venda, só um
    // passa daqui — o outro espera o lock da linha e recebe 409, sem devolver o
    // estoque em dobro.
    const claimed = await tx.sale.updateMany({ where: { id: existing.id, canceled: false }, data: { canceled: true } });
    if (claimed.count === 0) throw httpError(409, 'Venda já cancelada.');

    // De quais lotes cada item saiu (vendas anteriores aos lotes não têm esse rastro).
    const saleMovements = await tx.stockMovement.findMany({
      where: { saleId: existing.id, type: 'SALE' },
      include: { batches: true },
    });
    const allocationsByProduct = new Map(saleMovements.map((m) => [m.productId, m.batches]));

    for (const item of existing.items) {
      const allocations = allocationsByProduct.get(item.productId) ?? [];
      await moveStock(tx, {
        productId: item.productId,
        quantity: Number(item.quantity),
        type: 'ADJUSTMENT',
        reason: `Cancelamento da venda ${existing.id}`,
        userId: req.user.sub,
        saleId: existing.id,
        // A venda pode ter sido de um produto já descontinuado; o estoque físico
        // ainda precisa voltar mesmo assim.
        requireActive: false,
        // Volta aos lotes de onde saiu; venda sem rastro volta num lote novo com a
        // validade atual do produto.
        ...(allocations.length ? { restore: allocations } : { expiryDate: item.product.expiryDate }),
      });
    }
    return { id: existing.id, canceled: true };
  }, { timeout: 15_000, maxWait: 5_000 });

  res.json(sale);
});

module.exports = router;
