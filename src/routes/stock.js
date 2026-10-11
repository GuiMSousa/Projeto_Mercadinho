const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { parseDateParam, parseEnumParam, clampIntParam } = require('../lib/queryHelpers');
const httpError = require('../lib/httpError');
const { dateOnly, toStoredDate, today } = require('../lib/calendar');
const { moveStock, refreshNextExpiry, lockProduct } = require('../services/stockOps');
const { URGENCY_LEVELS, batchUrgency } = require('../services/urgency');

const router = express.Router();
// Movimentações de estoque (entradas de compra e ajustes/perdas) são
// exclusivas do dono/administrador, para manter um único responsável pelos números.
router.use(authenticate, authorize('ADMIN'));

const entrySchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().finite().positive().max(1_000_000),
  reason: z.string().trim().max(255).optional().nullable(),
  expiryDate: dateOnly.optional().nullable(),
});

const adjustmentSchema = z
  .object({
    productId: z.string().uuid(),
    quantity: z
      .number()
      .finite()
      .refine((v) => v !== 0, 'A quantidade não pode ser zero.')
      .refine((v) => Math.abs(v) <= 1_000_000),
    reason: z.string().trim().min(1).max(255),
    type: z.enum(['ADJUSTMENT', 'LOSS']).default('ADJUSTMENT'),
    batchId: z.string().uuid().optional(),
    expiryDate: dateOnly.optional().nullable(),
  })
  .refine((d) => !d.expiryDate || (d.quantity > 0 && !d.batchId), {
    message: 'A validade só vale para um lote novo: quantidade positiva sem batchId.',
    path: ['expiryDate'],
  });

const batchUpdateSchema = z.object({ expiryDate: dateOnly.nullable() });

function serializeBatch(b, now = today()) {
  return {
    id: b.id,
    productId: b.productId,
    product: b.product.name,
    unit: b.product.unit,
    quantity: Number(b.quantity),
    remaining: Number(b.remaining),
    expiryDate: b.expiryDate,
    ...batchUrgency(b.expiryDate, now),
    createdAt: b.createdAt,
  };
}

router.post('/entries', validate(entrySchema), async (req, res) => {
  const { productId, quantity, reason, expiryDate } = req.body;

  const result = await prisma.$transaction((tx) =>
    moveStock(tx, {
      productId,
      quantity,
      type: 'ENTRY',
      reason: reason || 'Entrada de estoque (compra)',
      userId: req.user.sub,
      expiryDate: toStoredDate(expiryDate),
    }),
  );

  res.status(201).json({ productId, currentStock: Number(result.newStock), batch: serializeBatch(result.batch) });
});

router.post('/adjustments', validate(adjustmentSchema), async (req, res) => {
  const { productId, quantity, reason, type, batchId, expiryDate } = req.body;

  const result = await prisma.$transaction((tx) =>
    moveStock(tx, { productId, quantity, type, reason, userId: req.user.sub, batchId, expiryDate: toStoredDate(expiryDate) }),
  );

  res.status(201).json({
    productId,
    currentStock: Number(result.newStock),
    ...(result.batch && { batch: serializeBatch(result.batch) }),
  });
});

// Lotes com saldo, do que vence primeiro ao que vence por último (sem validade no fim).
router.get('/batches', async (req, res) => {
  const urgency = parseEnumParam(req.query.urgency, URGENCY_LEVELS, 'urgency');
  const where = { remaining: { gt: 0 } };
  if (req.query.productId) where.productId = String(req.query.productId);

  const batches = await prisma.stockBatch.findMany({
    where,
    include: { product: { select: { name: true, unit: true } } },
    orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  const now = today();
  const result = batches.map((b) => serializeBatch(b, now));
  res.json(urgency ? result.filter((b) => b.urgency === urgency) : result);
});

// Correção de validade digitada errada; não mexe em saldo.
router.put('/batches/:id', validate(batchUpdateSchema), async (req, res) => {
  const batch = await prisma.$transaction(async (tx) => {
    const existing = await tx.stockBatch.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpError(404, 'Lote não encontrado.');
    await lockProduct(tx, existing.productId);
    const updated = await tx.stockBatch.update({
      where: { id: existing.id },
      data: { expiryDate: toStoredDate(req.body.expiryDate) },
      include: { product: { select: { name: true, unit: true } } },
    });
    await refreshNextExpiry(tx, existing.productId);
    return updated;
  });
  res.json(serializeBatch(batch));
});

const MOVEMENT_TYPES = ['ENTRY', 'SALE', 'ADJUSTMENT', 'LOSS'];

router.get('/movements', async (req, res) => {
  const { productId } = req.query;
  const type = parseEnumParam(req.query.type, MOVEMENT_TYPES, 'type');
  const from = parseDateParam(req.query.from, 'from');
  const to = parseDateParam(req.query.to, 'to');

  const where = {};
  if (productId) where.productId = String(productId);
  if (type) where.type = type;
  if (from || to) where.createdAt = {};
  if (from) where.createdAt.gte = from;
  if (to) where.createdAt.lte = to;

  const include = { product: { select: { name: true } }, user: { select: { name: true } } };
  const serialize = (m) => ({
    id: m.id,
    product: m.product.name,
    type: m.type,
    quantity: Number(m.quantity),
    previousStock: Number(m.previousStock),
    newStock: Number(m.newStock),
    reason: m.reason,
    user: m.user.name,
    createdAt: m.createdAt,
  });

  const paginated = req.query.page !== undefined || req.query.pageSize !== undefined;
  if (!paginated) {
    const movements = await prisma.stockMovement.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return res.json(movements.map(serialize));
  }

  const page = clampIntParam(req.query.page, { min: 1, max: 1_000_000, fallback: 1 });
  const pageSize = clampIntParam(req.query.pageSize, { min: 1, max: 100, fallback: 20 });
  const [movements, totalCount] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.stockMovement.count({ where }),
  ]);
  res.json({ totalCount, page, pageSize, movements: movements.map(serialize) });
});

module.exports = router;
