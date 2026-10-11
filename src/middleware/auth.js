const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');
const prisma = require('../db');

const COOKIE_NAME = 'cv_token';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 horas
const JWT_ALGORITHM = 'HS256';

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, sv: user.sessionVersion }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: JWT_ALGORITHM,
  });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

async function authenticate(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : undefined;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] });
  } catch {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  // O token só prova quem o usuário ERA no momento do login. Sem revalidar
  // no banco a cada requisição, desativar uma conta ou mudar seu papel não
  // teria efeito nenhum até o token expirar (até 8h) — um funcionário
  // demitido continuaria conseguindo vender, e um admin rebaixado manteria
  // acesso de admin. O custo é uma consulta indexada por chave primária,
  // desprezível para o volume de um sistema desse porte.
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, active: true, sessionVersion: true },
  });
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
  // sv (sessionVersion) no JWT é incrementado a cada troca de senha. Se
  // divergir, é um cookie roubado (ou de uma sessão pré-reset) e precisa ser
  // invalidado — é assim que o reset derruba sessões existentes.
  if (payload.sv !== user.sessionVersion) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  req.user = { sub: user.id, role: user.role };
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para executar esta ação.' });
    }
    next();
  };
}

// Defesa leve contra CSRF: exige um cabeçalho customizado em requisições que
// alteram estado (POST/PUT/PATCH/DELETE). Navegadores só enviam cabeçalhos
// customizados em requisições same-origin feitas via fetch/XHR — formulários
// HTML "simples" forjados em outro site não conseguem definir este cabeçalho,
// então essa checagem barra a submissão forjada mesmo que o cookie seja enviado.
function requireFetchHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Requisição bloqueada.' });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  authenticate,
  authorize,
  requireFetchHeader,
};
