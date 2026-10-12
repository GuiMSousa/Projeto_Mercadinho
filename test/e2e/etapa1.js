// Teste de ponta a ponta da Etapa 1: PDV com pagamento/troco, caixa e entrada com validade.
// Espera o caixa fechado e o banco recém-preparado pelo test/e2e/run.js.
const { ADMIN, CASHIER, shot, norm, check, launch, apiAs, newPage, login, run } = require('./helpers');

const stamp = Date.now();
const productName = `E2E Arroz ${stamp}`;

async function addToCart(page) {
  await page.fill('#sale-search', String(stamp));
  await page.waitForSelector('#sale-results div:not(.muted)');
  await page.click('#sale-results div');
}

async function sizes(page, selector) {
  return page.$$eval(selector, (els) => els.map((e) => ({ h: e.getBoundingClientRect().height, f: parseFloat(getComputedStyle(e).fontSize) })));
}

run(async () => {
  const api = await apiAs(ADMIN);
  await api('/products', { method: 'POST', body: { name: productName, unit: 'UN', costPrice: 5, salePrice: 7.5, initialStock: 100, expiryDate: '2028-01-31' } });
  const browser = await launch();

  // ---------- Administrador ----------
  const page = await newPage(browser);
  await login(page, ADMIN);
  await page.waitForSelector('#cash-open-form', { timeout: 5000 });
  check(true, 'sem caixa aberto, o app pede a abertura logo ao entrar');
  check(norm(await page.textContent('#cash-chip')) === 'Caixa fechado', 'indicador do topo mostra "Caixa fechado"');
  await page.click('#cash-opening-quick button[data-cash="50"]');
  await page.click('#cash-opening-quick button[data-cash="50"]');
  check((await page.inputValue('#cash-opening')) === '100,00', 'botões de cédula somam o fundo (50 + 50 = 100,00)');
  await page.screenshot({ path: shot('01-abrir-caixa.png') });
  await page.click('#cash-open-form button[type="submit"]');
  await page.waitForSelector('#cash-open-form', { state: 'detached' });
  await page.waitForFunction(() => document.getElementById('cash-chip').textContent.includes('aberto'));
  check(true, 'caixa aberto e indicador atualizado para "Caixa aberto"');

  await page.click('button[data-tab="vendas"]');
  await page.waitForSelector('#sale-search');
  check(await page.isHidden('#sale-cash-warning'), 'com caixa aberto, a tela de vendas não mostra o aviso');
  await addToCart(page);
  check(await page.isDisabled('#confirm-sale-btn'), 'confirmar fica bloqueado sem forma de pagamento');
  check(norm(await page.textContent('#sale-hint')) === 'Escolha a forma de pagamento.', 'a dica pede a forma de pagamento');
  await page.click('.pay-btn[data-method="CASH"]');
  check(await page.isVisible('#cash-box'), 'Dinheiro mostra o campo de valor entregue');
  check(await page.isDisabled('#confirm-sale-btn'), 'em dinheiro, sem valor entregue continua bloqueado');
  await page.fill('#cash-received', '5');
  check(norm(await page.textContent('#cash-change')) === 'Faltam R$ 2,50', 'valor menor que o total mostra quanto falta (R$ 2,50)');
  check(await page.isDisabled('#confirm-sale-btn'), 'valor entregue menor que o total bloqueia a venda');
  await page.fill('#cash-received', 'abc');
  check(norm(await page.textContent('#sale-hint')).startsWith('Valor entregue inválido'), 'valor digitado inválido é apontado');
  await page.click('#cash-received-quick button[data-cash="clear"]');
  await page.click('#cash-received-quick button[data-cash="10"]');
  check(norm(await page.textContent('#cash-change')) === 'Troco: R$ 2,50', 'troco em tempo real (R$ 10 − R$ 7,50 = R$ 2,50)');
  check(!(await page.isDisabled('#confirm-sale-btn')), 'com valor suficiente, confirmar é liberado');

  const pdv = {
    confirmar: await sizes(page, '#confirm-sale-btn'),
    pagamento: await sizes(page, '.pay-btn'),
    cedulas: await sizes(page, '#cash-received-quick button'),
    campos: await sizes(page, '#sale-search, #cash-received'),
  };
  const all = Object.values(pdv).flat();
  check(all.every((s) => s.h >= 60), `todos os botões e campos do PDV têm ≥ 60px (menor: ${Math.min(...all.map((s) => s.h)).toFixed(0)}px)`);
  check(all.every((s) => s.f >= 21.3), `texto do PDV ≥ 16pt/21,3px (menor: ${Math.min(...all.map((s) => s.f)).toFixed(1)}px)`);
  await page.screenshot({ path: shot('02-pdv-troco.png'), fullPage: true });

  await page.click('#confirm-sale-btn');
  await page.waitForSelector('#receipt-payment');
  const receipt = norm(await page.textContent('#receipt-payment'));
  check(receipt === 'Pagamento: Dinheiro · Recebido R$ 10,00 · Troco R$ 2,50', `comprovante com pagamento e troco: "${receipt}"`);
  await page.screenshot({ path: shot('03-comprovante.png') });
  await page.click('#receipt-close-btn');
  check((await page.getAttribute('.pay-btn[data-method="CASH"]', 'aria-pressed')) === 'false', 'a forma de pagamento volta em branco para a próxima venda');
  check(await page.isHidden('#cash-box'), 'o campo de valor entregue some para a próxima venda');
  await page.waitForFunction(() => document.querySelector('#sales-list tr td'));
  check(norm(await page.textContent('#sales-list tr:first-child')).includes('Dinheiro'), 'histórico mostra "Dinheiro" na venda');

  await addToCart(page);
  await page.click('.pay-btn[data-method="PIX"]');
  check(await page.isHidden('#cash-box'), 'Pix não pede valor entregue');
  await page.click('#confirm-sale-btn');
  await page.waitForSelector('#receipt-payment');
  check(norm(await page.textContent('#receipt-payment')) === 'Pagamento: Pix', 'comprovante do Pix');
  await page.click('#receipt-close-btn');
  await page.waitForFunction(() => document.querySelector('#sales-list tr:first-child')?.textContent.includes('Pix'));
  check(true, 'histórico mostra "Pix" na venda mais recente');

  await page.click('button[data-tab="caixa"]');
  await page.waitForSelector('#cash-live:not([hidden])');
  const live = norm(await page.innerText('#cash-live'));
  check(live.includes('Dinheiro esperado na gaveta R$ 107,50'), 'admin vê o esperado ao vivo: fundo 100 + 7,50 em dinheiro');
  check(live.includes('Pix R$ 7,50') && live.includes('Total vendido (2) R$ 15,00'), 'admin vê Pix separado e o total vendido');
  check(await page.isVisible('#cash-history-section'), 'admin vê o histórico de caixas');
  await page.screenshot({ path: shot('04-caixa-admin.png'), fullPage: true });

  await page.click('#cash-close-btn');
  await page.waitForSelector('#cash-close-form');
  check(!norm(await page.textContent('#cash-close-form')).includes('107,50'), 'a tela de contagem não mostra o valor esperado');
  await page.fill('#cash-counted', '105');
  page.once('dialog', (d) => d.accept());
  await page.click('#cash-close-form button[type="submit"]');
  await page.waitForSelector('#cash-summary-body');
  const summary = norm(await page.innerText('#cash-summary-body'));
  check(summary.includes('Dinheiro esperado R$ 107,50') && summary.includes('Dinheiro contado R$ 105,00') && summary.includes('Falta R$ 2,50'),
    'conciliação do admin: esperado 107,50, contado 105,00, falta 2,50');
  await page.screenshot({ path: shot('05-fechamento-admin.png') });
  await page.click('#cash-summary-ok');
  await page.waitForFunction(() => document.getElementById('cash-chip').textContent.includes('fechado'));
  check(true, 'indicador volta para "Caixa fechado"');
  check(norm(await page.textContent('#cash-history tr:first-child')).includes('Falta R$ 2,50'), 'histórico mostra a falta de R$ 2,50');

  await page.click('button[data-tab="vendas"]');
  await page.waitForSelector('#sale-search');
  check(await page.isVisible('#sale-cash-warning'), 'com o caixa fechado, a tela de vendas avisa');

  await page.click('button[data-tab="estoque"]');
  await page.waitForSelector('#entry-form');
  const pick = async () => page.$eval('#entry-product', (s, needle) => {
    const opt = [...s.options].find((o) => o.textContent.includes(needle));
    s.value = opt.value;
  }, String(stamp));
  await pick();
  await page.fill('#entry-qty', '12');
  await page.click('#entry-form button[type="submit"]');
  check(await page.$eval('#entry-expiry', (e) => !e.validity.valid), 'sem data de validade, o navegador barra a entrada');
  check(await page.isHidden('#entry-ok'), 'nada é registrado sem a validade');
  await page.fill('#entry-expiry', '2027-03-31');
  await page.click('#entry-form button[type="submit"]');
  await page.waitForSelector('#entry-ok:not([hidden])');
  const ok = norm(await page.textContent('#entry-ok'));
  check(ok === `Lote registrado: 12 UN de ${productName}, validade 31/03/2027.`, `entrada com validade (data sem erro de fuso): "${ok}"`);
  await page.screenshot({ path: shot('06-entrada-validade.png'), fullPage: true });
  await pick();
  await page.fill('#entry-qty', '3');
  await page.check('#entry-no-expiry');
  check(await page.isDisabled('#entry-expiry'), 'marcar "sem validade" desativa a data');
  await page.click('#entry-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('entry-ok')?.textContent.includes('sem validade'));
  check(true, 'entrada marcada como "sem validade" é registrada sem data');

  await page.click('button[data-tab="produtos"]');
  await page.fill('#product-search', String(stamp));
  await page.waitForFunction((n) => document.querySelector('#products-list')?.textContent.includes(n), productName);
  check(norm(await page.textContent('#products-list')).includes('31/03/2027'), 'lista de produtos mostra a validade mais próxima no dia certo (31/03/2027, sem um dia a menos)');

  // ---------- Funcionário (fechamento cego) ----------
  const cashierPage = await newPage(browser);
  await login(cashierPage, CASHIER);
  await cashierPage.waitForSelector('#cash-open-form', { timeout: 5000 });
  await cashierPage.fill('#cash-opening', '50');
  await cashierPage.click('#cash-open-form button[type="submit"]');
  await cashierPage.waitForSelector('#cash-open-form', { state: 'detached' });
  await cashierPage.click('button[data-tab="caixa"]');
  await cashierPage.waitForSelector('#cash-close-btn:not([hidden])');
  check(await cashierPage.isHidden('#cash-live'), 'funcionário não vê os valores do caixa aberto');
  check(await cashierPage.isHidden('#cash-history-section'), 'funcionário não vê o histórico');
  check(await cashierPage.isHidden('button[data-tab="estoque"]'), 'funcionário não vê a aba Estoque');
  await cashierPage.click('#cash-close-btn');
  await cashierPage.fill('#cash-counted', '50');
  cashierPage.once('dialog', (d) => d.accept());
  await cashierPage.click('#cash-close-form button[type="submit"]');
  await cashierPage.waitForSelector('#cash-summary-body');
  const blind = norm(await cashierPage.innerText('#cash-summary-body'));
  check(blind.startsWith('Contagem registrada: R$ 50,00') && !blind.includes('esperado') && !blind.includes('Diferença'),
    `fechamento cego para o funcionário: "${blind}"`);
  await cashierPage.screenshot({ path: shot('07-fechamento-cego.png') });

  await browser.close();
});
