// Leitura de planilhas para importação. Converte arquivos .xlsx, .csv/.txt e
// texto colado (copiar/colar direto do Excel ou Google Planilhas) numa "grade"
// única — { headers, rows } — para que todo o resto do fluxo de importação
// trabalhe com um formato só, independente de onde os dados vieram.
const ExcelJS = require('exceljs');
const httpError = require('../lib/httpError');

const MAX_ROWS = 1000;
const MAX_COLUMNS = 40;

// Excel conta os dias a partir de 1899-12-30 (o "bug" do ano 1900 que a
// Lotus 1-2-3 tinha e a Microsoft manteve por compatibilidade).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

// Datas viram string ISO já na leitura: a grade precisa sobreviver ao
// round-trip JSON entre a pré-visualização e a confirmação sem mudar de tipo,
// senão o que o usuário conferiu na tela não seria exatamente o que é gravado.
function normalizeCell(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    if (value.error) return null;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('result' in value) return normalizeCell(value.result);
    if ('text' in value) return normalizeCell(value.text);
  }
  return String(value);
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function trimGrid(grid) {
  const rows = grid.filter((row) => row.some((cell) => !isBlank(cell)));
  if (rows.length === 0) throw httpError(400, 'A planilha está vazia.');

  const [headerRow, ...dataRows] = rows;
  // A largura da tabela é a da linha de cabeçalho: colunas soltas depois dela
  // costumam ser anotações do lado da planilha, não dados.
  let width = headerRow.length;
  while (width > 0 && isBlank(headerRow[width - 1])) width -= 1;
  if (width === 0) throw httpError(400, 'Não foi possível identificar a linha de cabeçalho da planilha.');

  const headers = headerRow.slice(0, width).map((cell, index) => {
    const label = isBlank(cell) ? '' : String(cell).trim();
    return label || `Coluna ${index + 1}`;
  });

  if (dataRows.length > MAX_ROWS) {
    throw httpError(400, `A planilha tem ${dataRows.length} linhas de dados. O limite por importação é ${MAX_ROWS} — divida o arquivo em partes menores.`);
  }

  const normalizedRows = dataRows.map((row) => {
    const cells = [];
    for (let i = 0; i < width; i += 1) cells.push(isBlank(row[i]) ? null : row[i]);
    return cells;
  });

  return { headers, rows: normalizedRows };
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw httpError(400, 'Não foi possível ler este arquivo Excel. Se ele for um .xls antigo, abra no Excel e salve como .xlsx ou .csv.');
  }

  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0) || workbook.worksheets[0];
  if (!sheet) throw httpError(400, 'A planilha não tem nenhuma aba com dados.');

  const columnCount = Math.min(sheet.actualColumnCount || sheet.columnCount || 0, MAX_COLUMNS);
  if (columnCount === 0) throw httpError(400, 'A planilha está vazia.');

  const grid = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let col = 1; col <= columnCount; col += 1) cells.push(normalizeCell(row.getCell(col).value));
    grid.push(cells);
  });

  return trimGrid(grid);
}

// Arquivos .csv salvos pelo Excel em português costumam vir em Windows-1252,
// não em UTF-8. Decodificar tudo como UTF-8 transformaria "Café" em "Caf<?>";
// o caractere de substituição é justamente o sinal de que o palpite errou.
function decodeBuffer(buffer) {
  const asUtf8 = buffer.toString('utf8');
  if (asUtf8.includes('\uFFFD')) return buffer.toString('latin1');
  return asUtf8;
}

function detectDelimiter(line) {
  const candidates = [';', '\t', ',', '|'];
  let best = ';';
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// Máquina de estados no padrão RFC 4180: campos entre aspas podem conter o
// próprio delimitador, quebras de linha e aspas escapadas ("").
function parseDelimited(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = clean.split('\n', 1)[0] || '';
  const delimiter = detectDelimiter(firstLine);

  const grid = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      grid.push(row.slice(0, MAX_COLUMNS));
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  grid.push(row.slice(0, MAX_COLUMNS));

  return trimGrid(grid);
}

const XLSX_EXTENSIONS = ['.xlsx', '.xlsm'];
const TEXT_EXTENSIONS = ['.csv', '.txt', '.tsv'];

function extensionOf(filename = '') {
  const match = /\.[a-z0-9]+$/i.exec(filename.trim());
  return match ? match[0].toLowerCase() : '';
}

async function parseFile(buffer, filename) {
  const ext = extensionOf(filename);
  if (XLSX_EXTENSIONS.includes(ext)) return parseXlsx(buffer);
  if (TEXT_EXTENSIONS.includes(ext)) return parseDelimited(decodeBuffer(buffer));
  if (ext === '.xls' || ext === '.ods') {
    throw httpError(400, `Formato ${ext} não é lido diretamente. Abra o arquivo no Excel (ou Google Planilhas) e salve como .xlsx ou .csv.`);
  }

  // Sem extensão reconhecida, o conteúdo decide: todo .xlsx é um ZIP e começa
  // com a assinatura "PK".
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return parseXlsx(buffer);
  return parseDelimited(decodeBuffer(buffer));
}

module.exports = {
  MAX_ROWS,
  MAX_COLUMNS,
  EXCEL_EPOCH_MS,
  MS_PER_DAY,
  parseFile,
  parseDelimited,
};
