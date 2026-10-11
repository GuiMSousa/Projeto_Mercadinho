require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { today } = require('../src/lib/calendar');
const { moveStock } = require('../src/services/stockOps');

const prisma = new PrismaClient();

// Datas relativas a hoje, para o exemplo já nascer com alguns produtos
// "vencendo em breve" e outros com validade tranquila — assim o painel de
// alertas mostra dados reais assim que o sistema é aberto pela primeira vez.
// No mesmo formato das validades gravadas pela API (meia-noite UTC da data).
function daysFromNow(days) {
  return new Date(today().getTime() + days * 86_400_000);
}

// Catálogo de exemplo para um mercadinho de secos e molhados. Ajuste
// livremente (preços, categorias, código de barras) para refletir o
// estoque real do cliente antes de repassar este arquivo pra produção.
const products = [
  { name: 'Arroz Branco 5kg', barcode: '7891000100011', category: 'Grãos e Cereais', unit: 'UN', costPrice: 18.50, salePrice: 24.90, minStock: 10, initialStock: 32, expiryDays: 240 },
  { name: 'Feijão Carioca 1kg', barcode: '7891000100028', category: 'Grãos e Cereais', unit: 'UN', costPrice: 6.20, salePrice: 8.90, minStock: 15, initialStock: 40, expiryDays: 180 },
  { name: 'Feijão Preto 1kg', barcode: '7891000100035', category: 'Grãos e Cereais', unit: 'UN', costPrice: 6.50, salePrice: 9.20, minStock: 12, initialStock: 14, expiryDays: 180 },
  { name: 'Açúcar Refinado 1kg', barcode: '7891000100042', category: 'Mercearia', unit: 'UN', costPrice: 3.80, salePrice: 5.50, minStock: 20, initialStock: 8, expiryDays: 300 },
  { name: 'Café Torrado e Moído 500g', barcode: '7891000100059', category: 'Mercearia', unit: 'UN', costPrice: 9.90, salePrice: 14.90, minStock: 10, initialStock: 25, expiryDays: 5 },
  { name: 'Óleo de Soja 900ml', barcode: '7891000100066', category: 'Óleos e Temperos', unit: 'UN', costPrice: 5.50, salePrice: 7.90, minStock: 12, initialStock: 6, expiryDays: 150 },
  { name: 'Sal Refinado 1kg', barcode: '7891000100073', category: 'Mercearia', unit: 'UN', costPrice: 1.20, salePrice: 2.50, minStock: 10, initialStock: 18, expiryDays: 400 },
  { name: 'Macarrão Espaguete 500g', barcode: '7891000100080', category: 'Massas', unit: 'UN', costPrice: 3.10, salePrice: 4.90, minStock: 15, initialStock: 22, expiryDays: 200 },
  { name: 'Molho de Tomate 340g', barcode: '7891000100097', category: 'Enlatados', unit: 'UN', costPrice: 2.30, salePrice: 3.80, minStock: 10, initialStock: 3, expiryDays: 90 },
  { name: 'Farinha de Trigo 1kg', barcode: '7891000100103', category: 'Mercearia', unit: 'UN', costPrice: 3.40, salePrice: 5.20, minStock: 10, initialStock: 15, expiryDays: 250 },
  { name: 'Leite Integral UHT 1L', barcode: '7891000100110', category: 'Laticínios', unit: 'UN', costPrice: 4.20, salePrice: 5.90, minStock: 20, initialStock: 24, expiryDays: 3 },
  { name: 'Leite em Pó 400g', barcode: '7891000100127', category: 'Laticínios', unit: 'UN', costPrice: 8.90, salePrice: 12.50, minStock: 8, initialStock: 10, expiryDays: 120 },
  { name: 'Manteiga com Sal 200g', barcode: '7891000100134', category: 'Laticínios', unit: 'UN', costPrice: 6.50, salePrice: 9.90, minStock: 6, initialStock: 9, expiryDays: 10 },
  { name: 'Queijo Mussarela Fatiado 150g', barcode: '7891000100141', category: 'Laticínios', unit: 'UN', costPrice: 5.80, salePrice: 8.50, minStock: 8, initialStock: 5, expiryDays: 6 },
  { name: 'Presunto Fatiado 200g', barcode: '7891000100158', category: 'Frios', unit: 'UN', costPrice: 6.90, salePrice: 9.90, minStock: 6, initialStock: 8, expiryDays: 8 },
  { name: 'Ovos Brancos (dúzia)', barcode: '7891000100165', category: 'Ovos', unit: 'UN', costPrice: 7.50, salePrice: 10.90, minStock: 6, initialStock: 4, expiryDays: 15 },
  { name: 'Pão de Forma 500g', barcode: '7891000100172', category: 'Padaria', unit: 'UN', costPrice: 4.50, salePrice: 6.90, minStock: 8, initialStock: 7, expiryDays: 4 },
  { name: 'Biscoito Recheado 130g', barcode: '7891000100189', category: 'Padaria e Doces', unit: 'UN', costPrice: 2.10, salePrice: 3.50, minStock: 20, initialStock: 30, expiryDays: 60 },
  { name: 'Refrigerante Cola 2L', barcode: '7891000100196', category: 'Bebidas', unit: 'UN', costPrice: 5.80, salePrice: 8.90, minStock: 15, initialStock: 20, expiryDays: 100 },
  { name: 'Água Mineral 1,5L', barcode: '7891000100202', category: 'Bebidas', unit: 'UN', costPrice: 1.80, salePrice: 3.00, minStock: 24, initialStock: 36, expiryDays: null },
  { name: 'Sabão em Pó 1kg', barcode: '7891000100219', category: 'Limpeza', unit: 'UN', costPrice: 7.90, salePrice: 11.90, minStock: 10, initialStock: 12, expiryDays: 720 },
  { name: 'Detergente Líquido 500ml', barcode: '7891000100226', category: 'Limpeza', unit: 'UN', costPrice: 1.90, salePrice: 2.99, minStock: 15, initialStock: 40, expiryDays: 400 },
  { name: 'Papel Higiênico (pacote 4 rolos)', barcode: '7891000100233', category: 'Higiene', unit: 'UN', costPrice: 6.20, salePrice: 9.50, minStock: 10, initialStock: 18, expiryDays: null },
  { name: 'Sabonete em Barra 90g', barcode: '7891000100240', category: 'Higiene', unit: 'UN', costPrice: 1.10, salePrice: 1.99, minStock: 20, initialStock: 25, expiryDays: null },
];

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', active: true }, orderBy: { createdAt: 'asc' } });
  if (!admin) {
    throw new Error('Nenhum usuário administrador encontrado. Rode "npm run seed" primeiro para criar o administrador.');
  }

  let created = 0;
  let updated = 0;

  for (const p of products) {
    const expiryDate = p.expiryDays === null ? null : daysFromNow(p.expiryDays);

    const existing = await prisma.product.findUnique({ where: { barcode: p.barcode } });

    if (existing) {
      await prisma.product.update({
        where: { barcode: p.barcode },
        data: {
          name: p.name,
          category: p.category,
          unit: p.unit,
          costPrice: p.costPrice.toFixed(2),
          salePrice: p.salePrice.toFixed(2),
          minStock: p.minStock.toFixed(3),
          // Validade não entra aqui: ela vem dos lotes do produto.
          active: true,
        },
      });
      updated += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          name: p.name,
          barcode: p.barcode,
          category: p.category,
          unit: p.unit,
          costPrice: p.costPrice.toFixed(2),
          salePrice: p.salePrice.toFixed(2),
          minStock: p.minStock.toFixed(3),
        },
      });
      if (p.initialStock > 0) {
        await moveStock(tx, {
          productId: product.id,
          quantity: p.initialStock,
          type: 'ENTRY',
          reason: 'Estoque inicial (carga de exemplo)',
          userId: admin.id,
          expiryDate,
        });
      }
    });
    created += 1;
  }

  console.log(`Produtos de exemplo: ${created} criado(s), ${updated} atualizado(s) (já existiam pelo código de barras).`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
