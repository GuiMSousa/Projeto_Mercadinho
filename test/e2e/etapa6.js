// Teste de ponta a ponta da Etapa 6: controle de caixa completo — PDV bloqueado com o caixa
// fechado, abertura, venda, sangria, suprimento e fechamento com a quebra conferida.
const { ADMIN, CASHIER, shot, norm, check, launch, apiAs, newPage, login, skipCashOpen, allowHttpError, run } = require('./helpers');

const stamp = Date.now();
const productName = `E2E Caixa Café ${stamp}`;
const text = async (page, selector) => norm(await page.innerText(selector));
const chip = async (page) => `${await text(page, '#cash-chip')} ${await page.getAttribute('#cash-chip', 'class')}`;

run(async () => {
  const api = await apiAs(ADMIN);
  // Começa com o caixa fechado (outra etapa pode tê-lo deixado aberto).
  await api('/cash-sessions/current/close', { method: 'POST', body: { countedAmount: 0 } }).catch(() => {});
  await api('/products', { method: 'POST', body: { name: productName, unit: 'UN', costPrice: 4, salePrice: 12.5, initialStock: 40 } });

  const browser = await launch();
  const page = await newPage(browser);
  await login(page, ADMIN);
  await skipCashOpen(page);

  // ---------- PDV bloqueado com o caixa fechado ----------
  await page.click('button[data-tab="vendas"]');
  await page.waitForSelector('#sale-cash-warning:not([hidden])');
  check((await text(page, '#sale-cash-warning')).startsWith('Caixa fechado: abra o caixa para finalizar vendas.'), 'PDV com o caixa fechado mostra o aviso com "Abrir caixa"');
  check((await chip(page)).startsWith('Caixa fechado') && (await chip(page)).includes('closed'), 'indicador do topo em vermelho: "Caixa fechado"');
  await page.fill('#sale-search', String(stamp));
  await page.click('#sale-results div:not(.muted)');
  await page.click('.pay-btn[data-method="PIX"]');
  check(await page.isDisabled('#confirm-sale-btn') && (await text(page, '#sale-hint')) === 'Caixa fechado: abra o caixa para finalizar a venda.',
    'com produto e pagamento escolhidos, finalizar a venda continua bloqueado');
  await page.screenshot({ path: shot('41-pdv-bloqueado.png'), fullPage: true });

  // ---------- Abertura pelo aviso do PDV ----------
  await page.click('#sale-open-cash-btn');
  await page.fill('#cash-opening', '100');
  await page.click('#cash-open-form button[type="submit"]');
  await page.waitForSelector('#sale-cash-warning', { state: 'hidden' });
  check(!(await page.isDisabled('#confirm-sale-btn')) && (await page.locator('#cart-body tr').count()) === 1, 'aberto pelo aviso: o carrinho continua e a venda é liberada');
  check((await chip(page)).startsWith('Caixa aberto') && (await chip(page)).includes('open'), 'indicador do topo em verde: "Caixa aberto"');

  // ---------- Venda em dinheiro: 2 × R$ 12,50 ----------
  await page.fill('#cart-body tr input', '2');
  await page.click('.pay-btn[data-method="CASH"]');
  await page.click('#cash-received-quick button[data-cash="exact"]');
  await page.click('#confirm-sale-btn');
  await page.waitForSelector('#receipt');
  await page.click('#receipt-close-btn');
  check((await api('/cash-sessions/current')).totalsByPaymentMethod.CASH === 25, 'venda de R$ 25,00 em dinheiro registrada no caixa aberto');

  // ---------- Sangria e suprimento ----------
  await page.click('button[data-tab="caixa"]');
  await page.click('#cash-withdraw-btn');
  check((await page.getAttribute('#cash-move-form [data-type="WITHDRAWAL"]', 'aria-pressed')) === 'true', '"Sangria" abre o modal já com o tipo escolhido');
  await page.fill('#cash-move-amount', '30');
  await page.fill('#cash-move-reason', '   ');
  await page.click('#cash-move-form button[type="submit"]');
  check((await text(page, '#cash-move-msg')) === 'Informe o motivo.', 'sem motivo a sangria não é registrada');
  await page.fill('#cash-move-reason', 'Depósito no banco');
  await page.click('#cash-move-form button[type="submit"]');
  await page.waitForSelector('#cash-notice:not([hidden])');
  check((await text(page, '#cash-notice')) === 'Sangria de R$ 30,00 registrada.', 'confirmação da sangria');

  await page.click('#cash-deposit-btn');
  await page.fill('#cash-move-amount', '10');
  await page.fill('#cash-move-reason', 'Mais troco');
  await page.click('#cash-move-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('cash-notice')?.textContent.startsWith('Suprimento'));
  check((await text(page, '#cash-notice')) === 'Suprimento de R$ 10,00 registrado.', 'confirmação do suprimento');
  const live = await text(page, '#cash-live');
  check(live.includes('Dinheiro esperado na gaveta R$ 105,00') && live.includes('Suprimentos R$ 10,00') && live.includes('Sangrias R$ 30,00'),
    'esperado ao vivo: 100 + 25 + 10 − 30 = R$ 105,00');
  const moves = await text(page, '#cash-movements');
  check(moves.includes('Sangria − R$ 30,00 Depósito no banco') && moves.includes('Suprimento + R$ 10,00 Mais troco'), 'lista de sangrias e suprimentos com o motivo');
  await page.screenshot({ path: shot('42-caixa-movimentacoes.png'), fullPage: true });

  // ---------- Fechamento com conferência ----------
  await page.click('#cash-close-btn');
  await page.waitForSelector('#cash-close-summary:not([hidden])');
  const summary = await text(page, '#cash-close-summary');
  check(['Fundo de troco R$ 100,00', 'Vendas em dinheiro + R$ 25,00', 'Suprimentos + R$ 10,00', 'Sangrias − R$ 30,00', 'Dinheiro esperado R$ 105,00', 'Pix R$ 0,00']
    .every((line) => summary.includes(line)), 'o fechamento mostra o resumo detalhado');
  const diff = async (value) => { await page.fill('#cash-counted', value); return `${await text(page, '#cash-close-diff')} ${await page.getAttribute('#cash-close-diff', 'class')}`; };
  check((await diff('106')) === 'Sobra R$ 1,00 change-line warn', 'contado 106: "Sobra R$ 1,00"');
  check((await diff('105')) === 'Sem diferença change-line ok', 'contado 105: "Sem diferença"');
  check((await diff('103')) === 'Falta R$ 2,00 change-line bad', 'contado 103: "Falta R$ 2,00"');
  await page.screenshot({ path: shot('43-fechamento.png') });
  page.once('dialog', (d) => d.accept());
  await page.click('#cash-close-form button[type="submit"]');
  await page.waitForSelector('#cash-summary-body');
  const result = await text(page, '#cash-summary-body');
  check(result.includes('Dinheiro contado R$ 103,00') && result.includes('Falta R$ 2,00') && result.includes('Sangrias − R$ 30,00') && result.includes('Mais troco'),
    'resultado do fechamento: contado, quebra e as movimentações');
  await page.click('#cash-summary-ok');
  await page.waitForFunction(() => document.getElementById('cash-chip').textContent === 'Caixa fechado');
  check((await text(page, '#cash-history tr:first-child')).includes('Falta R$ 2,00'), 'o histórico registra a falta de R$ 2,00');

  // ---------- Caixa fechado em outro aparelho enquanto a venda era montada ----------
  await api('/cash-sessions', { method: 'POST', body: { openingAmount: 50 } });
  await page.click('button[data-tab="vendas"]');
  await page.waitForSelector('#sale-cash-warning', { state: 'hidden' });
  await page.fill('#sale-search', String(stamp));
  await page.click('#sale-results div:not(.muted)');
  await page.click('.pay-btn[data-method="PIX"]');
  await api('/cash-sessions/current/close', { method: 'POST', body: { countedAmount: 50 } });
  allowHttpError(409, '/api/sales');
  await page.click('#confirm-sale-btn');
  await page.waitForSelector('#sale-msg:not([hidden])');
  check((await text(page, '#sale-msg')) === 'Caixa fechado: abra o caixa antes de vender.', 'o servidor recusa a venda se o caixa foi fechado em outro aparelho');
  check(await page.isVisible('#sale-cash-warning') && await page.isDisabled('#confirm-sale-btn'), 'a tela passa a mostrar o aviso e bloqueia a venda');

  // ---------- Funcionário: sangria e suprimento às cegas ----------
  await api('/cash-sessions', { method: 'POST', body: { openingAmount: 20 } });
  const cashier = await newPage(browser);
  await login(cashier, CASHIER);
  await cashier.click('button[data-tab="caixa"]');
  await cashier.click('#cash-deposit-btn');
  await cashier.fill('#cash-move-amount', '5');
  await cashier.fill('#cash-move-reason', 'Troco extra');
  await cashier.click('#cash-move-form button[type="submit"]');
  await cashier.waitForSelector('#cash-notice:not([hidden])');
  check((await text(cashier, '#cash-notice')) === 'Suprimento de R$ 5,00 registrado.' && (await cashier.isHidden('#cash-live')) && (await cashier.isHidden('#cash-movements')),
    'o funcionário registra o suprimento sem ver os valores do caixa');
  check((await api('/cash-sessions/current')).depositsTotal === 5, 'o suprimento do funcionário entra no caixa');
  await api('/cash-sessions/current/close', { method: 'POST', body: { countedAmount: 25 } });

  await browser.close();
});
