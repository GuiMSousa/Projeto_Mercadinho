const { today, daysUntil } = require('../lib/calendar');

// Semáforo do relatório do Mercadinho: vermelho é agir hoje (sem estoque, vencido
// ou vencendo em até 7 dias), amarelo é planejar (no mínimo ou vencendo em 8 a 30 dias).
const RED_DAYS = 7;
const YELLOW_DAYS = 30;
const URGENCY_LEVELS = ['RED', 'YELLOW', 'GREEN'];
const RED_REASONS = ['OUT_OF_STOCK', 'EXPIRED', 'EXPIRES_SOON'];

function expiryReason(daysToExpiry) {
  if (daysToExpiry === null) return null;
  if (daysToExpiry < 0) return 'EXPIRED';
  if (daysToExpiry <= RED_DAYS) return 'EXPIRES_SOON';
  if (daysToExpiry <= YELLOW_DAYS) return 'EXPIRING';
  return null;
}

function levelFor(reasons) {
  if (reasons.some((r) => RED_REASONS.includes(r))) return 'RED';
  return reasons.length ? 'YELLOW' : 'GREEN';
}

// `expiryDate` do produto é a validade mais próxima entre os lotes com saldo.
function productUrgency({ currentStock, minStock, expiryDate }, now = today()) {
  const stock = Number(currentStock);
  const daysToExpiry = expiryDate ? daysUntil(expiryDate, now) : null;
  const reasons = [];
  if (stock <= 0) reasons.push('OUT_OF_STOCK');
  else if (stock <= Number(minStock)) reasons.push('LOW_STOCK');
  const expiry = expiryReason(daysToExpiry);
  if (expiry) reasons.push(expiry);
  reasons.sort((a, b) => RED_REASONS.includes(b) - RED_REASONS.includes(a));
  return { urgency: levelFor(reasons), urgencyReasons: reasons, daysToExpiry };
}

// Lote: só a validade conta.
function batchUrgency(expiryDate, now = today()) {
  const daysToExpiry = expiryDate ? daysUntil(expiryDate, now) : null;
  const expiry = expiryReason(daysToExpiry);
  return { urgency: levelFor(expiry ? [expiry] : []), daysToExpiry };
}

module.exports = { URGENCY_LEVELS, productUrgency, batchUrgency };
