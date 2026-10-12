// Teste de ponta a ponta da Etapa 2: semáforo (painel, produtos, filtro) e lista de compras.
const { ADMIN, CASHIER, shot, norm, check, launch, apiAs, newPage, login, skipCashOpen, run } = require('./helpers');

const stamp = Date.now();
const category = `E2E Cat ${stamp}`;
const names = {
  out: `E2E Sem estoque ${stamp}`,
  soon: `E2E Vence logo ${stamp}`,
  low: `E2E Baixo ${stamp}`,
  ok: `E2E Ok ${stamp}`,
};
// Simula o acesso por http://IP-da-rede, onde navigator.clipboard não existe.
const removeClipboard = () => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined });
const CLIPBOARD = ['clipboard-read', 'clipboard-write'];

function dayFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const rowOf = (page, name) => page.locator('#products-list tr', { hasText: name });

run(async () => {
  const api = await apiAs(ADMIN);
  const make = (name, body) => api('/products', { method: 'POST', body: { name, category, unit: 'UN', costPrice: 1, salePrice: 2, ...body } });
  await make(names.out, { initialStock: 0, minStock: 2 });
  await make(names.soon, { initialStock: 10, minStock: 2, expiryDate: dayFromToday(5) });
  await make(names.low, { initialStock: 2, minStock: 5, expiryDate: dayFromToday(200) });
  await make(names.ok, { initialStock: 10, minStock: 2, expiryDate: dayFromToday(90) });
  const expected = {};
  for (const level of ['RED', 'YELLOW', 'GREEN']) expected[level] = (await api(`/products?urgency=${level}&page=1&pageSize=1`)).totalCount;

  const browser = await launch();
  const page = await newPage(browser, { permissions: CLIPBOARD });
  await login(page, ADMIN);
  await skipCashOpen(page);

  // ---------- Painel ----------
  await page.waitForSelector('.semaforo-card');
  const cards = (await page.locator('.semaforo-card').allInnerTexts()).map(norm);
  check(cards.length === 3, 'painel mostra os 3 cartões do semáforo');
  check(cards[0].startsWith(`🔴 ${expected.RED} Vermelho`) && cards[1].startsWith(`🟡 ${expected.YELLOW} Amarelo`) && cards[2].startsWith(`🟢 ${expected.GREEN} Verde`),
    `contagens do painel batem com a API (🔴 ${expected.RED}, 🟡 ${expected.YELLOW}, 🟢 ${expected.GREEN})`);
  await page.screenshot({ path: shot('11-painel-semaforo.png') });

  await page.click('.semaforo-card.red');
  await page.waitForSelector('#products-list tr');
  check((await page.getAttribute('.filter-chip[data-urgency="RED"]', 'aria-pressed')) === 'true', 'tocar no cartão vermelho abre Produtos com o filtro 🔴 marcado');
  const redBadges = (await page.locator('#products-list .badge.semaforo').allInnerTexts()).map(norm);
  check(redBadges.length > 0 && redBadges.every((b) => b === '🔴 Vermelho'), `a lista mostra só produtos vermelhos (${redBadges.length} na página)`);
  const redTotal = Number((norm(await page.innerText('#products-pager')).match(/de (d+)/) || [])[1] || redBadges.length);
  check(redTotal === expected.RED, `o total filtrado bate com o número do cartão (${redTotal} = ${expected.RED})`);

  // ---------- Produtos ----------
  await page.click('.filter-chip[data-urgency=""]');
  await page.fill('#product-search', String(stamp));
  await page.waitForFunction((n) => document.querySelectorAll('#products-list tr').length === 4 && document.getElementById('products-list').textContent.includes(n), names.ok);
  const cell = async (name) => norm(await rowOf(page, name).locator('td').first().innerText());
  check((await cell(names.out)) === '🔴 Vermelho Sem estoque', `sem estoque: "${await cell(names.out)}"`);
  check((await cell(names.soon)) === '🔴 Vermelho Vence em 5 dias', `vencendo: "${await cell(names.soon)}"`);
  check((await cell(names.low)) === '🟡 Amarelo Abaixo do estoque mínimo', `abaixo do mínimo: "${await cell(names.low)}"`);
  check((await cell(names.ok)) === '🟢 Verde', `em ordem: "${await cell(names.ok)}"`);
  check((await rowOf(page, names.soon).locator('.badge.semaforo').getAttribute('title')) === 'Vence em 5 dias', 'tooltip do selo traz o motivo');
  await page.screenshot({ path: shot('12-produtos-semaforo.png'), fullPage: true });

  await page.click('.filter-chip[data-urgency="YELLOW"]');
  await page.waitForFunction(() => document.querySelectorAll('#products-list tr').length === 1);
  check(norm(await page.innerText('#products-list')).includes(names.low), 'filtro 🟡 com a busca mostra só o produto abaixo do mínimo');
  await page.click('.filter-chip[data-urgency="GREEN"]');
  await page.waitForFunction((n) => document.getElementById('products-list').textContent.includes(n), names.ok);
  check((await page.locator('#products-list tr').count()) === 1, 'filtro 🟢 mostra só o produto em ordem');

  // ---------- Compras ----------
  await page.click('button[data-tab="compras"]');
  await page.waitForSelector('#shop-list tr');
  const shopping = norm(await page.innerText('#shop-list'));
  check(shopping.includes(names.out) && shopping.includes(names.low), 'lista de compras traz os produtos no mínimo ou abaixo');
  check(!shopping.includes(names.ok) && !shopping.includes(names.soon), 'produtos acima do mínimo ficam de fora');
  const text = await page.inputValue('#shop-text');
  check(text.includes(`*${category}*\n- ${names.low}: tem 2 UN, mínimo 5`), 'prévia mostra a mensagem do WhatsApp agrupada por categoria');

  await page.click('#shop-copy-btn');
  await page.waitForSelector('#shop-msg:not([hidden])');
  check(norm(await page.innerText('#shop-msg')).startsWith('Lista copiada'), 'aviso de confirmação após copiar');
  // O Windows grava as quebras de linha como \r\n na área de transferência.
  const clipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  check((await clipboard()) === text, 'a área de transferência recebeu exatamente o texto da lista');

  const link = page.locator('#shop-wa-link');
  const href = await link.getAttribute('href');
  check(href.startsWith('https://wa.me/?text=') && decodeURIComponent(href.slice('https://wa.me/?text='.length)) === text, 'link do WhatsApp leva a mensagem pronta');
  check((await link.getAttribute('target')) === '_blank' && (await link.getAttribute('rel')) === 'noopener', 'link do WhatsApp abre em outra aba, sem acesso à página de origem');
  await page.screenshot({ path: shot('13-compras.png'), fullPage: true });

  // ---------- Funcionário, sem a API de área de transferência ----------
  const cashierPage = await newPage(browser, { permissions: CLIPBOARD, initScript: removeClipboard });
  await login(cashierPage, CASHIER);
  await skipCashOpen(cashierPage);
  await cashierPage.waitForSelector('.semaforo-card');
  check(true, 'funcionário também vê o semáforo no painel');
  await cashierPage.evaluate(() => navigator.clipboard === undefined).then((gone) => check(gone, 'simulação: navigator.clipboard indisponível (acesso por http://IP)'));
  await cashierPage.click('button[data-tab="compras"]');
  await cashierPage.waitForSelector('#shop-list tr');
  await page.evaluate(() => navigator.clipboard.writeText('limpo'));
  await cashierPage.click('#shop-copy-btn');
  await cashierPage.waitForSelector('#shop-msg:not([hidden]), #shop-error:not([hidden])');
  check(await cashierPage.isVisible('#shop-msg'), 'sem a API de cópia, o método alternativo copia e confirma');
  check((await clipboard()) === text, 'o método alternativo pôs o texto certo na área de transferência');

  await browser.close();
});
