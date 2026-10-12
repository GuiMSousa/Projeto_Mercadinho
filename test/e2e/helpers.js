// Base comum dos testes de ponta a ponta: navegador real (Edge por padrão) via
// playwright-core, contra um servidor já no ar. Rode tudo com `npm run test:e2e`.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const base = process.argv[2] || process.env.E2E_BASE_URL || 'http://localhost:3999';
// Criados pelo test/e2e/run.js no banco de teste.
const ADMIN = { email: 'admin.test@example.com', password: 'TesteSenha123!' };
const CASHIER = { email: 'caixa.balcao@example.com', password: 'SenhaBalcao123!' };

const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const shot = (name) => path.join(shotsDir, name);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

let pass = 0;
let fail = 0;
const problems = [];
const check = (cond, label) => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '✔' : '✖'} ${label}`);
};

// E2E_BROWSER=chrome usa o Chrome instalado; E2E_HEADED=true mostra a janela.
const launch = (args = []) => chromium.launch({ channel: process.env.E2E_BROWSER || 'msedge', headless: process.env.E2E_HEADED !== 'true', args });

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };

// Cliente da API logado como `who`, para preparar dados sem passar pela tela.
async function apiAs(who) {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify(who) });
  if (!login.ok) throw new Error(`login ${who.email}: HTTP ${login.status}`);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}/api${p}`, { method, headers: { ...H, Cookie: cookie }, body: body && JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}

async function newPage(browser, { permissions = [], initScript } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  if (permissions.length) await context.grantPermissions(permissions, { origin: base });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  // Respostas de erro esperadas: 401 do /auth/me na tela de login e 404 de "nenhum caixa aberto".
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const p = new URL(r.url()).pathname;
    const expected = (r.status() === 401 && p === '/api/auth/me') || (r.status() === 404 && p === '/api/cash-sessions/current');
    if (!expected) problems.push(`HTTP ${r.status()} ${p}`);
  });
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return page;
}

async function login(page, who) {
  await page.goto(`${base}/`);
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/app.html');
}

// Com o caixa fechado o app pede a abertura ao entrar: "Agora não".
async function skipCashOpen(page) {
  const later = await page.waitForSelector('#cash-open-later', { timeout: 3000 }).catch(() => null);
  if (later) await later.click();
}

function run(main) {
  main()
    .then(() => {
      if (problems.length) console.log(`Erros do navegador:\n${problems.join('\n')}`);
      check(problems.length === 0, 'nenhum erro de JavaScript/CSP nem resposta HTTP de erro inesperada');
      console.log(`\n${pass} verificações ok, ${fail} falha(s)`);
      process.exit(fail ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { base, ADMIN, CASHIER, shot, norm, check, launch, apiAs, newPage, login, skipCashOpen, run };
