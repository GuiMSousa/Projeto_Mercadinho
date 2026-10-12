require('dotenv').config();

function required(name, devFallback) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Variável de ambiente obrigatória ausente em produção: ${name}`);
  }
  return devFallback;
}

// Lê um inteiro de env var com um mínimo garantido — protege contra
// misconfiguração (ex: FORECAST_WINDOW_DAYS=0 causaria divisão por zero na
// previsão de estoque) sem exigir validação manual em cada ponto de uso.
function intEnv(name, fallback, min = 1) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 3000),
  // Nome impresso no recibo da venda.
  storeName: process.env.STORE_NAME || 'Mercadinho',

  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-troque-em-producao'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  clientOrigin: process.env.CLIENT_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
  // Quantos "saltos" de proxy reverso confiar no cabeçalho X-Forwarded-For
  // para identificar o IP real do cliente (usado pelo rate limiter). O
  // padrão é 0 (não confiar em nada) — um app exposto diretamente, sem
  // proxy na frente, que confiasse nesse cabeçalho permitiria a qualquer
  // atacante forjar um IP diferente a cada requisição e furar o limite de
  // tentativas de login. Só mude para 1 (ou mais) se você souber, de fato,
  // quantos proxies confiáveis existem entre o cliente e este servidor
  // (ex: 1 para Render/Railway com um único proxy de borda).
  trustProxy: intEnv('TRUST_PROXY', 0, 0),
  // Limite geral de requisições por IP a cada minuto. 300 (5/s) comporta
  // confortavelmente vários caixas simultâneos atrás do mesmo IP (comum numa
  // loja com rede compartilhada) — a busca de produto na venda, por exemplo,
  // já dispara uma requisição a cada 250ms enquanto o usuário digita.
  // Testado ao vivo: com o valor antigo (120/min), 150 vendas simultâneas
  // legítimas contra estoque suficiente geravam vários "429 Too Many
  // Requests" mesmo sem nenhum ataque acontecendo. Ajuste via
  // API_RATE_LIMIT_MAX se o volume real da loja pedir um valor diferente.
  apiRateLimitMax: intEnv('API_RATE_LIMIT_MAX', 300),
  // Em produção, o cookie de sessão é sempre "Secure" (só trafega por HTTPS),
  // independentemente do que estiver (ou não) configurado em COOKIE_SECURE —
  // evita que um .env esquecido exponha o token de sessão em texto plano.
  cookieSecure: isProduction ? true : process.env.COOKIE_SECURE === 'true',

  forecastWindowDays: intEnv('FORECAST_WINDOW_DAYS', 30),
  expiryAlertDays: intEnv('EXPIRY_ALERT_DAYS', 7),
  lowStockAlertHour: Math.min(Math.max(intEnv('LOW_STOCK_ALERT_HOUR', 8, 0), 0), 23),

  // URL base do app, usada para montar o link de reset de senha. Lida do .env
  // em vez de req.headers.host para evitar host header injection — um atacante
  // que controle o cabeçalho Host faria o e-mail/link apontar para domínio dele.
  appBaseUrl: (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  // Validade do token de reset (em minutos). 30 min equilibra tempo razoável
  // para o usuário digitar a nova senha com janela pequena de abuso.
  passwordResetExpiresMin: intEnv('PASSWORD_RESET_EXPIRES_MIN', 30, 1),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: intEnv('SMTP_PORT', 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Contro Vend <no-reply@controvend.local>',
  },
  alertEmailTo: process.env.ALERT_EMAIL_TO || '',
};

if (config.nodeEnv === 'production' && config.jwtSecret.startsWith('dev-only')) {
  throw new Error('JWT_SECRET inseguro em produção. Defina um segredo forte no .env.');
}

module.exports = config;
