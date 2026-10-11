const express = require('express');
const prisma = require('../db');
const { authenticate } = require('../middleware/auth');
const { parseEnumParam } = require('../lib/queryHelpers');
const { getStockForecast } = require('../services/forecast');

const router = express.Router();
// Fica na Central de Alertas, que todo perfil vê; por isso não leva preço de custo.
router.use(authenticate);

const NO_CATEGORY = 'Sem categoria';
const qty = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

// Texto pronto para colar no WhatsApp: *negrito* nos títulos, uma linha por produto.
function asWhatsAppText(items, generatedAt) {
  const title = `*Lista de compras — ${generatedAt.toLocaleDateString('pt-BR')}*`;
  if (items.length === 0) return `${title}\n\nNada para comprar: nenhum produto está no estoque mínimo.\n`;

  const lines = [title];
  let category;
  for (const item of items) {
    const label = item.category ?? NO_CATEGORY;
    if (label !== category) {
      category = label;
      lines.push('', `*${category}*`);
    }
    lines.push(`- ${item.name}: tem ${qty(item.currentStock)} ${item.unit}, mínimo ${qty(item.minStock)}`);
  }
  lines.push('', `${items.length} produto(s) para repor.`);
  return `${lines.join('\n')}\n`;
}

const byCategoryThenName = (a, b) =>
  (a.category === null) - (b.category === null) ||
  (a.category ?? '').localeCompare(b.category ?? '', 'pt-BR') ||
  a.name.localeCompare(b.name, 'pt-BR');

// Produtos ativos com saldo menor ou igual ao estoque mínimo — o mesmo critério
// de `lowStock` da previsão, que já traz a média de vendas e os dias até esgotar.
router.get('/', async (req, res) => {
  const format = parseEnumParam(req.query.format, ['json', 'text'], 'format') ?? 'json';
  const toBuy = (await getStockForecast()).filter((p) => p.lowStock);
  const categories = await prisma.product.findMany({
    where: { id: { in: toBuy.map((p) => p.productId) } },
    select: { id: true, category: true },
  });
  const categoryById = new Map(categories.map((p) => [p.id, p.category]));

  const items = toBuy
    .map((p) => ({
      productId: p.productId,
      name: p.name,
      category: categoryById.get(p.productId) ?? null,
      unit: p.unit,
      currentStock: p.currentStock,
      minStock: p.minStock,
      avgDailySales: p.avgDailySales,
      daysUntilStockout: p.daysUntilStockout,
    }))
    .sort(byCategoryThenName);

  const generatedAt = new Date();
  if (format === 'text') return res.type('text/plain').send(asWhatsAppText(items, generatedAt));
  res.json({ generatedAt, totalItems: items.length, items });
});

module.exports = router;
