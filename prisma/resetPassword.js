// Script de recuperação de emergência: redefine a senha de um usuário já
// existente diretamente no banco. Não cria contas novas — só quem já tem
// acesso ao servidor/banco de dados (mesmo nível de confiança de quem roda
// migrations ou o seed) pode executar isto, então não é uma porta de entrada
// nova, é uma rede de segurança para o dono não ficar trancado para sempre
// fora do próprio sistema caso esqueça a senha e não haja outro administrador.
//
// Uso:
//   RESET_EMAIL=admin@example.com RESET_PASSWORD="NovaSenhaForte123!" node prisma/resetPassword.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.RESET_EMAIL || '').toLowerCase().trim();
  const password = process.env.RESET_PASSWORD;

  if (!email) throw new Error('Defina RESET_EMAIL com o e-mail do usuário.');
  if (!password || password.length < 8) {
    throw new Error('Defina RESET_PASSWORD (mínimo 8 caracteres) com a nova senha.');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`Nenhum usuário encontrado com o e-mail ${email}.`);

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: user.id },
    // Derruba sessões já abertas, como toda outra troca de senha do sistema.
    data: { passwordHash, active: true, sessionVersion: { increment: 1 } },
  });

  console.log(`Senha redefinida para ${email} (${user.role}). A conta também foi reativada, caso estivesse desativada.`);
  console.log('Troque essa senha assim que fizer login.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
