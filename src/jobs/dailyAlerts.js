const cron = require('node-cron');
const nodemailer = require('nodemailer');
const config = require('../config');
const prisma = require('../db');
const { getStockForecast, splitForecastAlerts } = require('../services/forecast');

function buildTransport() {
  if (!config.smtp.host) return null;
  const implicitTls = config.smtp.port === 465;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: implicitTls,
    // Sem isso, uma porta que não seja 465 (ex: 587, o mais comum) faz
    // STARTTLS "de forma oportunista": se o servidor não oferecer/aceitar o
    // upgrade de TLS, o nodemailer segue enviando em texto plano em vez de
    // recusar — vazando a senha do SMTP e o conteúdo do e-mail (níveis de
    // estoque) na rede sem criptografia. requireTLS força a recusa nesse caso.
    requireTLS: !implicitTls,
    // Falha rápido em vez de ficar pendurado indefinidamente se o host SMTP
    // estiver inacessível ou "engolindo" pacotes silenciosamente.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    // Alguns relés internos (ex: um Postfix na mesma rede, ou provedores que
    // autenticam por IP como o Amazon SES) não exigem usuário/senha — só
    // inclui `auth` quando ambos estiverem configurados.
    ...(config.smtp.user && config.smtp.pass ? { auth: { user: config.smtp.user, pass: config.smtp.pass } } : {}),
  });
}

async function buildAlertText() {
  const forecast = await getStockForecast();
  const { lowStock, soonOut } = splitForecastAlerts(forecast);

  const now = new Date();
  const expiringUntil = new Date(Date.now() + config.expiryAlertDays * 24 * 60 * 60 * 1000);
  const expiring = await prisma.product.findMany({
    where: { active: true, expiryDate: { not: null, gte: now, lte: expiringUntil } },
    orderBy: { expiryDate: 'asc' },
  });

  if (lowStock.length === 0 && soonOut.length === 0 && expiring.length === 0) return null;

  const section = (label, items, fmt) => (items.length ? `\n${label}:\n${items.map(fmt).join('\n')}\n` : '');

  return [
    'Alerta diário de estoque - Contro Vend',
    section('Estoque abaixo do mínimo', lowStock, (p) => `- ${p.name}: ${p.currentStock} ${p.unit} (mínimo ${p.minStock})`),
    section('Previsão de esgotar em até 7 dias', soonOut, (p) => `- ${p.name}: previsão de acabar em ${p.daysUntilStockout} dia(s)`),
    section('Produtos próximos do vencimento', expiring, (p) => `- ${p.name}: vence em ${p.expiryDate.toLocaleDateString('pt-BR')}`),
  ]
    .filter(Boolean)
    .join('\n');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ALERT_EMAIL_TO aceita uma lista separada por vírgula (o nodemailer entende
// isso nativamente). Validar aqui pega um e-mail digitado errado no .env
// imediatamente, em vez de o comerciante só notar dias depois que nunca mais
// recebeu o alerta.
function validAlertRecipients() {
  if (!config.alertEmailTo) return false;
  const addresses = config.alertEmailTo.split(',').map((a) => a.trim());
  const allValid = addresses.every((a) => EMAIL_REGEX.test(a));
  if (!allValid) {
    console.error(`[alertas] ALERT_EMAIL_TO contém um endereço inválido: "${config.alertEmailTo}". Corrija o .env.`);
  }
  return allValid;
}

async function sendDailyAlertEmail() {
  const transport = buildTransport();
  if (!transport || !validAlertRecipients()) {
    if (!transport) console.log('[alertas] SMTP não configurado — envio de e-mail desativado.');
    return;
  }

  const text = await buildAlertText();
  if (!text) {
    console.log('[alertas] Nenhum alerta hoje.');
    return;
  }

  await transport.sendMail({
    from: config.smtp.from,
    to: config.alertEmailTo,
    subject: 'Alerta diário de estoque - Contro Vend',
    text,
  });
  console.log('[alertas] E-mail de alerta enviado.');
}

// Testa a conexão/autenticação SMTP já na subida do servidor, sem bloquear o
// boot nem derrubar o processo se falhar. Sem isso, um erro de configuração
// (host errado, senha errada, porta bloqueada pelo provedor de hospedagem)
// só seria descoberto no dia seguinte, quando o cron tentasse enviar o
// primeiro alerta — e falhar silenciosamente em produção é fácil de passar
// despercebido, já que ninguém fica olhando o log o dia inteiro.
async function verifySmtpConnectionOnStartup() {
  const transport = buildTransport();
  if (!transport) return;
  try {
    await transport.verify();
    console.log('[alertas] Conexão SMTP verificada com sucesso.');
  } catch (err) {
    console.error('[alertas] Não foi possível conectar ao servidor SMTP configurado:', err.message);
  }
}

function scheduleDailyAlerts() {
  const hour = Math.min(Math.max(config.lowStockAlertHour, 0), 23);
  cron.schedule(`0 ${hour} * * *`, () => {
    sendDailyAlertEmail().catch((err) => console.error('[alertas] erro ao enviar e-mail:', err.message));
  });
  verifySmtpConnectionOnStartup().catch(() => {}); // erros já são tratados/logados dentro da função
}

module.exports = { scheduleDailyAlerts, sendDailyAlertEmail, buildAlertText, verifySmtpConnectionOnStartup };
