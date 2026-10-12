const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Trava de segurança: esta suíte APAGA todas as linhas de todas as tabelas
// antes de rodar. Sem esta checagem, um DATABASE_URL apontando por engano
// para o banco de produção (ex: variável de ambiente não trocada ao rodar
// "npm test" localmente) destruiria os dados reais do comércio sem
// nenhum aviso. Exige que o nome do banco contenha "test" — ou que o
// desenvolvedor confirme explicitamente com ALLOW_DB_RESET=true.
function assertSafeToReset() {
  const url = process.env.DATABASE_URL || '';
  const dbName = url.split('/').pop()?.split('?')[0] || '';
  const looksLikeTestDb = /test/i.test(dbName);
  if (!looksLikeTestDb && process.env.ALLOW_DB_RESET !== 'true') {
    throw new Error(
      `Recusando apagar o banco "${dbName}" — o nome não contém "test". ` +
        'Aponte DATABASE_URL para um banco dedicado a testes, ou defina ALLOW_DB_RESET=true se tiver certeza absoluta.',
    );
  }
}

// Apaga tudo em ordem segura de chaves estrangeiras. Só deve ser usado
// contra um banco de dados dedicado a testes — nunca aponte DATABASE_URL
// para um banco com dados reais ao rodar a suíte.
async function resetDb() {
  assertSafeToReset();
  await prisma.stockMovementBatch.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.cashMovement.deleteMany();
  await prisma.cashSession.deleteMany();
  await prisma.stockBatch.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
}

module.exports = { prisma, resetDb };
