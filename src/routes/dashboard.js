const express = require('express');
const prisma = require('../db');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { getStockForecast, splitForecastAlerts, getSlowMovingProducts } = require('../services/forecast');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const forecast = await getStockForecast();
  const { lowStock, soonOut } = splitForecastAlerts(forecast);

  const expiringUntil = new Date(Date.now() + config.expiryAlertDays * 24 * 60 * 60 * 1000);
  const expiring = await prisma.product.findMany({
    where: { active: true, expiryDate: { not: null, lte: expiringUntil } },
    orderBy: { expiryDate: 'asc' },
    select: { id: true, name: true, expiryDate: true, currentStock: true },
  });

  const payload = {
    lowStock,
    soonOut,
    expiring: expiring.map((p) => ({
      id: p.id,
      name: p.name,
      expiryDate: p.expiryDate,
      currentStock: Number(p.currentStock),
    })),
  };

  // Números financeiros e produtos parados ficam visíveis só para o administrador.
  if (req.user.role === 'ADMIN') {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const [todaySales, monthSales, slowMoving] = await Promise.all([
      prisma.sale.aggregate({ where: { canceled: false, createdAt: { gte: startOfDay } }, _sum: { totalAmount: true }, _count: true }),
      prisma.sale.aggregate({ where: { canceled: false, createdAt: { gte: startOfMonth } }, _sum: { totalAmount: true }, _count: true }),
      getSlowMovingProducts(60),
    ]);

    payload.today = { total: Number(todaySales._sum.totalAmount || 0), count: todaySales._count };
    payload.month = { total: Number(monthSales._sum.totalAmount || 0), count: monthSales._count };
    payload.slowMoving = slowMoving;
  }

  res.json(payload);
});

module.exports = router;
