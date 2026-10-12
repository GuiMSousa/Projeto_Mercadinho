// npm run test:e2e [etapa1 etapa3 ...] — testes de ponta a ponta no navegador real.
// Usa o banco TEST_DATABASE_URL, que é APAGADO no começo (mesma trava do npm test),
// cria os usuários de teste e sobe o app numa porta própria (E2E_PORT, padrão 3999).
require('dotenv').config();
if (!process.env.TEST_DATABASE_URL) {
  console.error('Defina TEST_DATABASE_URL no .env: um banco só de testes (ele é apagado).');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { prisma, resetDb } = require('../helpers/db');

const ADMIN = { email: 'admin.test@example.com', password: 'TesteSenha123!' };
const CASHIER = { email: 'caixa.balcao@example.com', password: 'SenhaBalcao123!' };
const port = process.env.E2E_PORT || '3999';
const base = `http://localhost:${port}`;
const etapas = process.argv.slice(2).length ? process.argv.slice(2) : ['etapa1', 'etapa2', 'etapa3', 'etapa4', 'etapa5', 'etapa6', 'etapa7'];

const exitCode = (child) => new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));

async function startServer() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 60; i += 1) {
    if (server.exitCode !== null) throw new Error('o servidor encerrou ao subir (veja o erro acima)');
    if (await fetch(base).then(() => true, () => false)) return server;
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`o servidor não respondeu em ${base}`);
}

(async () => {
  await resetDb();
  const user = async (name, who, role) => ({ name, email: who.email, role, passwordHash: await bcrypt.hash(who.password, 10) });
  await prisma.user.createMany({ data: [await user('Admin Teste', ADMIN, 'ADMIN'), await user('Caixa Balcão', CASHIER, 'CASHIER')] });
  await prisma.$disconnect();

  const failed = [];
  for (const etapa of etapas) {
    console.log(`\n===== ${etapa} =====`);
    // Um servidor por etapa: o limite de login (10 por IP a cada 15 min) fica na memória
    // do processo, e as etapas juntas fazem logins o bastante para chegar nele.
    const server = await startServer();
    try {
      const code = await exitCode(spawn(process.execPath, [path.join(__dirname, `${etapa}.js`), base], { stdio: 'inherit' }));
      if (code !== 0) failed.push(etapa);
    } finally {
      if (server.exitCode === null) {
        const stopped = exitCode(server);
        server.kill();
        await stopped; // libera a porta antes da próxima etapa
      }
    }
  }
  console.log(failed.length ? `\nFalhou: ${failed.join(', ')}` : `\nTodas as etapas passaram (${etapas.join(', ')}).`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
