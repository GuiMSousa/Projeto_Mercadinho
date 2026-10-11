const httpError = require('./httpError');

// Query strings chegam sempre como texto solto e nunca passam pelo Zod (que só
// valida req.body). Sem esta validação, um "from=lixo" ou "type=lixo" vira um
// `new Date('lixo')` (Invalid Date) ou um valor de enum inexistente passado
// direto pro Prisma — que rejeita com um erro interno não tratado (500) em vez
// de uma mensagem clara. Estas funções fecham essa lacuna de forma centralizada.

function parseDateParam(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `Parâmetro "${fieldName}" inválido: use uma data válida (ex: 2026-08-26).`);
  }
  return date;
}

function parseEnumParam(value, allowed, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const str = String(value);
  if (!allowed.includes(str)) {
    throw httpError(400, `Parâmetro "${fieldName}" inválido: valores aceitos são ${allowed.join(', ')}.`);
  }
  return str;
}

// Converte um valor de query em inteiro dentro de [min, max]; valores
// ausentes, não numéricos ou fora da faixa caem no padrão em vez de crashar
// ou de acionar comportamentos inesperados do Prisma (ex: "take" negativo,
// que o Prisma interpreta como paginação reversa).
function clampIntParam(value, { min, max, fallback }) {
  const parsed = parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

module.exports = { parseDateParam, parseEnumParam, clampIntParam };
