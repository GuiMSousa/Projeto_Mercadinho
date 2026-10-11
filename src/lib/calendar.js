const { z } = require('zod');

// Datas de calendário (validades) trafegam como "AAAA-MM-DD" e são gravadas como
// meia-noite UTC dessa data.

// O regex garante o formato; o refine garante que a data existe de fato no
// calendário. Não basta checar se `Date.parse` retorna um valor válido: o
// parser de datas do JavaScript "conserta" silenciosamente dias fora do mês
// (ex: "2026-02-30" vira 2 de março) em vez de rejeitar — então validamos
// comparando os componentes de volta após a conversão (round-trip).
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).')
  .refine((v) => {
    const [year, month, day] = v.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'Essa data não existe no calendário.');

const toStoredDate = (value) => (value ? new Date(`${value}T00:00:00Z`) : null);

// "Hoje" no calendário do servidor (variável TZ, ex: America/Sao_Paulo), no mesmo
// formato das validades gravadas — senão, depois das 21h no horário de Brasília,
// um servidor em UTC já contaria um dia a menos para vencer.
function today(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

const daysUntil = (date, from = today()) => Math.round((date.getTime() - from.getTime()) / 86_400_000);

module.exports = { dateOnly, toStoredDate, today, daysUntil };
