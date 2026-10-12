const express = require('express');
const { Prisma, PaymentMethod } = require('@prisma/client');
const prisma = require('../db');
const httpError = require('../lib/httpError');
const { authenticate, authorize } = require('../middleware/auth');
const { getStockForecast, getSlowMovingProducts } = require('../services/forecast');
const { parseDateParam, parseDayParam, clampIntParam } = require('../lib/queryHelpers');

const router = express.Router();
router.use(authenticate, authorize('ADMIN'));

router.get('/forecast', async (req, res) => {
  res.json(await getStockForecast());
});

// "AAAA-MM-DD" de uma data no fuso da loja (TZ).
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const ZERO = new Prisma.Decimal(0);
const cents = (d) => Number(new Prisma.Decimal(d).toFixed(2));
// Percentual com duas casas; null quando a base é zero (período sem vendas).
const percent = (part, whole) => (whole.isZero() ? null : Number(new Prisma.Decimal(part).div(whole).times(100).toFixed(2)));

// Painel financeiro: faturamento, CMV (custo gravado em cada item no momento da venda),
// lucro, margem, ticket médio, formas de pagamento e os produtos que mais deram lucro.
router.get('/financial', async (req, res) => {
  const now = new Date();
  const start = parseDayParam(req.query.startDate, 'startDate') ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = parseDayParam(req.query.endDate, 'endDate') ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (start > lastDay) throw httpError(400, 'O período é inválido: "startDate" é depois de "endDate".');
  const end = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1); // o último dia inteiro
  const where = { canceled: false, createdAt: { gte: start, lt: end } };

  const [byMethod, products] = await Promise.all([
    prisma.sale.groupBy({ by: ['paymentMethod'], where, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT p."id", p."name", p."unit",
             SUM(i."quantity") AS "quantity",
             SUM(i."subtotal") AS "revenue",
             SUM(i."quantity" * i."unitCost") AS "cost",
             BOOL_OR(i."unitCost" = 0) AS "costMissing"
      FROM "SaleItem" i
      JOIN "Sale" s ON s."id" = i."saleId"
      JOIN "Product" p ON p."id" = i."productId"
      WHERE s."canceled" = false AND s."createdAt" >= ${start} AND s."createdAt" < ${end}
      GROUP BY p."id", p."name", p."unit"`,
  ]);

  const revenue = byMethod.reduce((sum, g) => sum.plus(g._sum.totalAmount ?? 0), ZERO);
  const salesCount = byMethod.reduce((n, g) => n + g._count._all, 0);
  const cost = products.reduce((sum, p) => sum.plus(p.cost), ZERO);
  const profit = revenue.minus(cost); // o PDV não tem desconto: o total gravado já é o valor cobrado
  const ranked = products
    .map((p) => {
      const productProfit = new Prisma.Decimal(p.revenue).minus(p.cost);
      return {
        productId: p.id,
        name: p.name,
        unit: p.unit,
        quantity: Number(p.quantity),
        revenue: cents(p.revenue),
        cost: cents(p.cost),
        profit: cents(productProfit),
        margin: percent(productProfit, new Prisma.Decimal(p.revenue)),
        costMissing: p.costMissing,
      };
    })
    .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue);

  res.json({
    period: { startDate: localDay(start), endDate: localDay(lastDay) },
    grossRevenue: cents(revenue),
    costOfGoodsSold: cents(cost),
    profit: cents(profit),
    profitMargin: percent(profit, revenue),
    salesCount,
    averageTicket: salesCount ? cents(revenue.div(salesCount)) : null,
    byPaymentMethod: Object.values(PaymentMethod).map((method) => {
      const g = byMethod.find((x) => x.paymentMethod === method);
      const total = g?._sum.totalAmount ?? ZERO;
      return { method, salesCount: g?._count._all ?? 0, total: cents(total), percentage: percent(total, revenue) };
    }),
    topProducts: ranked.slice(0, 10),
    productsWithoutCost: ranked.filter((p) => p.costMissing).length,
  });
});

router.get('/sales-summary', async (req, res) => {
  const from = parseDateParam(req.query.from, 'from');
  const to = parseDateParam(req.query.to, 'to');
  const where = { canceled: false };
  if (from || to) where.createdAt = {};
  if (from) where.createdAt.gte = from;
  if (to) where.createdAt.lte = to;

  const sales = await prisma.sale.findMany({ where, select: { totalAmount: true, createdAt: true } });

  const byDay = {};
  let total = 0;
  for (const s of sales) {
    const day = localDay(s.createdAt); // no fuso da loja: em UTC, a venda das 22h caía no dia seguinte
    byDay[day] = (byDay[day] || 0) + Number(s.totalAmount);
    total += Number(s.totalAmount);
  }

  res.json({ total, count: sales.length, byDay });
});

router.get('/top-products', async (req, res) => {
  const from = parseDateParam(req.query.from, 'from');
  const to = parseDateParam(req.query.to, 'to');
  const limit = clampIntParam(req.query.limit, { min: 1, max: 50, fallback: 10 });

  const saleWhere = { canceled: false };
  if (from || to) saleWhere.createdAt = {};
  if (from) saleWhere.createdAt.gte = from;
  if (to) saleWhere.createdAt.lte = to;

  const items = await prisma.saleItem.groupBy({
    by: ['productId'],
    where: { sale: saleWhere },
    _sum: { quantity: true, subtotal: true },
    orderBy: { _sum: { subtotal: 'desc' } },
    take: limit,
  });

  const products = await prisma.product.findMany({ where: { id: { in: items.map((i) => i.productId) } } });
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  res.json(
    items.map((i) => ({
      productId: i.productId,
      name: nameById.get(i.productId) || 'Produto removido',
      quantitySold: Number(i._sum.quantity),
      revenue: Number(i._sum.subtotal),
    })),
  );
});

router.get('/slow-moving', async (req, res) => {
  const days = clampIntParam(req.query.days, { min: 1, max: 365, fallback: 60 });
  res.json(await getSlowMovingProducts(days));
});

module.exports = router;
