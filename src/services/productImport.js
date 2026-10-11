// Traduz a grade genérica lida de uma planilha (ver spreadsheet.js) em
// produtos válidos do sistema: adivinha qual coluna é qual campo, converte os
// valores escritos "como gente escreve" (R$ 12,50 / 31/12/2026) para os tipos
// do banco, e aponta linha a linha o que está errado — tudo antes de gravar
// qualquer coisa.
const { EXCEL_EPOCH_MS, MS_PER_DAY } = require('./spreadsheet');

const FIELDS = [
  { key: 'name', label: 'Nome do produto', required: true },
  { key: 'barcode', label: 'Código de barras' },
  { key: 'category', label: 'Categoria' },
  { key: 'unit', label: 'Unidade' },
  { key: 'costPrice', label: 'Preço de custo' },
  { key: 'salePrice', label: 'Preço de venda' },
  { key: 'stock', label: 'Estoque' },
  { key: 'minStock', label: 'Estoque mínimo' },
  { key: 'expiryDate', label: 'Validade' },
];

// A ordem importa no palpite automático: campos mais específicos são testados
// primeiro para que "estoque mínimo" não seja capturado por "estoque" nem
// "preço de custo" por "preço".
const SYNONYMS = {
  name: ['nome', 'produto', 'nomeproduto', 'nomedoproduto', 'descricao', 'descricaodoproduto', 'mercadoria', 'item', 'name', 'description'],
  barcode: ['codigodebarras', 'codbarras', 'codigobarras', 'codbarra', 'ean', 'ean13', 'gtin', 'barcode', 'codigo', 'cod', 'sku', 'referencia', 'ref'],
  costPrice: ['precodecusto', 'precocusto', 'valordecusto', 'valorcusto', 'custounitario', 'custo', 'precodecompra', 'precocompra', 'costprice', 'cost'],
  salePrice: ['precodevenda', 'precovenda', 'valordevenda', 'valorvenda', 'precounitario', 'precovarejo', 'preco', 'valor', 'venda', 'saleprice', 'price'],
  minStock: ['estoqueminimo', 'estminimo', 'quantidademinima', 'qtdminima', 'qtdeminima', 'minimo', 'minstock', 'stockmin', 'min'],
  stock: ['estoqueatual', 'quantidadeemestoque', 'estoque', 'quantidade', 'qtdestoque', 'qtd', 'qtde', 'saldo', 'stock', 'quantity', 'qty'],
  expiryDate: ['datadevalidade', 'datavalidade', 'validade', 'vencimento', 'vencto', 'dtvalidade', 'expiry', 'expirydate'],
  category: ['categoria', 'grupo', 'departamento', 'setor', 'secao', 'linha', 'category'],
  unit: ['unidademedida', 'unidadedemedida', 'unidade', 'medida', 'unid', 'und', 'un', 'unit'],
};

const GUESS_ORDER = ['name', 'barcode', 'costPrice', 'salePrice', 'minStock', 'stock', 'expiryDate', 'category', 'unit'];

function normalizeHeader(header) {
  return String(header ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Duas passadas: primeiro casamento exato do cabeçalho com um sinônimo,
// depois "contém". A passada exata evita que um cabeçalho "Preço" roube a
// coluna de uma planilha que também tem "Preço de custo".
function guessMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};
  const usedColumns = new Set();

  for (const matchExact of [true, false]) {
    for (const field of GUESS_ORDER) {
      if (mapping[field] !== undefined) continue;
      const synonyms = [...SYNONYMS[field]].sort((a, b) => b.length - a.length);

      for (let col = 0; col < normalized.length; col += 1) {
        if (usedColumns.has(col) || !normalized[col]) continue;
        const hit = synonyms.some((s) => (matchExact ? normalized[col] === s : normalized[col].includes(s)));
        if (hit) {
          mapping[field] = col;
          usedColumns.add(col);
          break;
        }
      }
    }
  }

  return mapping;
}

// Aceita tanto o formato brasileiro ("1.234,56") quanto o internacional
// ("1,234.56"): o separador decimal é sempre o ÚLTIMO ponto ou vírgula que
// aparece; os demais são separadores de milhar. Quando só há pontos, um único
// ponto é lido como decimal ("12.50") e vários como milhar ("1.234.567").
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  let text = value.trim().replace(/^r\$/i, '').replace(/\s/g, '');
  if (!text) return null;

  const negative = text.startsWith('-') || (text.startsWith('(') && text.endsWith(')'));
  text = text.replace(/[()\-+]/g, '');
  if (!/^[\d.,]+$/.test(text)) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let decimalAt = -1;

  if (lastComma >= 0 && lastDot >= 0) decimalAt = Math.max(lastComma, lastDot);
  else if (lastComma >= 0) decimalAt = lastComma;
  else if (lastDot >= 0 && text.indexOf('.') === lastDot) decimalAt = lastDot;

  const intPart = (decimalAt >= 0 ? text.slice(0, decimalAt) : text).replace(/[.,]/g, '');
  const decPart = decimalAt >= 0 ? text.slice(decimalAt + 1).replace(/[.,]/g, '') : '';
  const parsed = Number(`${intPart || '0'}.${decPart || '0'}`);

  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toIsoDay(year, month, day) {
  if (!isValidCalendarDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Devolve sempre "AAAA-MM-DD" (o mesmo formato que a API de produtos já
// valida) a partir de data do Excel (número de série), data ISO, ou os
// formatos escritos à mão mais comuns aqui: 31/12/2026, 31-12-26, 31.12.2026.
function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(EXCEL_EPOCH_MS + Math.round(value) * MS_PER_DAY);
    return toIsoDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return toIsoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const br = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(text);
  if (br) {
    const year = Number(br[3]);
    return toIsoDay(year < 100 ? 2000 + year : year, Number(br[2]), Number(br[1]));
  }

  return null;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

// Códigos de barras costumam chegar como número (o Excel converte sozinho).
// String(1.234567890123e12) viraria notação científica, então formatamos o
// inteiro explicitamente — um EAN-13 cabe com folga na precisão de um double.
function cellBarcode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? value.toFixed(0) : String(value);
  return cellText(value);
}

const MAX_MONEY = 1_000_000;
const MAX_QUANTITY = 1_000_000;

function normalizeRow(cells, mapping, options) {
  const errors = [];
  const warnings = [];
  const values = {};

  const cellAt = (field) => (mapping[field] === undefined ? undefined : cells[mapping[field]]);

  const readNumber = (field, label, { max, allowZero = true }) => {
    const raw = cellAt(field);
    if (raw === undefined || cellText(raw) === '') return undefined;
    const parsed = parseNumber(raw);
    if (parsed === null) {
      errors.push(`${label}: "${cellText(raw)}" não é um número válido.`);
      return undefined;
    }
    if (parsed < 0) {
      errors.push(`${label} não pode ser negativo.`);
      return undefined;
    }
    if (!allowZero && parsed === 0) {
      errors.push(`${label} precisa ser maior que zero.`);
      return undefined;
    }
    if (parsed > max) {
      errors.push(`${label} acima do limite permitido (${max.toLocaleString('pt-BR')}).`);
      return undefined;
    }
    // "1.000" é ambíguo: decimal em inglês (=1) ou milhar em português
    // (=1000). Lemos como decimal, mas avisamos — num campo de estoque, errar
    // isso em silêncio significa gravar 1 no lugar de 1.000.
    if (typeof raw === 'string' && /^\d+\.\d{3}$/.test(raw.trim())) {
      warnings.push(`${label}: "${raw.trim()}" foi lido como ${parsed.toLocaleString('pt-BR')}. Se na sua planilha o ponto separa milhar, corrija antes de confirmar.`);
    }
    return parsed;
  };

  const name = cellText(cellAt('name'));
  if (!name) errors.push('Nome do produto está vazio.');
  else if (name.length > 150) errors.push('Nome do produto tem mais de 150 caracteres.');
  else values.name = name;

  const barcode = cellBarcode(cellAt('barcode'));
  if (barcode) {
    if (barcode.length > 64) errors.push('Código de barras tem mais de 64 caracteres.');
    else values.barcode = barcode;
  }

  const category = cellText(cellAt('category'));
  if (category) {
    if (category.length > 80) errors.push('Categoria tem mais de 80 caracteres.');
    else values.category = category;
  }

  const unit = cellText(cellAt('unit')).toUpperCase();
  if (unit) {
    if (unit.length > 10) errors.push('Unidade tem mais de 10 caracteres.');
    else values.unit = unit;
  }

  const costPrice = readNumber('costPrice', 'Preço de custo', { max: MAX_MONEY });
  if (costPrice !== undefined) values.costPrice = costPrice;

  const salePrice = readNumber('salePrice', 'Preço de venda', { max: MAX_MONEY, allowZero: false });
  if (salePrice !== undefined) values.salePrice = salePrice;

  const minStock = readNumber('minStock', 'Estoque mínimo', { max: MAX_QUANTITY });
  if (minStock !== undefined) values.minStock = minStock;

  const stock = readNumber('stock', 'Estoque', { max: MAX_QUANTITY });
  if (stock !== undefined) values.stock = stock;

  const rawExpiry = cellAt('expiryDate');
  if (rawExpiry !== undefined && cellText(rawExpiry) !== '') {
    const parsed = parseDate(rawExpiry);
    if (!parsed) errors.push(`Validade: "${cellText(rawExpiry)}" não é uma data válida (use 31/12/2026).`);
    else values.expiryDate = parsed;
  }

  if (values.costPrice !== undefined && values.salePrice !== undefined && values.costPrice > values.salePrice) {
    warnings.push('Preço de custo maior que o de venda (prejuízo por unidade).');
  }
  if (options.matchBy === 'barcode' && !values.barcode) {
    warnings.push('Sem código de barras — o produto será localizado pelo nome.');
  }

  return { values, errors, warnings };
}

// Chave usada para casar a linha com um produto já cadastrado. Sem código de
// barras (ou quando o usuário escolhe casar por nome), caímos no nome
// normalizado: sem acento, sem espaço duplicado e em minúsculas, para que
// "Café Torrado" e "cafe  torrado" sejam o mesmo produto.
function nameKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function matchKeyFor(values, matchBy) {
  if (matchBy === 'barcode' && values.barcode) return { kind: 'barcode', key: values.barcode };
  if (values.name) return { kind: 'name', key: nameKey(values.name) };
  return null;
}

module.exports = {
  FIELDS,
  MAX_MONEY,
  MAX_QUANTITY,
  guessMapping,
  normalizeHeader,
  parseNumber,
  parseDate,
  normalizeRow,
  nameKey,
  matchKeyFor,
};
