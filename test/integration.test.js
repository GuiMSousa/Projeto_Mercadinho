// Testes de integração de regressão: rodam contra um PostgreSQL real (não
// mocks) e sobem a aplicação de verdade na memória, exatamente como ela
// roda em produção. Protegem especificamente contra os bugs mais graves
// encontrados durante a auditoria de segurança — sem eles, seria fácil uma
// mudança futura reintroduzir silenciosamente qualquer um desses problemas.
//
// Requer uma DATABASE_URL de teste configurada (.env) apontando para um
// PostgreSQL dedicado a testes — a suíte APAGA todos os dados desse banco
// antes de rodar. Nunca aponte para um banco com dados reais.
//
// Com TEST_DATABASE_URL no .env, a suíte usa esse banco sem precisar de
// variável inline no terminal (sintaxe que o PowerShell/cmd não tem).
require('dotenv').config();
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// A suíte inteira sai do mesmo IP (~230 requisições em um minuto): com o limite
// geral de produção (300/min) ela começaria a receber 429 conforme crescesse.
process.env.API_RATE_LIMIT_MAX = '100000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');

const app = require('../src/app');
const config = require('../src/config');
const { prisma, resetDb } = require('./helpers/db');
const { makeCookieJar, request } = require('./helpers/http');

let server;
let baseUrl;
let adminJar;

before(async () => {
  await resetDb();

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const passwordHash = await bcrypt.hash('TesteSenha123!', 12);
  await prisma.user.create({
    data: { name: 'Admin Teste', email: 'admin.test@example.com', passwordHash, role: 'ADMIN' },
  });

  adminJar = makeCookieJar();
  const login = await request(baseUrl, adminJar, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin.test@example.com', password: 'TesteSenha123!' },
  });
  assert.equal(login.status, 200, 'login do admin de teste deveria funcionar');
  // Vender exige caixa aberto: os testes de venda usam este; os de caixa fecham e reabrem.
  assert.equal((await openCash(adminJar, 0)).status, 201);
});

after(async () => {
  // `server` pode nunca ter sido criado se before() falhou cedo (ex: a
  // trava de segurança do resetDb recusando um banco que não parece ser de
  // teste) — sem esta checagem, o after() lançaria um segundo erro
  // (TypeError) que mascara a mensagem real do problema.
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('CSRF: rota que altera estado rejeita requisição sem X-Requested-With', async () => {
  const res = await fetch(`${baseUrl}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminJar.header() },
    body: JSON.stringify({ name: 'x', unit: 'UN', costPrice: 1, salePrice: 2 }),
  });
  assert.equal(res.status, 403);
});

test('CSP: upgrade-insecure-requests só com HTTPS (senão o acesso por http://IP abre sem CSS e JS)', async () => {
  const csp = (await fetch(`${baseUrl}/`)).headers.get('content-security-policy');
  assert.equal(csp.includes('upgrade-insecure-requests'), config.cookieSecure);
  assert.match(csp, /script-src 'self'/);
});

test('SQL injection: payload é armazenado como texto literal, nunca executado', async () => {
  const payload = "Teste'; DROP TABLE \"Product\"; --";
  const created = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: payload, unit: 'UN', costPrice: 1, salePrice: 2 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, payload);

  const list = await request(baseUrl, adminJar, '/api/products');
  assert.equal(list.status, 200, 'a tabela Product precisa continuar existindo e consultável');
});

test('validação de calendário rejeita datas impossíveis (30 de fevereiro)', async () => {
  const res = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Data Impossível', unit: 'UN', costPrice: 1, salePrice: 2, expiryDate: '2026-02-30' },
  });
  assert.equal(res.status, 400);
});

test('barreira de overflow numérico rejeita uma venda absurdamente alta', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Caro', unit: 'UN', costPrice: 1, salePrice: 900_000, initialStock: 100_000 },
  });
  assert.equal(product.status, 201);

  const sale = await request(baseUrl, adminJar, '/api/sales', {
    method: 'POST',
    body: { items: [{ productId: product.body.id, quantity: 10_000 }] },
  });
  assert.equal(sale.status, 400);
});

test('venda decrementa o estoque corretamente e rejeita venda além do disponível', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Venda Simples', unit: 'UN', costPrice: 1, salePrice: 10, initialStock: 5 },
  });

  const sale = await request(baseUrl, adminJar, '/api/sales', {
    method: 'POST',
    body: { items: [{ productId: product.body.id, quantity: 3 }] },
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.totalAmount, 30);

  const afterSale = await request(baseUrl, adminJar, `/api/products/${product.body.id}`);
  assert.equal(afterSale.body.currentStock, 2);

  const oversell = await request(baseUrl, adminJar, '/api/sales', {
    method: 'POST',
    body: { items: [{ productId: product.body.id, quantity: 999 }] },
  });
  assert.equal(oversell.status, 409);
});

test('condição de corrida: entradas de estoque simultâneas nunca perdem atualizações', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Race Entradas', unit: 'UN', costPrice: 1, salePrice: 2, initialStock: 0 },
  });

  await Promise.all(
    Array.from({ length: 20 }, () =>
      request(baseUrl, adminJar, '/api/stock/entries', {
        method: 'POST',
        body: { productId: product.body.id, quantity: 1, reason: 'teste de regressão' },
      }),
    ),
  );

  const after1 = await request(baseUrl, adminJar, `/api/products/${product.body.id}`);
  assert.equal(after1.body.currentStock, 20, '20 entradas simultâneas de +1 devem somar exatamente 20');
});

test('condição de corrida: vendas simultâneas nunca vendem além do estoque disponível', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Race Vendas', unit: 'UN', costPrice: 1, salePrice: 2, initialStock: 10 },
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      request(baseUrl, adminJar, '/api/sales', {
        method: 'POST',
        body: { items: [{ productId: product.body.id, quantity: 1 }] },
      }),
    ),
  );

  const successCount = results.filter((r) => r.status === 201).length;
  assert.equal(successCount, 10, 'só 10 das 20 vendas simultâneas podem ter sucesso (estoque inicial de 10)');

  const after1 = await request(baseUrl, adminJar, `/api/products/${product.body.id}`);
  assert.equal(after1.body.currentStock, 0, 'o estoque nunca pode ficar negativo');

  // O extrato precisa do saldo real de cada venda: 10 → 9, 9 → 8 … 1 → 0.
  const movements = await request(baseUrl, adminJar, `/api/stock/movements?productId=${product.body.id}&type=SALE`);
  assert.deepEqual(movements.body.map((m) => m.previousStock).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(movements.body.every((m) => m.newStock === m.previousStock - 1), 'cada movimentação de venda baixa exatamente 1 do saldo anterior');
});

test('previsão de esgotamento e produtos parados ignoram vendas canceladas', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Venda Cancelada', unit: 'UN', costPrice: 1, salePrice: 2, initialStock: 10 },
  });
  const sale = await request(baseUrl, adminJar, '/api/sales', { method: 'POST', body: { items: [{ productId: product.body.id, quantity: 4 }] } });
  const cancel = await request(baseUrl, adminJar, `/api/sales/${sale.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);

  const forecast = await request(baseUrl, adminJar, '/api/reports/forecast');
  const item = forecast.body.find((p) => p.productId === product.body.id);
  assert.equal(item.avgDailySales, 0, 'venda cancelada não é demanda');
  assert.equal(item.daysUntilStockout, null);

  const slowMoving = await request(baseUrl, adminJar, '/api/reports/slow-moving');
  assert.ok(slowMoving.body.some((p) => p.id === product.body.id), 'sem venda válida no período, o produto está parado');
});

test('recuperação de senha: o link de reset só volta na resposta fora de produção', async () => {
  const forgot = () => request(baseUrl, null, '/api/auth/forgot-password', { method: 'POST', body: { email: 'admin.test@example.com' } });

  const dev = await forgot();
  assert.match(dev.body.resetUrl, /\/reset-password\.html\?token=/);

  const original = config.nodeEnv;
  config.nodeEnv = 'production';
  try {
    const prod = await forgot();
    assert.equal(prod.status, 200);
    assert.equal(prod.body.resetUrl, undefined, 'em produção, o link na resposta deixaria qualquer um que saiba o e-mail do dono assumir a conta');
  } finally {
    config.nodeEnv = original;
  }
});

test('revogação de sessão: usuário desativado perde acesso imediatamente, mesmo com token ainda válido', async () => {
  const created = await request(baseUrl, adminJar, '/api/users', {
    method: 'POST',
    body: { name: 'Caixa Regressão', email: 'caixa.regressao@example.com', password: 'SenhaCaixa123!', role: 'CASHIER' },
  });
  assert.equal(created.status, 201);

  const cashierJar = makeCookieJar();
  const login = await request(baseUrl, cashierJar, '/api/auth/login', {
    method: 'POST',
    body: { email: 'caixa.regressao@example.com', password: 'SenhaCaixa123!' },
  });
  assert.equal(login.status, 200);

  const meBefore = await request(baseUrl, cashierJar, '/api/auth/me');
  assert.equal(meBefore.status, 200);

  await request(baseUrl, adminJar, `/api/users/${created.body.id}`, { method: 'PUT', body: { active: false } });

  const meAfter = await request(baseUrl, cashierJar, '/api/auth/me');
  assert.equal(meAfter.status, 401, 'o mesmo token, agora com a conta desativada, precisa parar de funcionar na hora');
});

test('autorização: funcionário (caixa) é bloqueado de rotas administrativas e nunca vê preço de custo', async () => {
  const created = await request(baseUrl, adminJar, '/api/users', {
    method: 'POST',
    body: { name: 'Caixa Autorização', email: 'caixa.auth@example.com', password: 'SenhaCaixa123!', role: 'CASHIER' },
  });
  assert.equal(created.status, 201);

  const cashierJar = makeCookieJar();
  await request(baseUrl, cashierJar, '/api/auth/login', {
    method: 'POST',
    body: { email: 'caixa.auth@example.com', password: 'SenhaCaixa123!' },
  });

  const usersRes = await request(baseUrl, cashierJar, '/api/users');
  assert.equal(usersRes.status, 403);

  const reportsRes = await request(baseUrl, cashierJar, '/api/reports/forecast');
  assert.equal(reportsRes.status, 403);

  const productsRes = await request(baseUrl, cashierJar, '/api/products');
  assert.equal(productsRes.status, 200);
  for (const p of productsRes.body) {
    assert.equal('costPrice' in p, false, `produto "${p.name}" não deveria expor costPrice para o caixa`);
    assert.equal('margin' in p, false);
  }
});

test('produto desativado pode ser reativado pelo administrador', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Reativação', unit: 'UN', costPrice: 1, salePrice: 2 },
  });

  await request(baseUrl, adminJar, `/api/products/${product.body.id}`, { method: 'DELETE' });
  const deactivated = await request(baseUrl, adminJar, `/api/products/${product.body.id}`);
  assert.equal(deactivated.body.active, false);

  await request(baseUrl, adminJar, `/api/products/${product.body.id}`, { method: 'PUT', body: { active: true } });
  const reactivated = await request(baseUrl, adminJar, `/api/products/${product.body.id}`);
  assert.equal(reactivated.body.active, true);
});

test('produto desativado fica invisível para o caixa na rota de detalhe (não só na listagem)', async () => {
  const product = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Oculto', unit: 'UN', costPrice: 1, salePrice: 2 },
  });
  await request(baseUrl, adminJar, `/api/products/${product.body.id}`, { method: 'DELETE' });

  const cashierJar = makeCookieJar();
  await request(baseUrl, cashierJar, '/api/auth/login', {
    method: 'POST',
    body: { email: 'caixa.auth@example.com', password: 'SenhaCaixa123!' },
  });

  const res = await request(baseUrl, cashierJar, `/api/products/${product.body.id}`);
  assert.equal(res.status, 404);

  // reativa para não deixar lixo para os próximos testes/rodadas manuais
  await request(baseUrl, adminJar, `/api/products/${product.body.id}`, { method: 'PUT', body: { active: true } });
});

// ---------- Importação de planilha ----------

const IMPORT_HEADERS = ['Nome', 'Código de Barras', 'Categoria', 'Unidade', 'Preço de Custo', 'Preço de Venda', 'Estoque', 'Estoque Mínimo', 'Validade'];
const IMPORT_MAPPING = { name: 0, barcode: 1, category: 2, unit: 3, costPrice: 4, salePrice: 5, stock: 6, minStock: 7, expiryDate: 8 };

function importBody(rows, options = {}) {
  return {
    headers: IMPORT_HEADERS,
    rows,
    mapping: IMPORT_MAPPING,
    options: { mode: 'upsert', matchBy: 'barcode', stockMode: 'ignore', ...options },
  };
}

test('importação: caixa é bloqueado em todas as rotas de importação', async () => {
  const cashierJar = makeCookieJar();
  await request(baseUrl, cashierJar, '/api/auth/login', {
    method: 'POST',
    body: { email: 'caixa.auth@example.com', password: 'SenhaCaixa123!' },
  });

  const template = await request(baseUrl, cashierJar, '/api/imports/products/template');
  assert.equal(template.status, 403);

  const parse = await request(baseUrl, cashierJar, '/api/imports/products/parse', { method: 'POST', body: { text: 'Nome\nX' } });
  assert.equal(parse.status, 403);

  const commit = await request(baseUrl, cashierJar, '/api/imports/products/commit', { method: 'POST', body: importBody([]) });
  assert.equal(commit.status, 403, 'gravar produtos em massa nunca pode ficar disponível para o caixa');
});

test('importação: números em formato brasileiro e datas dd/mm/aaaa são gravados corretamente', async () => {
  const commit = await request(baseUrl, adminJar, '/api/imports/products/commit', {
    method: 'POST',
    body: importBody([['Produto Importado BR', '7890000000101', 'Mercearia', 'cx', 'R$ 1.234,56', '2.499,90', '12,5', '3', '31/12/2027']]),
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.created, 1);

  const list = await request(baseUrl, adminJar, '/api/products?query=Produto Importado BR');
  const product = list.body[0];
  assert.equal(product.costPrice, 1234.56, '"R$ 1.234,56" precisa virar 1234.56, não 1.23456');
  assert.equal(product.salePrice, 2499.9);
  assert.equal(product.currentStock, 12.5);
  assert.equal(product.unit, 'CX');
  assert.equal(product.expiryDate.slice(0, 10), '2027-12-31');
});

test('importação: acerto de saldo registra movimentação com o estoque anterior e o novo', async () => {
  const created = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Import Saldo', barcode: '7890000000102', unit: 'UN', costPrice: 1, salePrice: 5, initialStock: 10 },
  });
  assert.equal(created.status, 201);

  const commit = await request(baseUrl, adminJar, '/api/imports/products/commit', {
    method: 'POST',
    body: importBody([['Produto Import Saldo', '7890000000102', 'Mercearia', 'UN', '1,00', '5,00', '25', '0', '']], { stockMode: 'set' }),
  });
  assert.equal(commit.body.updated, 1);

  const after = await request(baseUrl, adminJar, `/api/products/${created.body.id}`);
  assert.equal(after.body.currentStock, 25);

  const movements = await request(baseUrl, adminJar, `/api/stock/movements?productId=${created.body.id}`);
  const adjustment = movements.body.find((m) => m.type === 'ADJUSTMENT');
  assert.ok(adjustment, 'o acerto de saldo por importação precisa deixar rastro no extrato de movimentações');
  assert.equal(adjustment.quantity, 15);
  assert.equal(adjustment.previousStock, 10);
  assert.equal(adjustment.newStock, 25, 'saldo anterior e novo precisam bater com o estoque real — é o que torna o extrato auditável');
});

test('importação: código de barras repetido no arquivo não cadastra o produto duas vezes', async () => {
  const rows = [
    ['Produto Import Duplicado', '7890000000103', 'Mercearia', 'UN', '2,00', '4,00', '10', '1', ''],
    ['Produto Import Duplicado', '7890000000103', 'Mercearia', 'UN', '2,00', '4,00', '10', '1', ''],
  ];

  const preview = await request(baseUrl, adminJar, '/api/imports/products/preview', { method: 'POST', body: importBody(rows) });
  assert.equal(preview.body.summary.create, 1);
  assert.equal(preview.body.summary.error, 1, 'a segunda linha com o mesmo código de barras precisa ser barrada na conferência');

  const commit = await request(baseUrl, adminJar, '/api/imports/products/commit', { method: 'POST', body: importBody(rows) });
  assert.equal(commit.body.created, 1);

  const list = await request(baseUrl, adminJar, '/api/products?query=Produto Import Duplicado&includeInactive=true');
  assert.equal(list.body.length, 1, 'a planilha com a linha repetida nunca pode gerar dois cadastros do mesmo produto');
});

test('importação: código de barras que pertence a outro produto é recusado, nunca sobrescrito', async () => {
  await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'Produto Import Dono do Código', barcode: '7890000000104', unit: 'UN', costPrice: 1, salePrice: 2 },
  });

  // Mesmo código de barras, outro nome: casar por nome criaria um produto novo
  // com um código já usado (violação de unicidade) ou roubaria o código do dono.
  const rows = [['Produto Import Invasor', '7890000000104', 'Mercearia', 'UN', '1,00', '3,00', '5', '1', '']];
  const preview = await request(baseUrl, adminJar, '/api/imports/products/preview', {
    method: 'POST',
    body: importBody(rows, { matchBy: 'name' }),
  });
  assert.equal(preview.body.summary.error, 1);

  const commit = await request(baseUrl, adminJar, '/api/imports/products/commit', {
    method: 'POST',
    body: importBody(rows, { matchBy: 'name' }),
  });
  assert.equal(commit.body.created, 0);
  assert.equal(commit.body.updated, 0);

  const owner = await request(baseUrl, adminJar, '/api/products?query=Produto Import Dono do Código');
  assert.equal(owner.body[0].barcode, '7890000000104', 'o dono do código de barras não pode perdê-lo para outra linha da planilha');
});

test('importação: aceita corpo grande, mas as demais rotas continuam limitadas a 100kb', async () => {
  // A grade da planilha volta ao servidor a cada conferência, então só a
  // importação tem limite ampliado. Se um dia o parser JSON global voltar a
  // valer para /api/imports, este teste falha antes de o usuário descobrir
  // sozinho que planilhas médias param de abrir.
  const padding = 'Produto Volume '.padEnd(90, 'x');
  const rows = Array.from({ length: 800 }, (_, i) => [`${padding}${i}`, '', 'Mercearia', 'UN', '1,00', '2,00', '1', '0', '']);
  const body = importBody(rows, { mode: 'updateOnly' });
  assert.ok(JSON.stringify(body).length > 100 * 1024, 'o payload de teste precisa passar de 100kb para o teste fazer sentido');

  const preview = await request(baseUrl, adminJar, '/api/imports/products/preview', { method: 'POST', body });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.summary.skip, 800);

  const oversized = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name: 'x'.repeat(120 * 1024), unit: 'UN', costPrice: 1, salePrice: 2 },
  });
  assert.equal(oversized.status, 413, 'as rotas normais precisam continuar recusando corpos gigantes');
});

test('importação: planilha .xlsx é lida e as colunas são reconhecidas pelo cabeçalho', async () => {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Lista');
  // Cabeçalhos com nomes diferentes dos do modelo: é o reconhecimento por
  // sinônimo que faz a planilha do fornecedor funcionar sem edição manual.
  sheet.addRow(['DESCRICAO', 'EAN', 'VLR VENDA', 'QTDE', 'VENCIMENTO']);
  sheet.addRow(['Produto Import Xlsx', 7890000000105, 9.9, 7, new Date(Date.UTC(2027, 4, 20))]);
  const buffer = await workbook.xlsx.writeBuffer();

  const form = new FormData();
  form.append('file', new Blob([buffer]), 'fornecedor.xlsx');
  const res = await fetch(`${baseUrl}/api/imports/products/parse`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch', Cookie: adminJar.header() },
    body: form,
  });
  assert.equal(res.status, 200);

  const parsed = await res.json();
  assert.deepEqual(parsed.mapping, { name: 0, barcode: 1, salePrice: 2, stock: 3, expiryDate: 4 });

  const commit = await request(baseUrl, adminJar, '/api/imports/products/commit', {
    method: 'POST',
    body: { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, options: { mode: 'upsert', matchBy: 'barcode', stockMode: 'ignore' } },
  });
  assert.equal(commit.body.created, 1);

  const list = await request(baseUrl, adminJar, '/api/products?query=Produto Import Xlsx');
  assert.equal(list.body[0].salePrice, 9.9);
  assert.equal(list.body[0].currentStock, 7);
  assert.equal(list.body[0].expiryDate.slice(0, 10), '2027-05-20', 'a data do Excel (número de série) precisa virar a mesma data no banco');
});

// ---------- Lotes, validade e PVPS ----------

// AAAA-MM-DD daqui a `days` dias no calendário local — o mesmo que o servidor usa.
function dayFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function newProduct(name, body = {}) {
  const res = await request(baseUrl, adminJar, '/api/products', {
    method: 'POST',
    body: { name, unit: 'UN', costPrice: 1, salePrice: 2, ...body },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const entry = (productId, quantity, expiryDate) =>
  request(baseUrl, adminJar, '/api/stock/entries', { method: 'POST', body: { productId, quantity, expiryDate } });

const batchesOf = async (productId) => (await request(baseUrl, adminJar, `/api/stock/batches?productId=${productId}`)).body;

const sell = (jar, productId, quantity, paymentMethod) =>
  request(baseUrl, jar, '/api/sales', { method: 'POST', body: { items: [{ productId, quantity }], ...(paymentMethod && { paymentMethod }) } });

test('busca: query acha o produto pelo código de barras exato, não por trecho', async () => {
  const product = await newProduct('Produto Leitor', { barcode: '7891000100103' });
  const exact = await request(baseUrl, adminJar, '/api/products?query=7891000100103');
  assert.equal(exact.status, 200);
  assert.deepEqual(exact.body.map((p) => p.id), [product.id]);
  const partial = await request(baseUrl, adminJar, '/api/products?query=78910001');
  assert.equal(partial.body.some((p) => p.id === product.id), false);
});

test('lotes: a venda baixa primeiro o lote que vence antes, e a soma dos lotes acompanha o saldo', async () => {
  const far = dayFromToday(60);
  const near = dayFromToday(10);
  const product = await newProduct('Produto PVPS', { initialStock: 5, expiryDate: far });
  const nearEntry = await entry(product.id, 5, near);
  assert.equal(nearEntry.status, 201);
  assert.equal(nearEntry.body.batch.remaining, 5);
  assert.equal(nearEntry.body.batch.expiryDate.slice(0, 10), near);
  await entry(product.id, 4); // sem validade

  assert.equal((await sell(adminJar, product.id, 7)).status, 201);

  const batches = await batchesOf(product.id);
  assert.deepEqual(
    batches.map((b) => [b.expiryDate && b.expiryDate.slice(0, 10), b.remaining]),
    [[far, 3], [null, 4]],
    'as 5 do lote que vence antes saem primeiro, depois 2 do seguinte; o lote sem validade fica por último',
  );
  const after = await request(baseUrl, adminJar, `/api/products/${product.id}`);
  assert.equal(after.body.currentStock, 7);
  assert.equal(batches.reduce((sum, b) => sum + b.remaining, 0), after.body.currentStock);
  assert.equal(after.body.expiryDate.slice(0, 10), far, 'com o lote mais próximo esgotado, a validade do produto passa a ser a do próximo');
});

test('lotes: a venda não leva o lote vencido, mas a perda sem lote baixa o vencido primeiro', async () => {
  const product = await newProduct('Produto Lote Vencido', { initialStock: 3, expiryDate: dayFromToday(-2) });
  await entry(product.id, 5, dayFromToday(40));

  assert.equal((await sell(adminJar, product.id, 2)).status, 201);
  let batches = await batchesOf(product.id);
  assert.deepEqual(batches.map((b) => [b.urgency, b.remaining]), [['RED', 3], ['GREEN', 3]], 'a venda sai do lote válido; o vencido continua no alerta');

  const loss = await request(baseUrl, adminJar, '/api/stock/adjustments', {
    method: 'POST',
    body: { productId: product.id, quantity: -3, reason: 'Vencido', type: 'LOSS' },
  });
  assert.equal(loss.status, 201);
  batches = await batchesOf(product.id);
  assert.deepEqual(batches.map((b) => b.remaining), [3], 'a perda zera o lote vencido');
  assert.equal(batches[0].expiryDate.slice(0, 10), dayFromToday(40));
});

test('lotes: o cancelamento devolve cada unidade ao lote de onde saiu, uma vez só', async () => {
  const product = await newProduct('Produto Cancela Lote');
  await entry(product.id, 2, dayFromToday(5));
  await entry(product.id, 3, dayFromToday(45));

  const sale = await sell(adminJar, product.id, 3);
  assert.deepEqual((await batchesOf(product.id)).map((b) => b.remaining), [2], 'a venda levou 2 do primeiro lote e 1 do segundo');

  const cancel = await request(baseUrl, adminJar, `/api/sales/${sale.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.deepEqual((await batchesOf(product.id)).map((b) => b.remaining), [2, 3]);

  // Dois cancelamentos simultâneos da mesma venda: só um devolve o estoque.
  const other = await sell(adminJar, product.id, 1);
  const results = await Promise.all([1, 2].map(() => request(baseUrl, adminJar, `/api/sales/${other.body.id}/cancel`, { method: 'POST' })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const after = await request(baseUrl, adminJar, `/api/products/${product.id}`);
  assert.equal(after.body.currentStock, 5, 'o estoque volta uma única vez');
});

test('lotes: ajuste mira um lote, cria lote novo com validade e recusa lote de outro produto', async () => {
  const product = await newProduct('Produto Ajuste Lote');
  const other = await newProduct('Produto Outro Lote', { initialStock: 1 });
  const first = await entry(product.id, 10, dayFromToday(20));
  const batchId = first.body.batch.id;
  const adjust = (body) => request(baseUrl, adminJar, '/api/stock/adjustments', { method: 'POST', body: { reason: 'Contagem', ...body } });

  assert.equal((await adjust({ productId: product.id, quantity: -2, batchId })).status, 201);
  assert.equal((await batchesOf(product.id))[0].remaining, 8);

  const wrongProduct = await adjust({ productId: other.id, quantity: -1, batchId });
  assert.equal(wrongProduct.status, 404);
  assert.equal((await request(baseUrl, adminJar, `/api/products/${other.id}`)).body.currentStock, 1, 'nada muda quando o lote não é do produto');

  assert.equal((await adjust({ productId: product.id, quantity: -9, batchId })).status, 400, 'o lote não pode ficar negativo');

  const found = await adjust({ productId: product.id, quantity: 2, expiryDate: dayFromToday(90) });
  assert.equal(found.status, 201);
  assert.equal(found.body.batch.expiryDate.slice(0, 10), dayFromToday(90));
  assert.equal(found.body.currentStock, 10);

  assert.equal((await adjust({ productId: product.id, quantity: -1, expiryDate: dayFromToday(90) })).status, 400, 'validade só vale para lote novo');
});

test('lotes: corrigir a validade de um lote recalcula a validade do produto', async () => {
  const product = await newProduct('Produto Corrige Lote', { initialStock: 4, expiryDate: dayFromToday(3) });
  const [batch] = await batchesOf(product.id);

  const fix = await request(baseUrl, adminJar, `/api/stock/batches/${batch.id}`, { method: 'PUT', body: { expiryDate: dayFromToday(200) } });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.remaining, 4, 'corrigir a validade não mexe no saldo');
  const after = await request(baseUrl, adminJar, `/api/products/${product.id}`);
  assert.equal(after.body.expiryDate.slice(0, 10), dayFromToday(200));

  const missing = await request(baseUrl, adminJar, '/api/stock/batches/00000000-0000-4000-8000-000000000000', { method: 'PUT', body: { expiryDate: null } });
  assert.equal(missing.status, 404);
});

test('produtos: validade reenviada igual é ignorada; lote único é corrigido; lotes diferentes 409; sem saldo 400', async () => {
  const d1 = dayFromToday(50);
  const product = await newProduct('Produto Edita Validade', { initialStock: 5, expiryDate: d1 });
  const put = (id, body) => request(baseUrl, adminJar, `/api/products/${id}`, { method: 'PUT', body });

  const samePrice = await put(product.id, { salePrice: 9, expiryDate: d1 });
  assert.equal(samePrice.status, 200, 'a tela de edição sempre reenvia a validade atual');
  assert.equal(samePrice.body.salePrice, 9);

  const moved = await put(product.id, { expiryDate: dayFromToday(70) });
  assert.equal(moved.status, 200);
  assert.equal((await batchesOf(product.id))[0].expiryDate.slice(0, 10), dayFromToday(70), 'com um único lote, a validade vai para ele');

  await entry(product.id, 2, dayFromToday(100));
  const mixed = await put(product.id, { expiryDate: dayFromToday(80) });
  assert.equal(mixed.status, 409);

  const empty = await newProduct('Produto Sem Saldo Validade', { initialStock: 0, expiryDate: d1 });
  assert.equal(empty.expiryDate, null, 'sem estoque inicial, a validade é descartada');
  assert.equal((await put(empty.id, { expiryDate: d1 })).status, 400);
  assert.equal((await put(empty.id, { name: 'Produto Sem Saldo Validade 2', expiryDate: null })).status, 200);
});

test('importação: estoque somado pela planilha vira lote com a validade da linha', async () => {
  const product = await newProduct('Produto Import Lote', { barcode: '7890000000201', initialStock: 2, expiryDate: dayFromToday(15) });
  const [yyyy, mm, dd] = dayFromToday(120).split('-');
  const row = ['Produto Import Lote', '7890000000201', null, null, null, '2', '12', null, `${dd}/${mm}/${yyyy}`];

  const commit = await request(baseUrl, adminJar, '/api/imports/products/commit', { method: 'POST', body: importBody([row], { stockMode: 'add' }) });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.updated, 1);
  assert.deepEqual(
    (await batchesOf(product.id)).map((b) => [b.expiryDate.slice(0, 10), b.remaining]),
    [[dayFromToday(15), 2], [dayFromToday(120), 12]],
  );

  // Lotes com validades diferentes: a linha atualiza o resto e avisa sobre a validade.
  const preview = await request(baseUrl, adminJar, '/api/imports/products/preview', {
    method: 'POST',
    body: importBody([['Produto Import Lote', '7890000000201', null, null, null, '3', null, null, '01/01/2030']]),
  });
  assert.equal(preview.body.items[0].action, 'update');
  assert.ok(preview.body.items[0].warnings.some((w) => w.includes('validade não aplicada')));
});

// ---------- Semáforo de urgência ----------

test('semáforo: vermelho, amarelo e verde com os motivos, e o filtro por urgência', async () => {
  const soon = await newProduct('Semaforo Vence Logo', { initialStock: 10, minStock: 2, expiryDate: dayFromToday(5) });
  const low = await newProduct('Semaforo Baixo', { initialStock: 2, minStock: 2, expiryDate: dayFromToday(20) });
  const out = await newProduct('Semaforo Zerado', { initialStock: 0, minStock: 1 });
  const expired = await newProduct('Semaforo Vencido', { initialStock: 4, expiryDate: dayFromToday(-1) });
  const ok = await newProduct('Semaforo Ok', { initialStock: 10, minStock: 2, expiryDate: dayFromToday(90) });
  const noExpiry = await newProduct('Semaforo Sem Validade', { initialStock: 10, minStock: 2 });

  assert.deepEqual([soon.urgency, soon.urgencyReasons, soon.daysToExpiry], ['RED', ['EXPIRES_SOON'], 5]);
  assert.deepEqual([low.urgency, low.urgencyReasons, low.daysToExpiry], ['YELLOW', ['LOW_STOCK', 'EXPIRING'], 20]);
  assert.deepEqual([out.urgency, out.urgencyReasons], ['RED', ['OUT_OF_STOCK']]);
  assert.deepEqual([expired.urgency, expired.urgencyReasons, expired.daysToExpiry], ['RED', ['EXPIRED'], -1]);
  assert.deepEqual([ok.urgency, ok.urgencyReasons], ['GREEN', []]);
  assert.deepEqual([noExpiry.urgency, noExpiry.daysToExpiry], ['GREEN', null]);

  const red = await request(baseUrl, adminJar, '/api/products?urgency=RED&query=Semaforo');
  assert.deepEqual(red.body.map((p) => p.name), ['Semaforo Vence Logo', 'Semaforo Vencido', 'Semaforo Zerado']);

  const paged = await request(baseUrl, adminJar, '/api/products?urgency=GREEN&query=Semaforo&page=1&pageSize=1');
  assert.equal(paged.body.totalCount, 2);
  assert.deepEqual(paged.body.products.map((p) => p.name), ['Semaforo Ok']);

  assert.equal((await request(baseUrl, adminJar, '/api/products?urgency=AZUL')).status, 400);
});

// ---------- Lista de compras ----------

test('lista de compras: produtos no mínimo ou abaixo, por categoria, em JSON e em texto', async () => {
  await newProduct('Compra No Minimo', { category: 'Mercearia Teste', initialStock: 10, minStock: 10 });
  await newProduct('Compra Abaixo', { category: 'Mercearia Teste', initialStock: 1, minStock: 5 });
  await newProduct('Compra Acima', { category: 'Mercearia Teste', initialStock: 11, minStock: 10 });
  const inactive = await newProduct('Compra Inativo', { category: 'Mercearia Teste', initialStock: 0, minStock: 3 });
  await request(baseUrl, adminJar, `/api/products/${inactive.id}`, { method: 'DELETE' });

  const list = await request(baseUrl, adminJar, '/api/shopping-list');
  assert.equal(list.status, 200);
  const mine = list.body.items.filter((i) => i.category === 'Mercearia Teste');
  assert.deepEqual(mine.map((i) => i.name), ['Compra Abaixo', 'Compra No Minimo'], 'no mínimo entra; acima do mínimo e desativado ficam de fora');
  assert.deepEqual([mine[0].currentStock, mine[0].minStock, mine[0].unit], [1, 5, 'UN']);
  assert.ok(!('costPrice' in mine[0]), 'a lista nunca traz preço de custo');
  assert.equal(list.body.totalItems, list.body.items.length);

  const text = await request(baseUrl, adminJar, '/api/shopping-list?format=text');
  assert.match(text.headers.get('content-type'), /^text\/plain/);
  assert.match(text.body, /\*Mercearia Teste\*\n- Compra Abaixo: tem 1 UN, mínimo 5\n- Compra No Minimo: tem 10 UN, mínimo 10\n/);
  assert.equal((await request(baseUrl, adminJar, '/api/shopping-list?format=pdf')).status, 400);

  // Sem nada no mínimo, o texto diz que não há o que comprar.
  await prisma.product.updateMany({ where: { id: { in: list.body.items.map((i) => i.productId) } }, data: { active: false } });
  const empty = await request(baseUrl, adminJar, '/api/shopping-list?format=text');
  assert.match(empty.body, /Nada para comprar/);
});

// ---------- Caixa e forma de pagamento ----------

// Um funcionário só para o caixa, com um único login (o login aceita 10 tentativas
// por IP a cada 15 minutos, e a suíte inteira roda do mesmo IP).
let counterJar;
async function cashierJar() {
  if (!counterJar) {
    const credentials = { email: 'caixa.balcao@example.com', password: 'SenhaBalcao123!' };
    const created = await request(baseUrl, adminJar, '/api/users', { method: 'POST', body: { name: 'Caixa Balcão', ...credentials } });
    assert.equal(created.status, 201);
    counterJar = makeCookieJar();
    assert.equal((await request(baseUrl, counterJar, '/api/auth/login', { method: 'POST', body: credentials })).status, 200);
  }
  return counterJar;
}

const openCash = (jar, openingAmount) => request(baseUrl, jar, '/api/cash-sessions', { method: 'POST', body: { openingAmount } });
const closeCash = (jar, countedAmount, notes) =>
  request(baseUrl, jar, '/api/cash-sessions/current/close', { method: 'POST', body: { countedAmount, notes } });

test('caixa: abertura, vendas por forma de pagamento e fechamento com conciliação', async () => {
  const product = await newProduct('Produto Caixa', { initialStock: 100, salePrice: 10 });
  await closeCash(adminJar, 0); // o caixa aberto pela suíte
  const open = await openCash(adminJar, 100);
  assert.equal(open.status, 201);
  assert.equal(open.body.status, 'OPEN');
  assert.equal((await openCash(adminJar, 50)).status, 409, 'só um caixa aberto por vez');

  const cash = await sell(adminJar, product.id, 5); // R$ 50, dinheiro por padrão
  assert.equal(cash.body.paymentMethod, 'CASH');
  const pix = await sell(adminJar, product.id, 3, 'PIX'); // R$ 30 no Pix
  assert.equal(pix.body.paymentMethod, 'PIX');
  assert.equal((await sell(adminJar, product.id, 1, 'CHEQUE')).status, 400);
  const canceled = await sell(adminJar, product.id, 2, 'CASH'); // R$ 20, cancelada antes de fechar
  await request(baseUrl, adminJar, `/api/sales/${canceled.body.id}/cancel`, { method: 'POST' });

  const history = await request(baseUrl, adminJar, `/api/sales/${pix.body.id}`);
  assert.equal(history.body.paymentMethod, 'PIX');

  const current = await request(baseUrl, adminJar, '/api/cash-sessions/current');
  assert.equal(current.body.expectedAmount, 150, 'fundo de troco + só o dinheiro de vendas não canceladas');
  assert.deepEqual(current.body.totalsByPaymentMethod, { CASH: 50, PIX: 30, DEBIT_CARD: 0, CREDIT_CARD: 0 });

  const counter = await cashierJar();
  const counterView = await request(baseUrl, counter, '/api/cash-sessions/current');
  assert.equal(counterView.status, 200);
  assert.equal(counterView.body.openingAmount, 100);
  assert.ok(!('expectedAmount' in counterView.body) && !('totalsByPaymentMethod' in counterView.body), 'o caixa não vê valores de venda');
  assert.equal((await request(baseUrl, counter, '/api/cash-sessions')).status, 403);
  assert.equal((await request(baseUrl, counter, `/api/cash-sessions/${open.body.id}`)).status, 403);

  const close = await closeCash(adminJar, 140, 'Faltou troco');
  assert.equal(close.status, 200);
  assert.deepEqual(
    [close.body.status, close.body.expectedAmount, close.body.countedAmount, close.body.difference, close.body.notes],
    ['CLOSED', 150, 140, -10, 'Faltou troco'],
  );
  assert.equal((await request(baseUrl, adminJar, '/api/cash-sessions/current')).status, 404);
  assert.equal((await closeCash(adminJar, 0)).status, 404);

  // Com o caixa fechado a venda é recusada e o estoque não muda.
  const stockBefore = (await request(baseUrl, adminJar, `/api/products/${product.id}`)).body.currentStock;
  const refused = await sell(adminJar, product.id, 1);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Caixa fechado/);
  assert.equal((await request(baseUrl, adminJar, `/api/products/${product.id}`)).body.currentStock, stockBefore);
  const detail = await request(baseUrl, adminJar, `/api/cash-sessions/${open.body.id}`);
  assert.deepEqual([detail.body.expectedAmount, detail.body.difference, detail.body.salesCount, detail.body.salesTotal], [150, -10, 2, 80]);

  const list = await request(baseUrl, adminJar, '/api/cash-sessions?pageSize=5');
  assert.equal(list.body.sessions[0].id, open.body.id);
  assert.equal((await request(baseUrl, adminJar, '/api/cash-sessions/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await openCash(adminJar, 0)).status, 201);
});

test('caixa: fechamento cego quando quem fecha é o funcionário', async () => {
  const counter = await cashierJar();
  await closeCash(adminJar, 0);
  assert.equal((await openCash(counter, 20)).status, 201);
  const close = await closeCash(counter, 25);
  assert.equal(close.status, 200);
  assert.equal(close.body.countedAmount, 25);
  assert.ok(!('expectedAmount' in close.body) && !('difference' in close.body), 'fechamento cego: o funcionário não vê esperado nem diferença');

  const detail = await request(baseUrl, adminJar, `/api/cash-sessions/${close.body.id}`);
  assert.deepEqual([detail.body.expectedAmount, detail.body.difference], [20, 5], 'o administrador vê a sobra');
  assert.equal((await openCash(adminJar, 0)).status, 201);
});

test('caixa: vendas simultâneas ao fechamento entram no esperado gravado ou são recusadas', async () => {
  // Vendas de 10 itens dos mesmos produtos: cada transação é longa e as seguintes
  // esperam na fila dos locks de produto já ligadas ao caixa — é nessa janela que
  // um fechamento sem lock somaria antes delas terminarem.
  const products = [];
  for (let i = 0; i < 10; i += 1) products.push(await newProduct(`Produto Caixa Corrida ${i}`, { initialStock: 1000, salePrice: 1 }));
  const items = products.map((p) => ({ productId: p.id, quantity: 1 }));
  await closeCash(adminJar, 0);
  const open = await openCash(adminJar, 0);
  assert.equal(open.status, 201);

  const sales = Array.from({ length: 6 }, () => request(baseUrl, adminJar, '/api/sales', { method: 'POST', body: { items } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const close = closeCash(adminJar, 0);
  const results = await Promise.all([...sales, close]);
  // A venda que chega depois do fechamento não encontra caixa aberto: 409, nada gravado.
  assert.equal(results.at(-1).status, 200);
  assert.ok(results.slice(0, -1).every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => [r.status, r.body && r.body.error])));

  const linked = await prisma.sale.aggregate({
    where: { cashSessionId: open.body.id, canceled: false, paymentMethod: 'CASH' },
    _sum: { totalAmount: true },
  });
  const session = await prisma.cashSession.findUnique({ where: { id: open.body.id } });
  assert.equal(Number(session.expectedAmount), Number(linked._sum.totalAmount ?? 0), 'toda venda ligada ao caixa está no esperado gravado');
  const accepted = results.slice(0, -1).filter((r) => r.status === 201).length;
  assert.equal(await prisma.sale.count({ where: { cashSessionId: open.body.id } }), accepted, 'toda venda aceita ficou ligada ao caixa');
  assert.equal((await openCash(adminJar, 0)).status, 201);
});

test('recibo: GET /api/settings devolve o nome do estabelecimento a quem está logado', async () => {
  for (const jar of [adminJar, await cashierJar()]) {
    const res = await request(baseUrl, jar, '/api/settings');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { storeName: config.storeName });
  }
  assert.equal((await request(baseUrl, makeCookieJar(), '/api/settings')).status, 401);
});

test('venda: o total é a soma dos subtotais arredondados (o recibo fecha a conta com quilo fracionado)', async () => {
  const products = [];
  for (const n of [1, 2, 3]) products.push(await newProduct(`Produto Granel ${n}`, { unit: 'KG', salePrice: 1.99, initialStock: 5 }));
  const res = await request(baseUrl, adminJar, '/api/sales', { method: 'POST', body: { items: products.map((p) => ({ productId: p.id, quantity: 0.333 })) } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.items.map((i) => i.subtotal), [0.66, 0.66, 0.66]);
  assert.equal(res.body.totalAmount, 1.98); // sem arredondar item a item dava 1,99
});

test('caixa: sangria e suprimento entram no esperado, com motivo obrigatório', async () => {
  const product = await newProduct('Produto Sangria', { initialStock: 50, salePrice: 10 });
  const counter = await cashierJar();
  const move = (jar, body) => request(baseUrl, jar, '/api/cash-sessions/current/movements', { method: 'POST', body });
  await closeCash(adminJar, 0);
  assert.equal((await move(adminJar, { type: 'WITHDRAWAL', amount: 10, reason: 'Sem caixa' })).status, 404, 'sem caixa aberto não há movimentação');

  assert.equal((await openCash(adminJar, 100)).status, 201);
  assert.equal((await sell(adminJar, product.id, 5)).status, 201); // R$ 50 em dinheiro
  const withdrawal = await move(adminJar, { type: 'WITHDRAWAL', amount: 60, reason: '  Depósito no banco  ' });
  assert.equal(withdrawal.status, 201);
  assert.deepEqual([withdrawal.body.type, withdrawal.body.amount, withdrawal.body.reason, withdrawal.body.createdBy], ['WITHDRAWAL', 60, 'Depósito no banco', 'Admin Teste']);
  assert.equal((await move(counter, { type: 'DEPOSIT', amount: 20, reason: 'Mais troco' })).status, 201, 'o funcionário também registra');

  assert.equal((await move(adminJar, { type: 'WITHDRAWAL', amount: 5, reason: '   ' })).status, 400, 'motivo obrigatório');
  assert.equal((await move(adminJar, { type: 'WITHDRAWAL', amount: 0, reason: 'Zero' })).status, 400, 'valor maior que zero');
  assert.equal((await move(adminJar, { type: 'GORJETA', amount: 5, reason: 'Tipo inválido' })).status, 400);

  const current = await request(baseUrl, adminJar, '/api/cash-sessions/current');
  assert.deepEqual([current.body.expectedAmount, current.body.depositsTotal, current.body.withdrawalsTotal], [110, 20, 60], '100 + 50 + 20 - 60');
  assert.deepEqual(current.body.movements.map((m) => [m.type, m.amount, m.reason, m.createdBy]), [
    ['WITHDRAWAL', 60, 'Depósito no banco', 'Admin Teste'],
    ['DEPOSIT', 20, 'Mais troco', 'Caixa Balcão'],
  ]);
  const counterView = await request(baseUrl, counter, '/api/cash-sessions/current');
  assert.ok(!('movements' in counterView.body) && !('withdrawalsTotal' in counterView.body), 'fechamento cego: o funcionário não vê os valores');

  const close = await closeCash(adminJar, 105);
  assert.deepEqual([close.body.expectedAmount, close.body.difference, close.body.withdrawalsTotal, close.body.depositsTotal], [110, -5, 60, 20]);
  const list = await request(baseUrl, adminJar, '/api/cash-sessions?pageSize=1');
  assert.deepEqual([list.body.sessions[0].id, list.body.sessions[0].withdrawalsTotal], [close.body.id, 60]);
  assert.equal((await move(adminJar, { type: 'DEPOSIT', amount: 1, reason: 'Depois de fechar' })).status, 404);
  assert.equal((await openCash(adminJar, 0)).status, 201);
});

test('financeiro: faturamento, CMV, lucro, margem, ticket médio, formas de pagamento e top produtos', async () => {
  const a = await newProduct('Produto Financeiro A', { costPrice: 4, salePrice: 10, initialStock: 20 });
  const b = await newProduct('Produto Financeiro B', { costPrice: 0, salePrice: 5, initialStock: 20 }); // custo não informado
  const c = await newProduct('Produto Financeiro C', { unit: 'KG', costPrice: 30, salePrice: 39.9, initialStock: 20 });
  const sales = [
    await sell(adminJar, a.id, 3, 'CASH'), // R$ 30,00, custo 12,00
    await sell(adminJar, b.id, 2, 'PIX'), // R$ 10,00, custo 0
    await sell(adminJar, c.id, 0.5, 'DEBIT_CARD'), // R$ 19,95, custo 15,00
    await sell(adminJar, a.id, 1, 'CASH'), // cancelada: fica de fora
  ];
  assert.ok(sales.every((r) => r.status === 201));
  await request(baseUrl, adminJar, `/api/sales/${sales[3].body.id}/cancel`, { method: 'POST' });
  // Num dia só deles, longe das vendas dos outros testes (feitas hoje).
  await prisma.sale.updateMany({ where: { id: { in: sales.map((r) => r.body.id) } }, data: { createdAt: new Date(2020, 0, 15, 12) } });
  // O custo muda depois da venda: o CMV continua com o custo gravado na venda.
  await prisma.product.update({ where: { id: a.id }, data: { costPrice: '9.00' } });

  const res = await request(baseUrl, adminJar, '/api/reports/financial?startDate=2020-01-15&endDate=2020-01-15');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body;
  assert.deepEqual(r.period, { startDate: '2020-01-15', endDate: '2020-01-15' });
  assert.deepEqual(
    [r.grossRevenue, r.costOfGoodsSold, r.profit, r.profitMargin, r.salesCount, r.averageTicket],
    [59.95, 27, 32.95, 54.96, 3, 19.98], // 32,95 / 59,95 = 54,96%; 59,95 / 3 = 19,98
  );
  assert.deepEqual(r.byPaymentMethod, [
    { method: 'CASH', salesCount: 1, total: 30, percentage: 50.04 },
    { method: 'PIX', salesCount: 1, total: 10, percentage: 16.68 },
    { method: 'DEBIT_CARD', salesCount: 1, total: 19.95, percentage: 33.28 },
    { method: 'CREDIT_CARD', salesCount: 0, total: 0, percentage: 0 },
  ]);
  assert.deepEqual(r.topProducts.map((p) => [p.name, p.quantity, p.revenue, p.cost, p.profit, p.margin, p.costMissing]), [
    ['Produto Financeiro A', 3, 30, 12, 18, 60, false],
    ['Produto Financeiro B', 2, 10, 0, 10, 100, true],
    ['Produto Financeiro C', 0.5, 19.95, 15, 4.95, 24.81, false],
  ]);
  assert.equal(r.productsWithoutCost, 1);

  const empty = (await request(baseUrl, adminJar, '/api/reports/financial?startDate=2019-01-01&endDate=2019-01-31')).body;
  assert.deepEqual(
    [empty.grossRevenue, empty.costOfGoodsSold, empty.profit, empty.profitMargin, empty.salesCount, empty.averageTicket, empty.topProducts.length],
    [0, 0, 0, null, 0, null, 0],
    'sem vendas: margem e ticket médio null, sem divisão por zero',
  );
  assert.ok(empty.byPaymentMethod.every((m) => m.total === 0 && m.percentage === null));

  const month = (await request(baseUrl, adminJar, '/api/reports/financial')).body.period;
  const now = new Date();
  assert.equal(month.startDate, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, 'padrão: do dia 1º do mês até hoje');

  const bad = async (qs) => (await request(baseUrl, adminJar, `/api/reports/financial?${qs}`)).status;
  assert.equal(await bad('startDate=2026-02-30'), 400, 'data que não existe');
  assert.equal(await bad('startDate=lixo'), 400);
  assert.equal(await bad('startDate=2020-02-01&endDate=2020-01-01'), 400, 'início depois do fim');
  assert.equal((await request(baseUrl, await cashierJar(), '/api/reports/financial')).status, 403, 'custo e margem são só do administrador');
});

test('relatórios: o resumo por dia usa o fuso da loja (venda das 22h fica no próprio dia)', async () => {
  const product = await newProduct('Produto Noite', { initialStock: 5, salePrice: 7 });
  const sale = await sell(adminJar, product.id, 1);
  await prisma.sale.update({ where: { id: sale.body.id }, data: { createdAt: new Date(2020, 2, 10, 22, 30) } });
  const res = await request(baseUrl, adminJar, `/api/reports/sales-summary?from=${encodeURIComponent(new Date(2020, 2, 10).toISOString())}&to=${encodeURIComponent(new Date(2020, 2, 11).toISOString())}`);
  assert.deepEqual(res.body.byDay, { '2020-03-10': 7 });
});
