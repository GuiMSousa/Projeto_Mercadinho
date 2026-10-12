const express = require('express');
const { z } = require('zod');
const { Prisma, PaymentMethod, CashMovementType } = require('@prisma/client');
const prisma = require('../db');
const validate = require('../middleware/validate');
const httpError = require('../lib/httpError');
const { authenticate, authorize } = require('../middleware/auth');
const { parseDateParam, clampIntParam } = require('../lib/queryHelpers');

const router = express.Router();
// Abrir, consultar e fechar o caixa é rotina de quem está no balcão; o histórico
// (com os valores) é só do administrador.
router.use(authenticate);

const money = z.number().finite().nonnegative().max(1_000_000);
const openSchema = z.object({ openingAmount: money });
const closeSchema = z.object({ countedAmount: money, notes: z.string().trim().max(500).optional().nullable() });
const movementSchema = z.object({
  type: z.enum(Object.values(CashMovementType)),
  amount: money.positive(),
  reason: z.string().trim().min(1, 'Informe o motivo.').max(255),
});

const withUsers = { openedBy: { select: { name: true } }, closedBy: { select: { name: true } } };
const zero = () => new Prisma.Decimal(0);

// Vendas não canceladas de cada caixa, por forma de pagamento, e o total de
// sangrias (WITHDRAWAL) e suprimentos (DEPOSIT).
async function sessionTotals(sessionIds) {
  const [sales, movements] = await Promise.all([
    prisma.sale.groupBy({
      by: ['cashSessionId', 'paymentMethod'],
      where: { cashSessionId: { in: sessionIds }, canceled: false },
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
    prisma.cashMovement.groupBy({ by: ['cashSessionId', 'type'], where: { cashSessionId: { in: sessionIds } }, _sum: { amount: true } }),
  ]);
  const totals = new Map(sessionIds.map((id) => [id, {
    count: 0,
    byMethod: Object.fromEntries(Object.values(PaymentMethod).map((m) => [m, zero()])),
    WITHDRAWAL: zero(),
    DEPOSIT: zero(),
  }]));
  for (const g of sales) {
    const t = totals.get(g.cashSessionId);
    t.count += g._count._all;
    t.byMethod[g.paymentMethod] = g._sum.totalAmount ?? zero();
  }
  for (const g of movements) totals.get(g.cashSessionId)[g.type] = g._sum.amount ?? zero();
  return totals;
}

// Dinheiro que deveria estar na gaveta: fundo + vendas em dinheiro + suprimentos - sangrias.
const expectedCash = (opening, cashSales, deposits, withdrawals) => opening.plus(cashSales).plus(deposits).minus(withdrawals);

const presentMovement = (m) => ({
  id: m.id,
  type: m.type,
  amount: Number(m.amount),
  reason: m.reason,
  createdBy: m.user.name,
  createdAt: m.createdAt,
});

// O funcionário só vê o que ele mesmo informou (fechamento cego): esperado,
// diferença e totais de venda ficam para o ADMIN — a mesma regra do painel.
function present(s, role, totals, movements) {
  const base = {
    id: s.id,
    status: s.isOpen ? 'OPEN' : 'CLOSED',
    openedBy: s.openedBy.name,
    openedAt: s.openedAt,
    openingAmount: Number(s.openingAmount),
    closedBy: s.closedBy?.name ?? null,
    closedAt: s.closedAt,
    countedAmount: s.countedAmount === null ? null : Number(s.countedAmount),
    notes: s.notes,
  };
  if (role !== 'ADMIN') return base;

  // Aberto: esperado até agora. Fechado: o valor gravado no fechamento.
  const expected = s.isOpen ? expectedCash(s.openingAmount, totals.byMethod.CASH, totals.DEPOSIT, totals.WITHDRAWAL) : s.expectedAmount;
  const methods = Object.entries(totals.byMethod);
  return {
    ...base,
    expectedAmount: Number(expected),
    depositsTotal: Number(totals.DEPOSIT),
    withdrawalsTotal: Number(totals.WITHDRAWAL),
    ...(movements && { movements: movements.map(presentMovement) }),
    difference: s.isOpen ? null : Number(s.countedAmount.minus(s.expectedAmount)),
    salesCount: totals.count,
    salesTotal: Number(methods.reduce((sum, [, v]) => sum.plus(v), zero())),
    totalsByPaymentMethod: Object.fromEntries(methods.map(([m, v]) => [m, Number(v)])),
  };
}

async function presentOne(session, role) {
  if (role !== 'ADMIN') return present(session, role);
  const [totals, movements] = await Promise.all([
    sessionTotals([session.id]),
    prisma.cashMovement.findMany({ where: { cashSessionId: session.id }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
  ]);
  return present(session, role, totals.get(session.id), movements);
}

router.post('/', validate(openSchema), async (req, res) => {
  let session;
  try {
    session = await prisma.cashSession.create({
      data: { openingAmount: req.body.openingAmount.toFixed(2), openedById: req.user.sub },
      include: withUsers,
    });
  } catch (err) {
    // Índice único de isOpen: já há um caixa aberto (inclusive em aberturas simultâneas).
    if (err.code === 'P2002') throw httpError(409, 'Já existe um caixa aberto. Feche-o antes de abrir outro.');
    throw err;
  }
  res.status(201).json(await presentOne(session, req.user.role));
});

router.get('/current', async (req, res) => {
  const session = await prisma.cashSession.findUnique({ where: { isOpen: true }, include: withUsers });
  if (!session) throw httpError(404, 'Nenhum caixa aberto.');
  res.json(await presentOne(session, req.user.role));
});

router.post('/current/movements', validate(movementSchema), async (req, res) => {
  const { type, amount, reason } = req.body;
  const movement = await prisma.$transaction(async (tx) => {
    // O mesmo lock compartilhado da venda: o fechamento espera a movimentação
    // terminar, e a que chega depois do fechamento já não encontra o caixa aberto.
    const [open] = await tx.$queryRaw`SELECT "id" FROM "CashSession" WHERE "isOpen" = true FOR SHARE`;
    if (!open) throw httpError(404, 'Nenhum caixa aberto.');
    return tx.cashMovement.create({
      data: { cashSessionId: open.id, type, amount: amount.toFixed(2), reason, userId: req.user.sub },
      include: { user: { select: { name: true } } },
    });
  });
  res.status(201).json(presentMovement(movement));
});

router.post('/current/close', validate(closeSchema), async (req, res) => {
  const { countedAmount, notes } = req.body;
  const closed = await prisma.$transaction(async (tx) => {
    const open = await tx.cashSession.findUnique({ where: { isOpen: true } });
    if (!open) throw httpError(404, 'Nenhum caixa aberto.');

    // UPDATE condicional = lock exclusivo na linha do caixa: espera terminar toda
    // venda que segura o lock compartilhado (e já está ligada a este caixa); as que
    // chegarem depois não o encontram mais aberto. Só então soma o esperado.
    const claimed = await tx.cashSession.updateMany({
      where: { id: open.id, isOpen: true },
      data: { isOpen: null, closedAt: new Date(), closedById: req.user.sub, countedAmount: countedAmount.toFixed(2), notes: notes || null },
    });
    if (claimed.count === 0) throw httpError(409, 'Este caixa acabou de ser fechado.');

    const [{ _sum }, movements] = await Promise.all([
      tx.sale.aggregate({ where: { cashSessionId: open.id, canceled: false, paymentMethod: 'CASH' }, _sum: { totalAmount: true } }),
      tx.cashMovement.groupBy({ by: ['type'], where: { cashSessionId: open.id }, _sum: { amount: true } }),
    ]);
    const moved = (type) => movements.find((m) => m.type === type)?._sum.amount ?? zero();
    const expected = expectedCash(open.openingAmount, _sum.totalAmount ?? zero(), moved('DEPOSIT'), moved('WITHDRAWAL'));
    return tx.cashSession.update({
      where: { id: open.id },
      data: { expectedAmount: expected.toFixed(2) },
      include: withUsers,
    });
  }, { timeout: 20_000, maxWait: 5_000 });
  // Mais que os 15s de uma venda: o fechamento pode ter de esperar vendas em
  // andamento terminarem (com o padrão de 5s do Prisma, ele falhava sob carga).
  res.json(await presentOne(closed, req.user.role));
});

router.get('/', authorize('ADMIN'), async (req, res) => {
  const page = clampIntParam(req.query.page, { min: 1, max: 1_000_000, fallback: 1 });
  const pageSize = clampIntParam(req.query.pageSize, { min: 1, max: 100, fallback: 20 });
  const from = parseDateParam(req.query.from, 'from');
  const to = parseDateParam(req.query.to, 'to');

  const where = {};
  if (from || to) where.openedAt = {};
  if (from) where.openedAt.gte = from;
  if (to) where.openedAt.lte = to;

  const [sessions, totalCount] = await Promise.all([
    prisma.cashSession.findMany({ where, include: withUsers, orderBy: { openedAt: 'desc' }, take: pageSize, skip: (page - 1) * pageSize }),
    prisma.cashSession.count({ where }),
  ]);
  const totals = await sessionTotals(sessions.map((s) => s.id));
  res.json({ totalCount, page, pageSize, sessions: sessions.map((s) => present(s, 'ADMIN', totals.get(s.id))) });
});

router.get('/:id', authorize('ADMIN'), async (req, res) => {
  const session = await prisma.cashSession.findUnique({ where: { id: req.params.id }, include: withUsers });
  if (!session) throw httpError(404, 'Caixa não encontrado.');
  res.json(await presentOne(session, 'ADMIN'));
});

module.exports = router;
