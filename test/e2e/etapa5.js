// Teste de ponta a ponta da Etapa 5: recibo da venda (tela, impressão em bobina 58/80 mm)
// e o resumo enviado pelo WhatsApp.
const { ADMIN, shot, check, launch, apiAs, newPage, login, skipCashOpen, run } = require('./helpers');

const stamp = Date.now();
const names = { rice: `E2E Recibo Arroz ${stamp}`, cheese: `E2E Recibo Queijo ${stamp}` };
const MM = 96 / 25.4; // px por milímetro no CSS
const plain = (s) => s.replace(/ /g, ' '); // o Intl separa "R$" do valor com espaço inquebrável

// Conta quantas vezes o botão abriu o diálogo de impressão (o diálogo de verdade travaria o teste).
const stubPrint = () => { window.__prints = 0; window.print = () => { window.__prints += 1; }; };

run(async () => {
  const api = await apiAs(ADMIN);
  await api('/products', { method: 'POST', body: { name: names.rice, unit: 'UN', costPrice: 5, salePrice: 7.5, initialStock: 50 } });
  await api('/products', { method: 'POST', body: { name: names.cheese, unit: 'KG', costPrice: 20, salePrice: 39.9, initialStock: 10 } });
  const { storeName } = await api('/settings');

  const browser = await launch();
  const page = await newPage(browser, { initScript: stubPrint });
  await login(page, ADMIN);
  await skipCashOpen(page);

  // ---------- Venda: 2 un de arroz + 0,25 kg de queijo, em dinheiro ----------
  await page.click('button[data-tab="vendas"]');
  for (const name of [names.rice, names.cheese]) {
    await page.fill('#sale-search', name);
    await page.click(`#sale-results div:has-text("${name}")`);
  }
  await page.fill('#cart-body tr:nth-child(1) input', '2');
  await page.fill('#cart-body tr:nth-child(2) input', '0.25');
  await page.click('.pay-btn[data-method="CASH"]');
  await page.fill('#cash-received', '50');
  await page.click('#confirm-sale-btn');
  await page.waitForSelector('#receipt');

  // ---------- Recibo na tela ----------
  const receipt = await page.evaluate(() => ({
    store: document.getElementById('receipt-store').innerText,
    when: document.getElementById('receipt-meta').innerText,
    items: [...document.querySelectorAll('#receipt-items li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
    subtotal: document.getElementById('receipt-subtotal').innerText,
    discount: document.getElementById('receipt-discount').innerText,
    total: document.getElementById('receipt-total').innerText,
    payment: document.getElementById('receipt-payment').innerText,
  }));
  check(receipt.store === storeName, `recibo com o nome do estabelecimento ("${receipt.store}")`);
  check(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/.test(receipt.when), `data e hora da venda (${receipt.when})`);
  check(plain(receipt.items.join(' | ')) === `${names.rice} 2 UN × R$ 7,50 R$ 15,00 | ${names.cheese} 0,25 KG × R$ 39,90 R$ 9,98`,
    `itens com quantidade, preço e subtotal (${plain(receipt.items.join(' | '))})`);
  check(plain(`${receipt.subtotal} | ${receipt.discount} | ${receipt.total}`) === 'R$ 24,98 | R$ 0,00 | R$ 24,98', 'subtotal, descontos e total fecham a conta (R$ 24,98)');
  check(plain(receipt.payment) === 'Pagamento: Dinheiro · Recebido R$ 50,00 · Troco R$ 25,02', `forma de pagamento com recebido e troco (${plain(receipt.payment)})`);
  await page.screenshot({ path: shot('31-recibo-tela.png') });

  // ---------- WhatsApp ----------
  const link = page.locator('#receipt-wa-link');
  const href = await link.getAttribute('href');
  const text = plain(decodeURIComponent(href.slice('https://wa.me/?text='.length)));
  const expected = [
    `*${storeName}*`,
    receipt.when,
    '',
    names.rice,
    '  2 UN × R$ 7,50 = R$ 15,00',
    names.cheese,
    '  0,25 KG × R$ 39,90 = R$ 9,98',
    '',
    'Subtotal: R$ 24,98',
    'Descontos: R$ 0,00',
    '*Total: R$ 24,98*',
    'Pagamento: Dinheiro · Recebido R$ 50,00 · Troco R$ 25,02',
    '',
    'Obrigado pela preferência!',
  ].join('\n');
  check(href.startsWith('https://wa.me/?text=') && text === expected, 'mensagem do WhatsApp com itens, subtotal, descontos, total e pagamento');
  if (text !== expected) console.log(`  recebido:\n${text}`);
  check((await link.getAttribute('target')) === '_blank' && (await link.getAttribute('rel')) === 'noopener', 'o WhatsApp abre em outra aba, sem acesso à página de origem');

  // ---------- Impressão ----------
  await page.click('#receipt-print-btn');
  check((await page.evaluate(() => window.__prints)) === 1, '"Imprimir recibo" abre o diálogo de impressão');
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => {
    const r = document.getElementById('receipt');
    const style = getComputedStyle(r);
    const shown = (sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length > 0);
    return {
      width: r.getBoundingClientRect().width,
      border: style.borderTopStyle,
      font: style.fontSize,
      color: style.color,
      others: shown('.topbar, #content, .receipt-actions, .receipt-card > h3'),
    };
  });
  check(!printed.others, 'na impressão sai só o recibo (sem menu, tela de vendas nem botões)');
  check(printed.width <= 80 * MM + 1 && printed.border === 'none' && printed.font === '12px' && printed.color === 'rgb(0, 0, 0)',
    `na impressão o recibo tem até 80 mm, sem borda, fonte 12px preta (${(printed.width / MM).toFixed(1)} mm)`);
  await page.setViewportSize({ width: Math.round(80 * MM), height: 900 });
  await page.locator('#receipt').screenshot({ path: shot('32-recibo-80mm.png') });
  await page.setViewportSize({ width: Math.round(48 * MM), height: 900 }); // área útil da bobina de 58 mm
  const narrow = await page.evaluate(() => {
    const r = document.getElementById('receipt');
    return { fits: r.scrollWidth <= r.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1, width: r.getBoundingClientRect().width };
  });
  check(narrow.fits, `na bobina de 58 mm (48 mm úteis) nada fica cortado (${(narrow.width / MM).toFixed(1)} mm)`);
  await page.locator('#receipt').screenshot({ path: shot('33-recibo-58mm.png') });
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---------- Próxima venda ----------
  await page.click('#receipt-close-btn');
  await page.waitForSelector('#receipt', { state: 'detached' });
  check((await page.locator('#cart-body tr').count()) === 0, '"Nova venda" fecha o recibo com o carrinho vazio');

  await browser.close();
});
