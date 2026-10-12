// Teste de ponta a ponta da Etapa 4 (PWA): manifest, ícones, meta tags do iPhone, critério de
// instalação do Edge e service worker (cache só de arquivos estáticos, nunca da API).
const { base, ADMIN, check, launch, newPage, login, skipCashOpen, run } = require('./helpers');

const pngSize = (buf) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;

run(async () => {
  // ---------- Manifest e ícones ----------
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  check(manifest.name === 'Contro Vend' && manifest.short_name === 'ControVend' && manifest.display === 'standalone',
    'manifest: nome "Contro Vend", nome curto "ControVend" e janela própria (standalone)');
  for (const size of ['192x192', '512x512']) {
    const res = await fetch(`${base}${manifest.icons.find((i) => i.sizes === size).src}`);
    const real = pngSize(Buffer.from(await res.arrayBuffer()));
    check(res.ok && res.headers.get('content-type') === 'image/png' && real === size, `ícone ${size} é um PNG desse tamanho (${real})`);
  }

  const browser = await launch();
  const page = await newPage(browser);
  await login(page, ADMIN);
  await skipCashOpen(page);

  // ---------- iPhone: meta tags e margens da barra de status ----------
  const head = await page.evaluate(() => {
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name);
    return [
      attr('link[rel="manifest"]', 'href'),
      attr('meta[name="apple-mobile-web-app-capable"]', 'content'),
      attr('meta[name="apple-mobile-web-app-status-bar-style"]', 'content'),
      attr('meta[name="apple-mobile-web-app-title"]', 'content'),
      attr('link[rel="apple-touch-icon"]', 'href'),
    ].join(' | ');
  });
  check(head === '/manifest.json | yes | black-translucent | Contro Vend | /img/icon-192.png', `app.html traz o manifest e as meta tags do iPhone (${head})`);
  const pc = await page.evaluate(() => ({
    body: getComputedStyle(document.body).paddingTop,
    strip: getComputedStyle(document.body, '::before').height,
    topbar: getComputedStyle(document.querySelector('.topbar')).top,
  }));
  check(pc.body === '0px' && pc.strip === '0px' && pc.topbar === '0px', 'no PC as margens da barra de status do iPhone valem 0 (layout de desktop igual)');

  // ---------- Instalável no Edge/Chrome ----------
  const cdp = await page.context().newCDPSession(page);
  const { errors } = await cdp.send('Page.getAppManifest');
  check(errors.length === 0, 'o navegador lê o manifest sem erros');
  // "in-incognito": o Playwright abre perfis temporários, onde o navegador nunca oferece instalar.
  const blockers = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito');
  check(blockers.length === 0, `o app atende ao critério de instalação do Edge (${blockers.join(', ') || 'nenhum impedimento'})`);

  // ---------- Service worker ----------
  await page.evaluate(() => navigator.serviceWorker.ready);
  const seen = [];
  page.on('response', (r) => seen.push({ path: new URL(r.url()).pathname, sw: r.fromServiceWorker() }));
  await page.reload();
  await skipCashOpen(page);
  await page.waitForSelector('.semaforo-card');
  check(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'o service worker controla a página depois de recarregar');
  check(seen.some((r) => r.path === '/css/style.css' && r.sw) && seen.some((r) => r.path === '/js/app.js' && r.sw), 'CSS e JS do app passam pelo service worker');
  const api = seen.filter((r) => r.path.startsWith('/api/'));
  check(api.length > 0 && api.every((r) => !r.sw), `a API nunca passa pelo service worker (${api.length} respostas direto do servidor)`);

  await page.evaluate(() => fetch('/img/icon-192.png'));
  const cached = await page.evaluate(async () => (await (await caches.open('contro-vend-v1')).keys()).map((r) => { const u = new URL(r.url); return u.pathname + u.search; }));
  check(['/app.html', '/css/style.css', '/js/app.js', '/img/icon-192.png'].every((p) => cached.includes(p)), 'página, CSS, JS e ícone ficam guardados no cache');
  check(!cached.some((p) => p.startsWith('/api/') || p.includes('?')), `nada da API nem URL com parâmetros vai para o cache (${cached.length} arquivos)`);

  await browser.close();
});
