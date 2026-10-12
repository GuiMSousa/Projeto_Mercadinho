// Teste de ponta a ponta da Etapa 3: leitor de código de barras pela câmera (PDV e
// Entrada de Estoque) e o menu do topo numa linha só em 1280px. A câmera é a falsa
// do Chromium, tocando um vídeo .y4m gerado aqui com códigos EAN-13 de verdade.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ADMIN, CASHIER, shot, norm, check, launch, apiAs, newPage, login, skipCashOpen, run } = require('./helpers');

const stamp = Date.now();

// EAN-13 com dígito verificador: 789 (Brasil) + 9 dígitos do carimbo de tempo.
function ean13(n) {
  const body = `789${String(n).slice(-9).padStart(9, '0')}`;
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

// Barras: 101 + 6 dígitos em L/G (conforme o 1º dígito) + 01010 + 6 dígitos em R + 101.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const G = R.map((p) => [...p].reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function ean13Bars(code) {
  const d = [...code].map(Number);
  const left = d.slice(1, 7).map((n, i) => (PARITY[d[0]][i] === 'L' ? L : G)[n]).join('');
  return `101${left}01010${d.slice(7).map((n) => R[n]).join('')}101`;
}

// Vídeo YUV4MPEG2 em tons de cinza: cada item da sequência fica 1 s na tela (null = sem código).
function writeFakeCamera(file, sequence) {
  const W = 480;
  const H = 270;
  const FPS = 5;
  const MODULE = 3; // px por barra fina
  const frame = (code) => {
    const luma = Buffer.alloc(W * H, 255);
    if (code) {
      const bars = ean13Bars(code);
      const x0 = Math.floor((W - bars.length * MODULE) / 2);
      for (let y = 45; y < H - 45; y += 1) {
        for (let m = 0; m < bars.length; m += 1) {
          if (bars[m] === '1') luma.fill(0, y * W + x0 + m * MODULE, y * W + x0 + (m + 1) * MODULE);
        }
      }
    }
    return Buffer.concat([Buffer.from('FRAME\n'), luma, Buffer.alloc(W * H / 2, 128)]);
  };
  const frames = sequence.flatMap((code) => Array(FPS).fill(frame(code)));
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`), ...frames]));
}

const codes = { a: ean13(stamp), b: ean13(stamp + 1), unknown: ean13(stamp + 2) };
const names = { a: `E2E Leitor Café ${stamp}`, b: `E2E Leitor Feijão ${stamp}`, plain: `E2E Leitor Arroz ${stamp}` };

// Registra na página os bipes, os fluxos de câmera e as mensagens/molduras do leitor.
const instrument = () => {
  window.__beeps = [];
  window.__streams = [];
  window.__statuses = [];
  window.__flashes = new Set();
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...args) { window.__beeps.push(this.frequency.value); return start.apply(this, args); };
  const getUserMedia = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (...args) { const s = await getUserMedia.apply(this, args); window.__streams.push(s); return s; };
  new MutationObserver(() => {
    const status = document.getElementById('scanner-status');
    if (status && window.__statuses.at(-1) !== status.textContent) window.__statuses.push(status.textContent);
    const view = document.querySelector('.scanner-view.hit, .scanner-view.miss');
    if (view) window.__flashes.add(view.classList.contains('hit') ? 'hit' : 'miss');
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
};
// Simula o acesso por http://IP-da-rede: sem contexto seguro o navegador não oferece a câmera.
const insecure = () => {
  Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined });
  Object.defineProperty(window, 'isSecureContext', { get: () => false });
};

const cameraOff = (page) => page.evaluate(() => window.__streams.at(-1).getTracks().every((t) => t.readyState === 'ended'));
const height = (page, selector) => page.$eval(selector, (e) => Math.round(e.getBoundingClientRect().height));

run(async () => {
  const api = await apiAs(ADMIN);
  const make = (name, body) => api('/products', { method: 'POST', body: { name, unit: 'UN', costPrice: 1, salePrice: 3, initialStock: 20, expiryDate: '2028-01-31', ...body } });
  const products = { a: await make(names.a, { barcode: codes.a }), b: await make(names.b, { barcode: codes.b, salePrice: 4.5 }), plain: await make(names.plain) };

  const video = path.join(os.tmpdir(), `contro-vend-camera-${stamp}.y4m`);
  writeFakeCamera(video, [codes.a, null, codes.b, null, codes.unknown, null]);
  const browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`]);
  const page = await newPage(browser, { permissions: ['camera'], initScript: instrument });
  await login(page, ADMIN);
  await skipCashOpen(page);

  // ---------- Menu do topo em 1280px ----------
  const layout = await page.evaluate(() => {
    const visible = (e) => e && e.getClientRects().length > 0;
    const tabs = [...document.querySelectorAll('.tab-btn')].filter(visible);
    const middles = ['.brand', '#tabs', '#cash-chip', '.user-box'].map((s) => document.querySelector(s)).filter(visible)
      .map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
    return {
      tabs: tabs.length,
      rows: new Set(tabs.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      spread: Math.round(Math.max(...middles) - Math.min(...middles)),
      height: document.querySelector('.topbar').offsetHeight,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  check(layout.tabs === 9 && layout.rows === 1, `admin em 1280px: as ${layout.tabs} abas numa linha só (${layout.rows} linha(s))`);
  check(layout.spread <= 4 && !layout.overflow, `marca, abas, indicador do caixa e usuário na mesma linha, sem rolagem lateral (topo com ${layout.height}px)`);
  await page.screenshot({ path: shot('21-menu-1280.png'), clip: { x: 0, y: 0, width: 1280, height: layout.height } });

  // ---------- PDV: leitura contínua ----------
  await page.click('button[data-tab="vendas"]');
  await page.waitForSelector('#sale-scan-btn');
  check((await height(page, '#sale-scan-btn')) >= 60, `botão da câmera no PDV com ≥ 60px (${await height(page, '#sale-scan-btn')}px)`);
  await page.fill('#sale-search', codes.a); // pistola USB: digita o código
  await page.waitForSelector('#sale-results div:not(.muted)');
  check(norm(await page.innerText('#sale-results')).startsWith(names.a), 'digitar o código de barras na busca acha o produto');
  await page.fill('#sale-search', '');

  const zxing = page.waitForResponse((r) => r.url().endsWith('/vendor/zxing/index.min.js'), { timeout: 10000 }).catch(() => null);
  await page.click('#sale-scan-btn');
  await page.waitForSelector('#scanner-video');
  const hasNative = await page.evaluate(() => 'BarcodeDetector' in window);
  const zxingResponse = await zxing;
  check(hasNative || zxingResponse?.status() === 200, hasNative ? 'leitor: BarcodeDetector nativo' : 'sem BarcodeDetector, o fallback zxing é servido pelo próprio app (/vendor/zxing)');

  await page.waitForFunction((list) => list.every((n) => document.getElementById('cart-body').textContent.includes(n)), [names.a, names.b], { timeout: 20000 });
  const cartRows = await page.$$eval('#cart-body tr', (rows) => rows.map((r) => `${r.cells[0].textContent}=${r.querySelector('input').value}`));
  check(cartRows.length === 2 && cartRows.every((r) => r.endsWith('=1')), `os dois códigos lidos entraram no carrinho, uma unidade cada (${cartRows.join('; ')})`);
  check(await page.isVisible('#scanner-video'), 'a câmera segue aberta, pronta para o próximo código');
  await page.waitForFunction(() => window.__statuses.some((s) => s.includes('não cadastrado')), null, { timeout: 15000 });
  const statuses = await page.evaluate(() => window.__statuses);
  check(statuses.includes(`✔ ${names.a} — 1 no carrinho. Pode passar o próximo.`), 'aviso de acerto com o nome do produto e a quantidade no carrinho');
  check(statuses.includes(`Código ${codes.unknown} não cadastrado.`), 'código não cadastrado é avisado e o leitor continua lendo');
  const beeps = await page.evaluate(() => window.__beeps);
  check(beeps.includes(1800) && beeps.includes(220), `bipe agudo no acerto e grave no erro (${[...new Set(beeps)].join(' e ')} Hz)`);
  const flashes = await page.evaluate(() => [...window.__flashes]);
  check(flashes.includes('hit') && flashes.includes('miss'), 'a moldura do vídeo pisca verde no acerto e vermelha no erro');
  await page.screenshot({ path: shot('22-pdv-camera.png') });

  await page.click('#scanner-close');
  await page.waitForSelector('#scanner-video', { state: 'detached' });
  check(await cameraOff(page), '"Fechar câmera" desliga a câmera');
  await page.click('#sale-scan-btn');
  await page.waitForFunction(() => window.__streams.length === 2 && window.__streams[1].active);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#scanner-video', { state: 'detached' });
  check(await cameraOff(page), 'fechar com Esc também desliga a câmera');

  // ---------- Entrada de Estoque: a leitura escolhe o produto ----------
  await page.click('button[data-tab="estoque"]');
  await page.waitForSelector('#entry-scan-btn');
  check((await height(page, '#entry-scan-btn')) >= 60, 'botão da câmera na entrada com ≥ 60px');
  await page.selectOption('#entry-product', products.plain.id);
  await page.click('#entry-scan-btn');
  await page.waitForSelector('#scanner-video');
  await page.waitForSelector('#scanner-video', { state: 'detached', timeout: 20000 });
  const picked = await page.inputValue('#entry-product');
  const pickedName = picked === products.a.id ? names.a : picked === products.b.id ? names.b : null;
  check(Boolean(pickedName), `a leitura seleciona o produto no formulário e fecha a câmera (${pickedName || picked})`);
  check((await page.evaluate(() => document.activeElement.id)) === 'entry-qty', 'o cursor vai direto para a quantidade');
  check(await cameraOff(page), 'a câmera é desligada depois da leitura');
  await page.fill('#entry-qty', '6');
  await page.fill('#entry-expiry', '2027-05-31');
  await page.click('#entry-form button[type="submit"]');
  await page.waitForSelector('#entry-ok:not([hidden])');
  check(norm(await page.textContent('#entry-ok')) === `Lote registrado: 6 UN de ${pickedName}, validade 31/05/2027.`, 'a entrada do produto lido é registrada');
  await page.screenshot({ path: shot('23-entrada-camera.png'), fullPage: true });

  // ---------- Sem câmera (acesso por http://IP) ----------
  const cashierPage = await newPage(browser, { initScript: insecure });
  await login(cashierPage, CASHIER);
  await skipCashOpen(cashierPage);
  await cashierPage.click('button[data-tab="vendas"]');
  await cashierPage.click('#sale-scan-btn');
  await cashierPage.waitForSelector('#scanner-status.bad');
  const why = norm(await cashierPage.innerText('#scanner-status'));
  check(why.startsWith('A câmera só funciona com o sistema aberto em https://'), `sem contexto seguro, o leitor explica o motivo: "${why}"`);
  await cashierPage.screenshot({ path: shot('24-sem-camera.png') });

  await browser.close();
  fs.rmSync(video, { force: true });
});
