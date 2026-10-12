// Simula um histórico realista de vendas espalhado nos últimos N dias
// (não só "hoje") — útil para demonstração e para popular relatórios e a
// previsão de esgotamento com uma taxa de venda diária de verdade. Vendas
// feitas pela API sempre têm createdAt = agora; este script grava direto no
// banco para poder "voltar no tempo".
//
// Uso:
//   npm run simulate:sales
//   SIMULATE_DAYS=30 npm run simulate:sales   (para outra janela de dias)
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { moveStock } = require('../src/services/stockOps');

const prisma = new PrismaClient();

const DAYS = parseInt(process.env.SIMULATE_DAYS || '14', 10);

// Produto (pelo código de barras dos dados de exemplo) e a média de
// unidades vendidas por dia — varia aleatoriamente em torno dessa média,
// e alguns dias não têm venda nenhuma (25% de chance), como no mundo real.
const SALES_PLAN = [
  { barcode: '7891000100011', avgQty: 1.2 }, // Arroz Branco 5kg
  { barcode: '7891000100202', avgQty: 2.6 }, // Água Mineral 1,5L
  { barcode: '7891000100059', avgQty: 1.8 }, // Café Torrado e Moído 500g
  { barcode: '7891000100196', avgQty: 1.5 }, // Refrigerante Cola 2L
  { barcode: '7891000100110', avgQty: 1.7 }, // Leite Integral UHT 1L
  { barcode: '7891000100226', avgQty: 2.3 }, // Detergente Líquido 500ml
  { barcode: '7891000100219', avgQty: 0.6 }, // Sabão em Pó 1kg
  { barcode: '7891000100028', avgQty: 1.4 }, // Feijão Carioca 1kg
  { barcode: '7891000100165', avgQty: 0.9 }, // Ovos Brancos (dúzia)
  { barcode: '7891000100172', avgQty: 1.3 }, // Pão de Forma 500g
  { barcode: '7891000100042', avgQty: 0.7 }, // Açúcar Refinado 1kg
  { barcode: '7891000100066', avgQty: 0.8 }, // Óleo de Soja 900ml
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function ensureDemoCashier() {
  const existing = await prisma.user.findFirst({ where: { role: 'CASHIER', active: true } });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash('SenhaCaixa123!', 12);
  return prisma.user.create({
    data: { name: 'Maria Caixa', email: 'maria.caixa@example.com', passwordHash, role: 'CASHIER' },
  });
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', active: true }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('Nenhum administrador encontrado — rode "npm run seed" primeiro.');
  const cashier = await ensureDemoCashier();
  const sellers = [admin, cashier];

  let salesCreated = 0;
  let unitsSold = 0;

  for (const plan of SALES_PLAN) {
    const product = await prisma.product.findUnique({ where: { barcode: plan.barcode } });
    if (!product || !product.active) continue;

    let stock = Number(product.currentStock);

    for (let dayOffset = DAYS; dayOffset >= 1; dayOffset--) {
      if (stock <= 0) break;
      if (Math.random() < 0.25) continue; // nem todo dia vende esse produto

      const raw = Math.round(plan.avgQty + (Math.random() - 0.5) * plan.avgQty);
      const qty = Math.min(stock, Math.max(1, raw));
      if (qty <= 0) continue;

      const seller = sellers[randInt(0, sellers.length - 1)];
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - dayOffset);
      createdAt.setHours(randInt(8, 19), randInt(0, 59), randInt(0, 59), 0);

      const unitPrice = Number(product.salePrice);
      const subtotal = unitPrice * qty;
      stock -= qty;

      await prisma.$transaction(async (tx) => {
        const sale = await tx.sale.create({
          data: { sellerId: seller.id, totalAmount: subtotal.toFixed(2), createdAt },
        });
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: product.id,
            quantity: qty.toFixed(3),
            unitPrice: unitPrice.toFixed(2),
            subtotal: subtotal.toFixed(2),
            unitCost: Number(product.costPrice).toFixed(2),
          },
        });
        // Baixa pelos lotes (PVPS de venda), igual a uma venda feita pela tela; só a
        // data da movimentação é recuada para o dia simulado.
        const { movement } = await moveStock(tx, {
          productId: product.id,
          quantity: -qty,
          type: 'SALE',
          reason: 'Venda (simulação de histórico)',
          userId: seller.id,
          saleId: sale.id,
          order: 'SALE',
        });
        await tx.stockMovement.update({ where: { id: movement.id }, data: { createdAt } });
      });

      salesCreated++;
      unitsSold += qty;
    }
  }

  console.log(`${salesCreated} vendas simuladas em ${DAYS} dias, totalizando ${unitsSold} unidades, entre ${sellers.map((s) => s.name).join(' e ')}.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
