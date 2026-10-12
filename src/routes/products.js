const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const validate = require('../middleware/validate');
const httpError = require('../lib/httpError');
const { authenticate, authorize } = require('../middleware/auth');
const { clampIntParam, parseEnumParam } = require('../lib/queryHelpers');
const { dateOnly, toStoredDate, today } = require('../lib/calendar');
const { moveStock, lockProduct, expiryChange, openBatchExpiries, setOpenBatchesExpiry } = require('../services/stockOps');
const { URGENCY_LEVELS, productUrgency } = require('../services/urgency');

const router = express.Router();
router.use(authenticate);

const money = z.number().finite().nonnegative().max(1_000_000);

const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(150),
  barcode: z.string().trim().max(64).optional().nullable(),
  category: z.string().trim().max(80).optional().nullable(),
  unit: z.string().trim().min(1).max(10).default('UN'),
  costPrice: money,
  salePrice: z.number().finite().positive().max(1_000_000),
  minStock: z.number().finite().nonnegative().max(1_000_000).default(0),
  initialStock: z.number().finite().nonnegative().max(1_000_000).default(0),
  expiryDate: dateOnly.optional().nullable(),
});

// `active` só entra no schema de atualização (nunca no de criação — todo
// produto nasce ativo). Sem isso, uma vez desativado (DELETE /products/:id),
// não existia NENHUMA forma de reativar um produto — nem pela API, nem pela
// tela — a não ser mexendo direto no banco de dados.
const productUpdateSchema = productCreateSchema.partial().omit({ initialStock: true }).extend({ active: z.boolean().optional() });

// `expiryDate` é a validade mais próxima entre os lotes com saldo; o semáforo
// (urgency) sai dela e do saldo × mínimo.
function serializeProduct(p, role, now = today()) {
  const base = {
    id: p.id,
    name: p.name,
    barcode: p.barcode,
    category: p.category,
    unit: p.unit,
    salePrice: Number(p.salePrice),
    currentStock: Number(p.currentStock),
    minStock: Number(p.minStock),
    expiryDate: p.expiryDate,
    active: p.active,
    ...productUrgency(p, now),
  };
  if (role === 'ADMIN') {
    base.costPrice = Number(p.costPrice);
    base.margin = Number(p.salePrice) - Number(p.costPrice);
  }
  return base;
}

router.get('/', async (req, res) => {
  const { query, category, lowStock, includeInactive } = req.query;
  const urgency = parseEnumParam(req.query.urgency, URGENCY_LEVELS, 'urgency');
  const where = {};
  if (!(includeInactive === 'true' && req.user.role === 'ADMIN')) where.active = true;
  // Leitor do balcão (câmera ou pistola USB) manda só os dígitos: casa o código exato.
  if (query) where.OR = [{ name: { contains: String(query), mode: 'insensitive' } }, { barcode: String(query) }];
  if (category) where.category = String(category);

  const paginated = req.query.page !== undefined || req.query.pageSize !== undefined;
  const page = clampIntParam(req.query.page, { min: 1, max: 1_000_000, fallback: 1 });
  const pageSize = clampIntParam(req.query.pageSize, { min: 1, max: 100, fallback: 20 });

  // Prisma não compara coluna com coluna (estoque <= mínimo) no where, e o
  // semáforo é calculado na leitura. Com esses filtros, filtra em memória e
  // pagina o resultado; sem eles, skip/take no banco.
  if (!paginated || lowStock === 'true' || urgency) {
    const products = await prisma.product.findMany({ where, orderBy: { name: 'asc' } });
    const now = today();
    let result = products.map((p) => serializeProduct(p, req.user.role, now));
    if (lowStock === 'true') result = result.filter((p) => p.currentStock <= p.minStock);
    if (urgency) result = result.filter((p) => p.urgency === urgency);
    if (!paginated) return res.json(result);
    const totalCount = result.length;
    const pageItems = result.slice((page - 1) * pageSize, page * pageSize);
    return res.json({ totalCount, page, pageSize, products: pageItems });
  }

  const [products, totalCount] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  res.json({ totalCount, page, pageSize, products: products.map((p) => serializeProduct(p, req.user.role)) });
});

router.get('/:id', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id } });
  // A listagem (GET /) já esconde produtos desativados de quem não é admin;
  // sem esta mesma checagem aqui, bastava saber (ou adivinhar) o ID de um
  // produto descontinuado para um funcionário ver seus detalhes completos
  // por fora da tela normal — a rota de detalhe precisa impor a mesma regra.
  if (!p || (!p.active && req.user.role !== 'ADMIN')) throw httpError(404, 'Produto não encontrado.');
  res.json(serializeProduct(p, req.user.role));
});

router.post('/', authorize('ADMIN'), validate(productCreateSchema), async (req, res) => {
  const data = req.body;

  if (data.barcode) {
    const dup = await prisma.product.findUnique({ where: { barcode: data.barcode } });
    if (dup) throw httpError(409, 'Já existe um produto com este código de barras.');
  }

  let product;
  try {
    product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: data.name,
          barcode: data.barcode || null,
          category: data.category || null,
          unit: data.unit,
          costPrice: data.costPrice.toFixed(2),
          salePrice: data.salePrice.toFixed(2),
          minStock: data.minStock.toFixed(3),
        },
      });
      if (data.initialStock <= 0) return created; // sem lote não há validade a guardar

      // Estoque inicial = primeiro lote, com a validade informada.
      await moveStock(tx, {
        productId: created.id,
        quantity: data.initialStock,
        type: 'ENTRY',
        reason: 'Estoque inicial no cadastro',
        userId: req.user.sub,
        expiryDate: toStoredDate(data.expiryDate),
      });
      return tx.product.findUnique({ where: { id: created.id } });
    });
  } catch (err) {
    // P2002 = violação de restrição única (ex: duas requisições simultâneas com o mesmo código de barras)
    if (err.code === 'P2002') throw httpError(409, 'Já existe um produto com este código de barras.');
    throw err;
  }

  res.status(201).json(serializeProduct(product, req.user.role));
});

router.put('/:id', authorize('ADMIN'), validate(productUpdateSchema), async (req, res) => {
  const data = req.body;
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw httpError(404, 'Produto não encontrado.');

  if (data.barcode && data.barcode !== existing.barcode) {
    const dup = await prisma.product.findUnique({ where: { barcode: data.barcode } });
    if (dup) throw httpError(409, 'Já existe um produto com este código de barras.');
  }

  let product;
  try {
    product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: req.params.id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.barcode !== undefined && { barcode: data.barcode || null }),
          ...(data.category !== undefined && { category: data.category || null }),
          ...(data.unit !== undefined && { unit: data.unit }),
          ...(data.costPrice !== undefined && { costPrice: data.costPrice.toFixed(2) }),
          ...(data.salePrice !== undefined && { salePrice: data.salePrice.toFixed(2) }),
          ...(data.minStock !== undefined && { minStock: data.minStock.toFixed(3) }),
          ...(data.active !== undefined && { active: data.active }),
        },
      });
      if (data.expiryDate === undefined) return updated;

      // A validade do produto é a dos lotes: só muda pelo produto quando não há
      // ambiguidade (ver expiryChange); com o produto travado, nenhum lote muda no meio.
      const { expiryDate: current } = await lockProduct(tx, updated.id);
      const requested = toStoredDate(data.expiryDate);
      const change = expiryChange(current, await openBatchExpiries(tx, updated.id), requested);
      if (change === 'no-stock') throw httpError(400, 'Produto sem estoque: a validade é registrada a cada entrada de mercadoria.');
      if (change === 'mixed') throw httpError(409, 'Os lotes deste produto vencem em datas diferentes: corrija a validade lote a lote.');
      if (change === 'unchanged') return updated;
      await setOpenBatchesExpiry(tx, updated.id, requested);
      return tx.product.findUnique({ where: { id: updated.id } });
    });
  } catch (err) {
    if (err.code === 'P2002') throw httpError(409, 'Já existe um produto com este código de barras.');
    throw err;
  }

  res.json(serializeProduct(product, req.user.role));
});

// Exclusão lógica: preserva o histórico de vendas/movimentações já vinculado ao produto.
router.delete('/:id', authorize('ADMIN'), async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw httpError(404, 'Produto não encontrado.');
  await prisma.product.update({ where: { id: req.params.id }, data: { active: false } });
  res.json({ ok: true });
});

module.exports = router;
