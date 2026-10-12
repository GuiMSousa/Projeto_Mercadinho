// Teste de ponta a ponta da Etapa 7: painel financeiro (Relatórios) — atalhos de período,
// datas livres, cards de indicadores, formas de pagamento e produtos mais lucrativos.
const { ADMIN, shot, norm, check, launch, apiAs, newPage, login, skipCashOpen, run } = require('./helpers');

const stamp = Date.now();
const names = { kept: `E2E Painel Café ${stamp}`, noCost: `E2E Painel Bolo ${stamp}` };
const brl = (n) => norm(n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (n) => (n === null ? '—' : `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const level = (m) => (m === null ? null : m > 20 ? 'kpi-good' : m >= 10 ? 'kpi-warn' : 'kpi-bad');

run(async () => {
  const api = await apiAs(ADMIN);
  await api('/cash-sessions', { method: 'POST', body: { openingAmount: 0 } }).catch(() => {}); // vender exige caixa aberto
  const kept = await api('/products', { method: 'POST', body: { name: names.kept, unit: 'UN', costPrice: 6, salePrice: 10, initialStock: 20 } });
  const noCost = await api('/products', { method: 'POST', body: { name: names.noCost, unit: 'UN', costPrice: 0, salePrice: 8, initialStock: 20 } });
  await api('/sales', { method: 'POST', body: { items: [{ productId: kept.id, quantity: 2 }], paymentMethod: 'PIX' } });
  await api('/sales', { method: 'POST', body: { items: [{ productId: noCost.id, quantity: 1 }], paymentMethod: 'CREDIT_CARD' } });

  const browser = await launch();
  const page = await newPage(browser);
  await login(page, ADMIN);
  await skipCashOpen(page);
  const days = await page.evaluate(() => {
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const t = new Date();
    return { today: iso(t), monthStart: iso(new Date(t.getFullYear(), t.getMonth(), 1)), weekStart: iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6)) };
  });

  const cards = async () => ({
    revenue: norm(await page.innerText('#kpi-revenue')),
    profit: norm(await page.innerText('#kpi-profit')),
    margin: norm(await page.innerText('#kpi-margin')),
    ticket: norm(await page.innerText('#kpi-ticket')),
    count: norm(await page.innerText('#kpi-ticket-sub')),
  });
  const expectedCards = (r) => ({
    revenue: brl(r.grossRevenue), profit: brl(r.profit), margin: pct(r.profitMargin),
    ticket: r.averageTicket === null ? '—' : brl(r.averageTicket), count: `${r.salesCount} venda(s)`,
  });
  const range = async () => [await page.inputValue('#rep-start'), await page.inputValue('#rep-end')];
  const pressed = () => page.$$eval('.period-chips [aria-pressed="true"]', (els) => els.map((e) => e.dataset.range));

  // ---------- Abertura: este mês ----------
  await page.click('button[data-tab="relatorios"]');
  await page.waitForFunction(() => document.getElementById('kpi-revenue')?.textContent !== '—');
  check(JSON.stringify(await range()) === JSON.stringify([days.monthStart, days.today]) && (await pressed()).join() === 'month', 'o painel abre em "Este mês" (do dia 1º até hoje)');
  const month = await api(`/reports/financial?startDate=${days.monthStart}&endDate=${days.today}`);
  check(JSON.stringify(await cards()) === JSON.stringify(expectedCards(month)), `cards batem com o cálculo da API (${JSON.stringify(await cards())})`);
  const marginClass = await page.getAttribute('#kpi-margin-card', 'class');
  check(marginClass.includes(level(month.profitMargin)), `cor da margem pela faixa (${pct(month.profitMargin)} → ${level(month.profitMargin)})`);

  const bars = norm(await page.innerText('#rep-methods'));
  check(month.byPaymentMethod.every((m) => bars.includes(`${brl(m.total)} · ${pct(m.percentage)}`)), 'cada forma de pagamento com total e percentual');
  const widths = await page.$$eval('#rep-methods .bar > span', (els) => els.map((e) => parseFloat(e.style.width)));
  check(widths.every((w, i) => Math.abs(w - (month.byPaymentMethod[i].percentage ?? 0)) < 0.01), 'as barras têm o comprimento do percentual');

  const row = (name) => page.locator('#rep-top-products tr', { hasText: name });
  const keptRow = norm(await row(names.kept).innerText());
  check(keptRow === `${names.kept} 2 UN R$ 20,00 R$ 12,00 R$ 8,00 40,00%`, `produto com custo: quantidade, faturamento, custo, lucro e margem (${keptRow})`);
  check((await row(names.kept).locator('td').last().locator('span').getAttribute('class')) === 'margin-good', 'margem do produto em verde (40%)');
  check(norm(await row(names.noCost).innerText()) === `${names.noCost}custo não informado 1 UN R$ 8,00 R$ 0,00 R$ 8,00 100,00%`, 'produto sem custo: custo R$ 0,00, margem 100% e o aviso "custo não informado"');
  check(await page.isVisible('#rep-cost-warning') && norm(await page.innerText('#rep-cost-warning')).includes(`${month.productsWithoutCost} produto(s) vendido(s) sem preço de custo`), 'aviso geral de produtos sem custo');
  await page.screenshot({ path: shot('51-painel-mes.png'), fullPage: true });

  // ---------- Hoje ----------
  const todayRequest = page.waitForRequest((r) => r.url().includes('/api/reports/financial?'));
  await page.click('.period-chips [data-range="today"]');
  const url = new URL((await todayRequest).url());
  check(url.searchParams.get('startDate') === days.today && url.searchParams.get('endDate') === days.today, '"Hoje" pede o período de hoje a hoje');
  const today = await api(`/reports/financial?startDate=${days.today}&endDate=${days.today}`);
  await page.waitForFunction((t) => document.getElementById('kpi-revenue').textContent.replace(/\s/g, ' ') === t, brl(today.grossRevenue).replace(/\s/g, ' '));
  check(JSON.stringify(await cards()) === JSON.stringify(expectedCards(today)) && (await pressed()).join() === 'today', 'cards de hoje e o atalho "Hoje" marcado');

  // ---------- Datas livres: período sem vendas ----------
  await page.fill('#rep-start', '2019-01-01');
  await page.fill('#rep-end', '2019-01-31');
  await page.click('#rep-period button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('kpi-margin').textContent === '—');
  check(JSON.stringify(await cards()) === JSON.stringify({ revenue: 'R$ 0,00', profit: 'R$ 0,00', margin: '—', ticket: '—', count: '0 venda(s)' }),
    'período sem vendas: R$ 0,00, margem e ticket "—" (sem divisão por zero)');
  check((await pressed()).length === 0 && norm(await page.innerText('#rep-top-products')) === 'Sem vendas no período.' && await page.isHidden('#rep-cost-warning'),
    'datas livres desmarcam os atalhos; tabela vazia e sem aviso de custo');
  check(!(await page.getAttribute('#kpi-margin-card', 'class')).match(/kpi-(good|warn|bad)/), 'sem vendas a margem fica sem cor');

  await page.fill('#rep-start', '2019-02-01');
  await page.click('#rep-period button[type="submit"]');
  check(norm(await page.innerText('#rep-msg')) === 'Escolha o período: a data inicial não pode ser depois da final.', 'data inicial depois da final é recusada na tela');

  // ---------- Últimos 7 dias ----------
  await page.click('.period-chips [data-range="7"]');
  check(JSON.stringify(await range()) === JSON.stringify([days.weekStart, days.today]) && await page.isHidden('#rep-msg'), '"Últimos 7 dias" vai de 6 dias atrás até hoje');
  await page.waitForFunction(() => document.getElementById('kpi-margin').textContent !== '—');

  // ---------- Celular ----------
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    columns: new Set([...document.querySelectorAll('.kpi-grid > .card')].map((c) => Math.round(c.getBoundingClientRect().left))).size,
  }));
  check(!phone.overflow && phone.columns <= 2, `no celular o painel cabe na tela (${phone.columns} coluna(s) de cards, sem rolagem lateral)`);
  await page.screenshot({ path: shot('52-painel-celular.png'), fullPage: true });

  await browser.close();
});
