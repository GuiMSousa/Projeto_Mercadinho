let currentUser = null;
let currentTab = 'dashboard';
let cart = []; // { productId, name, unit, price, quantity }
let saleInFlight = false;
let payMethod = null; // forma de pagamento escolhida para a venda em andamento
let cashSession = null; // caixa aberto agora, ou null
let storeName = ''; // nome do estabelecimento no recibo (GET /api/settings)
let productsPage = 1;
let productUrgencyFilter = null; // RED | YELLOW | GREEN, ou null para todos
let movementsPage = 1;
let cashHistoryPage = 1;
const LIST_PAGE_SIZE = 20;

const PAYMENT_LABELS = { CASH: 'Dinheiro', PIX: 'Pix', DEBIT_CARD: 'Cartão de débito', CREDIT_CARD: 'Cartão de crédito' };

// Semáforo (regras no servidor): vermelho = agir agora, amarelo = planejar, verde = em ordem.
const URGENCY_INFO = {
  RED: { emoji: '🔴', label: 'Vermelho', css: 'red', hint: 'Sem estoque, vencido ou vencendo em até 7 dias' },
  YELLOW: { emoji: '🟡', label: 'Amarelo', css: 'yellow', hint: 'Estoque no mínimo ou vencendo em 8 a 30 dias' },
  GREEN: { emoji: '🟢', label: 'Verde', css: 'green', hint: 'Estoque e validade em ordem' },
};

const content = document.getElementById('content');

// Muda a cada troca de tela. Quem espera a API confere se a tela ainda é a mesma antes de
// escrever nela: com rede lenta (celular pelo túnel) a resposta chega depois da troca de aba.
let viewSeq = 0;

function activeTemplate(name) {
  viewSeq += 1;
  const tpl = document.getElementById(`tpl-${name}`);
  content.innerHTML = '';
  content.appendChild(tpl.content.cloneNode(true));
}

// Abre um <template> como um modal sobreposto (fundo escurecido + card
// centralizado), em vez de anexado ao final do conteúdo da aba. Sem isso, o
// formulário de editar produto/usuário aparecia depois de toda a lista —
// numa tela com muitos produtos, era preciso rolar a página inteira até o
// fim para achar o formulário que acabou de abrir.
function openModal(templateId) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const tpl = document.getElementById(templateId);
  backdrop.appendChild(tpl.content.cloneNode(true));
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';

  const onKeydown = (e) => {
    if (e.key === 'Escape') closeModal(backdrop);
  };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal(backdrop);
  });
  document.addEventListener('keydown', onKeydown);
  backdrop._onKeydown = onKeydown;

  return backdrop;
}

function closeModal(backdrop) {
  if (!backdrop) return;
  if (backdrop._onClose) backdrop._onClose(); // ex.: desligar a câmera do leitor
  if (backdrop._onKeydown) document.removeEventListener('keydown', backdrop._onKeydown);
  backdrop.remove();
  document.body.style.overflow = '';
}

function switchTab(name, options) {
  currentTab = name;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  // No celular as abas rolam para o lado: traz à vista a aba aberta por outro caminho (ex.: cartão do painel).
  document.querySelector('.tab-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const renderers = {
    dashboard: renderDashboard,
    vendas: renderVendas,
    caixa: renderCaixa,
    produtos: renderProdutos,
    compras: renderCompras,
    estoque: renderEstoque,
    importar: renderImportar,
    relatorios: renderRelatorios,
    usuarios: renderUsuarios,
  };
  (renderers[name] || renderDashboard)(options);
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api.post('/auth/logout');
  location.href = '/index.html';
});

// ---------- Boot ----------
(async () => {
  try {
    currentUser = await api.get('/auth/me');
  } catch {
    location.href = '/index.html';
    return;
  }
  const userName = document.getElementById('user-name');
  userName.textContent = `${currentUser.name} (${currentUser.role === 'ADMIN' ? 'admin' : 'caixa'})`;
  userName.title = userName.textContent;
  document.getElementById('user-avatar').textContent = currentUser.name.trim().charAt(0).toUpperCase();
  document.body.classList.toggle('role-admin', currentUser.role === 'ADMIN');
  api.get('/settings').then((s) => { storeName = s.storeName; }).catch(() => {}); // só o recibo usa

  let cashKnown = false;
  try {
    await refreshCashStatus();
    cashKnown = true;
  } catch {
    // Sem o status do caixa o resto da tela segue funcionando.
  }
  switchTab('dashboard');
  // O dia começa abrindo o caixa: venda sem caixa aberto fica fora da conciliação.
  if (cashKnown && !cashSession) openCashOpenModal();
})();

// ---------- Dashboard ----------
async function renderDashboard() {
  activeTemplate('dashboard');
  document.getElementById('dash-shopping-btn').addEventListener('click', () => switchTab('compras'));
  const seq = viewSeq;
  const [data, counts] = await Promise.all([api.get('/dashboard'), urgencyCounts()]);
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia

  // Contagem de cada cor do semáforo; tocar num cartão abre os produtos filtrados.
  const summary = document.getElementById('semaforo-summary');
  Object.entries(URGENCY_INFO).forEach(([level, info]) => {
    summary.appendChild(el('button', {
      type: 'button',
      class: `semaforo-card ${info.css}`,
      'aria-label': `${info.label}: ${counts[level]} produto(s). ${info.hint}. Ver produtos.`,
      onclick: () => switchTab('produtos', { urgency: level }),
    }, [
      el('span', { class: 'semaforo-count' }, `${info.emoji} ${counts[level]}`),
      el('span', { class: 'semaforo-label' }, info.label),
      el('span', { class: 'semaforo-hint' }, info.hint),
    ]));
  });

  const tbLow = document.getElementById('tb-low-stock');
  data.lowStock.forEach((p) => {
    tbLow.appendChild(el('tr', {}, [
      el('td', {}, p.name),
      el('td', {}, `${p.currentStock} ${p.unit}`),
      el('td', {}, String(p.minStock)),
    ]));
  });
  if (data.lowStock.length === 0) tbLow.appendChild(el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'Nenhum produto abaixo do mínimo.')));

  const tbSoon = document.getElementById('tb-soon-out');
  data.soonOut.forEach((p) => {
    tbSoon.appendChild(el('tr', {}, [
      el('td', {}, p.name),
      el('td', {}, `${p.currentStock} ${p.unit}`),
      el('td', {}, `${p.daysUntilStockout} dia(s)`),
    ]));
  });
  if (data.soonOut.length === 0) tbSoon.appendChild(el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'Nenhuma previsão de falta em 7 dias.')));

  const tbExp = document.getElementById('tb-expiring');
  data.expiring.forEach((p) => {
    tbExp.appendChild(el('tr', {}, [
      el('td', {}, p.name),
      el('td', {}, formatDate(p.expiryDate)),
      el('td', {}, String(p.currentStock)),
    ]));
  });
  if (data.expiring.length === 0) tbExp.appendChild(el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'Nenhum produto vencendo em breve.')));

  if (currentUser.role === 'ADMIN') {
    document.getElementById('admin-summary').hidden = false;
    document.getElementById('stat-today').textContent = `${formatMoney(data.today.total)} (${data.today.count})`;
    document.getElementById('stat-month').textContent = `${formatMoney(data.month.total)} (${data.month.count})`;

    const slowCard = document.getElementById('card-slow-moving');
    slowCard.hidden = false;
    const tbSlow = document.getElementById('tb-slow-moving');
    data.slowMoving.forEach((p) => {
      tbSlow.appendChild(el('tr', {}, [el('td', {}, p.name), el('td', {}, String(p.currentStock))]));
    });
    if (data.slowMoving.length === 0) tbSlow.appendChild(el('tr', {}, el('td', { colspan: '2', class: 'muted' }, 'Nenhum produto parado.')));
  }
}

// ---------- Vendas ----------
async function renderVendas() {
  activeTemplate('vendas');
  cart = [];
  payMethod = null;
  renderCart();

  const searchInput = document.getElementById('sale-search');
  const resultsBox = document.getElementById('sale-results');
  let searchTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = searchInput.value.trim();
    if (!term) { resultsBox.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const products = await api.get(`/products?query=${encodeURIComponent(term)}`);
      resultsBox.innerHTML = '';
      products.slice(0, 8).forEach((p) => {
        resultsBox.appendChild(el('div', {
          onclick: () => {
            addToCart(p);
            searchInput.value = '';
            resultsBox.innerHTML = '';
            searchInput.focus();
          },
        }, `${p.name} — ${formatMoney(p.salePrice)} (estoque: ${p.currentStock} ${p.unit})`));
      });
      if (products.length === 0) resultsBox.appendChild(el('div', { class: 'muted' }, 'Nenhum produto encontrado.'));
    }, 250);
  });

  // Leitura contínua: cada código lido entra no carrinho e a câmera segue aberta para o próximo.
  document.getElementById('sale-scan-btn').addEventListener('click', () => openScanner({
    continuous: true,
    onCode: async (code) => {
      const product = await findProductByBarcode(code);
      if (!product) return { ok: false, message: `Código ${code} não cadastrado.` };
      addToCart(product);
      const qty = cart.find((i) => i.productId === product.id).quantity;
      return { ok: true, message: `✔ ${product.name} — ${qty} no carrinho. Pode passar o próximo.` };
    },
  }));

  document.getElementById('confirm-sale-btn').addEventListener('click', confirmSale);

  document.querySelector('.pay-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.pay-btn');
    if (btn) selectPayMethod(btn.dataset.method);
  });
  const received = document.getElementById('cash-received');
  received.addEventListener('input', updateCheckout);
  wireQuickCash(document.getElementById('cash-received-quick'), received, cartTotalCents);
  updateCheckout();

  document.getElementById('sale-open-cash-btn').addEventListener('click', () => openCashOpenModal());
  paintSaleCashWarning();
  refreshCashStatus().then(paintSaleCashWarning).catch(() => {});

  await loadRecentSales();
}

function selectPayMethod(method) {
  payMethod = method;
  document.querySelectorAll('.pay-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.method === method)));
  document.getElementById('cash-box').hidden = method !== 'CASH';
  if (method === 'CASH') document.getElementById('cash-received').focus();
  updateCheckout();
}

function resetPayment() {
  payMethod = null;
  document.querySelectorAll('.pay-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  const received = document.getElementById('cash-received');
  if (received) received.value = '';
  const box = document.getElementById('cash-box');
  if (box) box.hidden = true;
}

const cartTotalCents = () => Math.round(cart.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100);
const centsToInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

// Botões de cédula somam ao valor (o cliente entrega uma de 50 e uma de 20);
// "Valor exato" e "Limpar" substituem. Menos digitação no balcão.
function wireQuickCash(container, input, exactCents) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cash]');
    if (!btn) return;
    const action = btn.dataset.cash;
    let cents = null;
    if (action === 'exact') cents = exactCents();
    else if (action !== 'clear') cents = (parseMoneyCents(input.value) ?? 0) + Number(action) * 100;
    input.value = cents === null ? '' : centsToInput(cents);
    input.dispatchEvent(new Event('input'));
  });
}

// Botão de confirmar e linha de troco, recalculados a cada mudança no
// carrinho, na forma de pagamento ou no valor entregue. Em dinheiro, não deixa
// fechar a venda com valor entregue menor que o total.
function updateCheckout() {
  const btn = document.getElementById('confirm-sale-btn');
  if (!btn) return;
  const changeLine = document.getElementById('cash-change');
  changeLine.textContent = '';
  changeLine.className = 'change-line';

  let blocker = '';
  if (cart.length === 0) blocker = 'Adicione produtos à venda.';
  else if (!payMethod) blocker = 'Escolha a forma de pagamento.';
  else if (payMethod === 'CASH') {
    const text = document.getElementById('cash-received').value;
    const received = parseMoneyCents(text);
    const total = cartTotalCents();
    if (received === null) {
      blocker = text.trim() ? 'Valor entregue inválido: use números, ex: 50,00.' : 'Informe o valor entregue (ou toque em "Valor exato").';
    } else if (received < total) {
      changeLine.textContent = `Faltam ${formatMoney((total - received) / 100)}`;
      changeLine.classList.add('bad');
      blocker = 'O valor entregue é menor que o total da venda.';
    } else {
      changeLine.textContent = `Troco: ${formatMoney((received - total) / 100)}`;
      changeLine.classList.add('ok');
    }
  }

  btn.disabled = Boolean(blocker) || saleInFlight;
  btn.textContent = saleInFlight ? 'Registrando…' : 'Confirmar venda';
  document.getElementById('sale-hint').textContent = saleInFlight ? '' : blocker;
}

function paintSaleCashWarning() {
  const banner = document.getElementById('sale-cash-warning');
  if (banner) banner.hidden = Boolean(cashSession);
}

function addToCart(product) {
  const existing = cart.find((i) => i.productId === product.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ productId: product.id, name: product.name, unit: product.unit, price: product.salePrice, quantity: 1 });
  }
  renderCart();
}

function updateCartTotal() {
  document.getElementById('cart-total').textContent = formatMoney(cartTotalCents() / 100);
  updateCheckout();
}

function renderCart() {
  const body = document.getElementById('cart-body');
  if (!body) return;
  body.innerHTML = '';

  cart.forEach((item, index) => {
    // A célula de subtotal é atualizada diretamente pelo "oninput" abaixo,
    // em vez de chamar renderCart() de novo a cada tecla digitada — recriar
    // a <tr>/<input> em todo keystroke troca o nó DOM do campo de
    // quantidade, e o navegador perde o foco nele. Na prática, o segundo
    // dígito de "12" nunca chegava a ser digitado: o campo perdia o foco
    // assim que o "1" era digitado.
    const subtotalCell = el('td', {}, formatMoney(item.price * item.quantity));
    const qtyInput = el('input', {
      type: 'number', min: '0.001', step: '0.001', value: String(item.quantity),
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        item.quantity = Number.isFinite(v) && v > 0 ? v : item.quantity;
        subtotalCell.textContent = formatMoney(item.price * item.quantity);
        updateCartTotal();
      },
    });
    body.appendChild(el('tr', {}, [
      el('td', {}, item.name),
      el('td', {}, qtyInput),
      el('td', {}, formatMoney(item.price)),
      subtotalCell,
      el('td', {}, el('button', { class: 'small secondary', type: 'button', onclick: () => { cart.splice(index, 1); renderCart(); } }, 'Remover')),
    ]));
  });

  updateCartTotal();
}

async function confirmSale() {
  const btn = document.getElementById('confirm-sale-btn');
  if (saleInFlight || btn.disabled) return;
  const msg = document.getElementById('sale-msg');
  msg.hidden = true;
  const receivedCents = payMethod === 'CASH' ? parseMoneyCents(document.getElementById('cash-received').value) : null;
  saleInFlight = true;
  updateCheckout();
  try {
    const sale = await api.post('/sales', {
      items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      paymentMethod: payMethod,
    });
    cart = [];
    resetPayment();
    renderCart();
    await loadRecentSales();
    openReceipt(sale, receivedCents);
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    saleInFlight = false;
    updateCheckout();
  }
}

// O troco não é gravado no servidor: vem do valor entregue informado na tela.
// Dados do recibo, os mesmos na tela, na impressão e no WhatsApp. O PDV não dá desconto:
// "Descontos" é a soma dos itens menos o total gravado (R$ 0,00), em centavos.
function receiptData(sale, receivedCents = null) {
  const cents = (value) => Math.round(Number(value) * 100);
  const subtotalCents = sale.items.reduce((sum, item) => sum + cents(item.subtotal), 0);
  const totalCents = cents(sale.totalAmount);
  let payment = `Pagamento: ${PAYMENT_LABELS[sale.paymentMethod] || sale.paymentMethod}`;
  if (receivedCents !== null) {
    const change = receivedCents - totalCents;
    payment += ` · Recebido ${formatMoney(receivedCents / 100)} · ${change >= 0 ? `Troco ${formatMoney(change / 100)}` : `Faltam ${formatMoney(-change / 100)}`}`;
  }
  return {
    store: storeName,
    when: formatDateTime(sale.createdAt),
    items: sale.items.map((item) => ({
      name: item.product,
      detail: `${`${Number(item.quantity).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${item.unit || ''}`.trim()} × ${formatMoney(item.unitPrice)}`,
      subtotal: formatMoney(item.subtotal),
    })),
    subtotal: formatMoney(subtotalCents / 100),
    discount: formatMoney((subtotalCents - totalCents) / 100),
    total: formatMoney(totalCents / 100),
    payment,
  };
}

// Resumo da venda para o WhatsApp (*negrito* é a marcação do próprio WhatsApp).
function receiptWhatsAppText(r) {
  return [
    ...(r.store ? [`*${r.store}*`] : []),
    r.when,
    '',
    ...r.items.map((item) => `${item.name}\n  ${item.detail} = ${item.subtotal}`),
    '',
    `Subtotal: ${r.subtotal}`,
    `Descontos: ${r.discount}`,
    `*Total: ${r.total}*`,
    r.payment,
    '',
    'Obrigado pela preferência!',
  ].join('\n');
}

function openReceipt(sale, receivedCents = null) {
  const modal = openModal('tpl-receipt');
  const r = receiptData(sale, receivedCents);
  const store = document.getElementById('receipt-store');
  store.textContent = r.store;
  store.hidden = !r.store;
  document.getElementById('receipt-meta').textContent = r.when;
  document.getElementById('receipt-items').append(...r.items.map((item) => el('li', {}, [
    el('span', { class: 'receipt-name' }, item.name),
    el('span', { class: 'receipt-row' }, [el('span', {}, item.detail), el('span', {}, item.subtotal)]),
  ])));
  document.getElementById('receipt-subtotal').textContent = r.subtotal;
  document.getElementById('receipt-discount').textContent = r.discount;
  document.getElementById('receipt-total').textContent = r.total;
  document.getElementById('receipt-payment').textContent = r.payment;
  document.getElementById('receipt-wa-link').href = `https://wa.me/?text=${encodeURIComponent(receiptWhatsAppText(r))}`;
  document.getElementById('receipt-print-btn').addEventListener('click', () => window.print());
  document.getElementById('receipt-close-btn').addEventListener('click', () => closeModal(modal));
}

async function loadRecentSales() {
  const seq = viewSeq;
  const data = await api.get('/sales?pageSize=15');
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia
  const body = document.getElementById('sales-list');
  body.innerHTML = '';
  data.sales.forEach((s) => {
    const cells = [
      el('td', {}, formatDateTime(s.createdAt)),
      el('td', {}, s.seller),
      el('td', {}, String(s.itemCount)),
      el('td', {}, PAYMENT_LABELS[s.paymentMethod] || s.paymentMethod),
      el('td', {}, formatMoney(s.totalAmount)),
    ];
    if (currentUser.role === 'ADMIN') {
      cells.push(el('td', {}, el('button', {
        class: 'small danger', type: 'button',
        onclick: async () => {
          if (!confirm('Cancelar esta venda? O estoque dos itens será devolvido.')) return;
          await api.post(`/sales/${s.id}/cancel`);
          await loadRecentSales();
        },
      }, 'Cancelar')));
    } else {
      cells.push(el('td', {}));
    }
    body.appendChild(el('tr', {}, cells));
  });
  if (data.sales.length === 0) body.appendChild(el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'Nenhuma venda registrada.')));
}

// ---------- Caixa ----------
async function refreshCashStatus() {
  try {
    cashSession = await api.get('/cash-sessions/current');
  } catch (err) {
    if (err.status !== 404) throw err;
    cashSession = null;
  }
  const chip = document.getElementById('cash-chip');
  chip.hidden = false;
  chip.textContent = cashSession ? 'Caixa aberto' : 'Caixa fechado';
  chip.classList.toggle('open', Boolean(cashSession));
  chip.classList.toggle('closed', !cashSession);
  return cashSession;
}

document.getElementById('cash-chip').addEventListener('click', () => switchTab('caixa'));

// Depois de abrir ou fechar: atualiza o indicador e a tela que estiver aberta,
// sem recarregar a de vendas (que perderia o carrinho em andamento).
async function afterCashChange() {
  await refreshCashStatus();
  if (currentTab === 'caixa') await renderCaixa();
  else if (currentTab === 'vendas') paintSaleCashWarning();
}

async function renderCaixa() {
  activeTemplate('caixa');
  const seq = viewSeq;
  await refreshCashStatus();
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia
  const isAdmin = currentUser.role === 'ADMIN';
  const state = document.getElementById('cash-state');
  const openBtn = document.getElementById('cash-open-btn');
  const closeBtn = document.getElementById('cash-close-btn');

  if (cashSession) {
    state.textContent = 'Caixa aberto';
    state.classList.add('open');
    document.getElementById('cash-state-meta').textContent =
      `Aberto por ${cashSession.openedBy} em ${formatDateTime(cashSession.openedAt)} · fundo de troco ${formatMoney(cashSession.openingAmount)}`;
    closeBtn.hidden = false;
    if (isAdmin) paintCashLive(cashSession);
  } else {
    state.textContent = 'Caixa fechado';
    state.classList.add('closed');
    document.getElementById('cash-state-meta').textContent = 'Abra o caixa com o fundo de troco antes de começar as vendas.';
    openBtn.hidden = false;
  }
  openBtn.addEventListener('click', () => openCashOpenModal());
  closeBtn.addEventListener('click', () => openCashCloseModal());

  // Valores e histórico são só do administrador (o funcionário fecha às cegas).
  if (isAdmin) {
    document.getElementById('cash-history-section').hidden = false;
    cashHistoryPage = 1;
    await loadCashHistory();
  }
}

function paintCashLive(s) {
  const box = document.getElementById('cash-live');
  const stat = (label, value) => el('div', { class: 'card stat' }, [el('span', { class: 'stat-label' }, label), el('span', { class: 'stat-value' }, value)]);
  box.append(
    stat('Dinheiro esperado na gaveta', formatMoney(s.expectedAmount)),
    stat('Vendas em dinheiro', formatMoney(s.totalsByPaymentMethod.CASH)),
    stat('Pix', formatMoney(s.totalsByPaymentMethod.PIX)),
    stat('Débito', formatMoney(s.totalsByPaymentMethod.DEBIT_CARD)),
    stat('Crédito', formatMoney(s.totalsByPaymentMethod.CREDIT_CARD)),
    stat(`Total vendido (${s.salesCount})`, formatMoney(s.salesTotal)),
  );
  box.hidden = false;
}

function differenceBadge(diff) {
  if (diff === null || diff === undefined) return el('span', { class: 'muted' }, '—');
  const cents = Math.round(diff * 100);
  if (cents === 0) return el('span', { class: 'badge ok' }, 'Sem diferença');
  return cents < 0
    ? el('span', { class: 'badge bad' }, `Falta ${formatMoney(-cents / 100)}`)
    : el('span', { class: 'badge warn' }, `Sobra ${formatMoney(cents / 100)}`);
}

function openCashOpenModal() {
  if (document.getElementById('cash-open-form')) return; // já está aberto na tela
  const modal = openModal('tpl-cash-open');
  const input = document.getElementById('cash-opening');
  wireQuickCash(document.getElementById('cash-opening-quick'), input);
  input.focus();
  document.getElementById('cash-open-later').addEventListener('click', () => closeModal(modal));

  const form = document.getElementById('cash-open-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('cash-open-msg');
    msg.hidden = true;
    const cents = parseMoneyCents(input.value);
    if (cents === null) {
      msg.textContent = 'Informe o fundo de troco em reais, ex: 100,00 (ou 0 se não houver).';
      msg.hidden = false;
      return;
    }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api.post('/cash-sessions', { openingAmount: cents / 100 });
      closeModal(modal);
      await afterCashChange();
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
      if (err.status === 409) await afterCashChange(); // alguém abriu antes
    } finally {
      submit.disabled = false;
    }
  });
}

function openCashCloseModal() {
  const modal = openModal('tpl-cash-close');
  const input = document.getElementById('cash-counted');
  input.focus();
  document.getElementById('cash-close-cancel').addEventListener('click', () => closeModal(modal));

  const form = document.getElementById('cash-close-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('cash-close-msg');
    msg.hidden = true;
    const cents = parseMoneyCents(input.value);
    if (cents === null) {
      msg.textContent = 'Informe o dinheiro contado em reais, ex: 350,00.';
      msg.hidden = false;
      return;
    }
    if (!confirm(`Fechar o caixa com ${formatMoney(cents / 100)} contados? Depois de fechado, ele não reabre.`)) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const closed = await api.post('/cash-sessions/current/close', {
        countedAmount: cents / 100,
        notes: document.getElementById('cash-notes').value.trim() || null,
      });
      closeModal(modal);
      openCashSummary(closed, 'Caixa fechado');
      await afterCashChange();
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
      if (err.status === 404) await afterCashChange(); // outra pessoa já fechou
    } finally {
      submit.disabled = false;
    }
  });
}

// Resumo do caixa. Sem `expectedAmount` na resposta (funcionário), é o
// fechamento cego: só o que a própria pessoa contou.
function openCashSummary(session, title) {
  const modal = openModal('tpl-cash-summary');
  document.getElementById('cash-summary-title').textContent = title;
  const body = document.getElementById('cash-summary-body');
  if (session.expectedAmount === undefined) {
    body.append(
      el('p', { class: 'summary-lead' }, `Contagem registrada: ${formatMoney(session.countedAmount)}.`),
      el('p', { class: 'muted' }, 'O administrador confere o resultado do fechamento.'),
    );
  } else {
    const rows = [
      ['Aberto', `${formatDateTime(session.openedAt)} por ${session.openedBy}`],
      ['Fechado', session.closedAt ? `${formatDateTime(session.closedAt)} por ${session.closedBy}` : 'Ainda aberto'],
      ['Fundo de troco', formatMoney(session.openingAmount)],
      ['Vendas em dinheiro', formatMoney(session.totalsByPaymentMethod.CASH)],
      ['Dinheiro esperado', formatMoney(session.expectedAmount)],
      ['Dinheiro contado', session.countedAmount === null ? '—' : formatMoney(session.countedAmount)],
      ['Diferença', differenceBadge(session.difference)],
      ['Pix', formatMoney(session.totalsByPaymentMethod.PIX)],
      ['Débito', formatMoney(session.totalsByPaymentMethod.DEBIT_CARD)],
      ['Crédito', formatMoney(session.totalsByPaymentMethod.CREDIT_CARD)],
      [`Total vendido (${session.salesCount} vendas)`, formatMoney(session.salesTotal)],
    ];
    if (session.notes) rows.push(['Observações', session.notes]);
    const list = el('dl', { class: 'summary-list' });
    rows.forEach(([label, value]) => list.append(el('dt', {}, label), el('dd', {}, value)));
    body.append(list);
  }
  document.getElementById('cash-summary-ok').addEventListener('click', () => closeModal(modal));
}

async function loadCashHistory() {
  const data = await api.get(`/cash-sessions?page=${cashHistoryPage}&pageSize=${LIST_PAGE_SIZE}`);
  const body = document.getElementById('cash-history');
  if (!body) return;
  body.innerHTML = '';
  data.sessions.forEach((s) => {
    body.appendChild(el('tr', {}, [
      el('td', {}, `${formatDateTime(s.openedAt)} · ${s.openedBy}`),
      el('td', {}, s.closedAt ? `${formatDateTime(s.closedAt)} · ${s.closedBy}` : el('span', { class: 'badge ok' }, 'Aberto agora')),
      el('td', {}, formatMoney(s.openingAmount)),
      el('td', {}, formatMoney(s.expectedAmount)),
      el('td', {}, s.countedAmount === null ? '—' : formatMoney(s.countedAmount)),
      el('td', {}, differenceBadge(s.difference)),
      el('td', {}, `${s.salesCount} · ${formatMoney(s.salesTotal)}`),
      el('td', {}, el('button', { class: 'small secondary', type: 'button', onclick: () => openCashSummary(s, 'Detalhes do caixa') }, 'Detalhes')),
    ]));
  });
  if (data.sessions.length === 0) body.appendChild(el('tr', {}, el('td', { colspan: '8', class: 'muted' }, 'Nenhum caixa registrado.')));
  renderPager('cash-pager', data, (nextPage) => {
    cashHistoryPage = nextPage;
    loadCashHistory();
  });
}

// ---------- Produtos ----------
async function renderProdutos(options) {
  activeTemplate('produtos');
  productsPage = 1;
  productUrgencyFilter = options?.urgency || null; // vindo de um cartão do painel
  paintUrgencyFilter();
  const seq = viewSeq;
  await loadProducts();
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia

  document.getElementById('product-search').addEventListener('input', debounce(() => {
    productsPage = 1;
    loadProducts();
  }, 250));
  document.querySelector('.urgency-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    productUrgencyFilter = chip.dataset.urgency || null;
    productsPage = 1;
    paintUrgencyFilter();
    loadProducts();
  });
  const newBtn = document.getElementById('new-product-btn');
  if (newBtn) newBtn.addEventListener('click', () => openProductForm(null));
}

function renderPager(containerId, { page, pageSize, totalCount }, onPage) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  box.innerHTML = '';
  if (totalCount === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);
  box.appendChild(el('span', {}, `Mostrando ${from}–${to} de ${totalCount}`));
  const actions = el('div', { class: 'pager-actions' });
  const prev = el('button', {
    type: 'button',
    class: 'small secondary',
    onclick: () => { if (page > 1) onPage(page - 1); },
  }, 'Anterior');
  prev.disabled = page <= 1;
  const next = el('button', {
    type: 'button',
    class: 'small secondary',
    onclick: () => { if (page < totalPages) onPage(page + 1); },
  }, 'Próxima');
  next.disabled = page >= totalPages;
  actions.appendChild(prev);
  actions.appendChild(next);
  box.appendChild(actions);
}

function paintUrgencyFilter() {
  document.querySelectorAll('.urgency-filter .filter-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String((chip.dataset.urgency || null) === productUrgencyFilter));
  });
}

// Quantos produtos ativos há em cada cor — o filtro da API já devolve o total.
async function urgencyCounts() {
  const levels = Object.keys(URGENCY_INFO);
  const pages = await Promise.all(levels.map((level) => api.get(`/products?urgency=${level}&page=1&pageSize=1`)));
  return Object.fromEntries(levels.map((level, i) => [level, pages[i].totalCount]));
}

function urgencyReasons(p) {
  const d = p.daysToExpiry;
  const text = {
    OUT_OF_STOCK: 'Sem estoque',
    EXPIRED: d === -1 ? 'Venceu ontem' : `Vencido há ${-d} dias`,
    EXPIRES_SOON: d === 0 ? 'Vence hoje' : d === 1 ? 'Vence amanhã' : `Vence em ${d} dias`,
    EXPIRING: `Vence em ${d} dias`,
    LOW_STOCK: p.currentStock < p.minStock ? 'Abaixo do estoque mínimo' : 'No estoque mínimo',
  };
  return p.urgencyReasons.map((reason) => text[reason] || reason);
}

// Selo com a cor e, logo abaixo, os motivos — visíveis também no toque (tablet e
// celular não mostram tooltip); o title repete os motivos para quem usa mouse.
function urgencyCell(p) {
  // Produto desativado está fora das vendas: uma cor ali seria alarme falso.
  if (!p.active) return el('td', {}, el('span', { class: 'badge semaforo inactive', title: 'Desativado: fora do semáforo' }, 'Inativo'));
  const info = URGENCY_INFO[p.urgency];
  const reasons = urgencyReasons(p);
  return el('td', {}, [
    el('span', { class: `badge semaforo ${info.css}`, title: reasons.join(' · ') || info.hint }, `${info.emoji} ${info.label}`),
    reasons.length ? el('span', { class: 'urgency-reasons' }, reasons.join(' · ')) : null,
  ]);
}

async function loadProducts() {
  const term = document.getElementById('product-search')?.value.trim() || '';
  // Filtrando por cor, só os ativos — a mesma conta dos cartões do painel.
  const includeInactive = currentUser.role === 'ADMIN' && !productUrgencyFilter ? '&includeInactive=true' : '';
  const urgency = productUrgencyFilter ? `&urgency=${productUrgencyFilter}` : '';
  const seq = viewSeq;
  const data = await api.get(`/products?query=${encodeURIComponent(term)}${includeInactive}${urgency}&page=${productsPage}&pageSize=${LIST_PAGE_SIZE}`);
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia
  const products = data.products;
  const body = document.getElementById('products-list');
  body.innerHTML = '';

  products.forEach((p) => {
    const stockBadge = p.currentStock <= p.minStock
      ? el('span', { class: 'badge bad' }, `${p.currentStock} ${p.unit}`)
      : el('span', {}, `${p.currentStock} ${p.unit}`);

    const cells = [
      urgencyCell(p),
      el('td', {}, p.name + (p.active ? '' : ' (inativo)')),
      el('td', {}, p.category || '—'),
      el('td', {}, stockBadge),
      el('td', {}, String(p.minStock)),
      el('td', {}, formatMoney(p.salePrice)),
    ];
    const costCell = el('td', {}, currentUser.role === 'ADMIN' ? formatMoney(p.costPrice) : '');
    costCell.setAttribute('data-admin-only', '');
    cells.push(costCell);
    cells.push(el('td', {}, formatDate(p.expiryDate)));

    if (currentUser.role === 'ADMIN') {
      cells.push(el('td', {}, el('button', { class: 'small secondary', type: 'button', onclick: () => openProductForm(p) }, 'Editar')));
    } else {
      cells.push(el('td', {}));
    }
    body.appendChild(el('tr', {}, cells));
  });

  if (products.length === 0) body.appendChild(el('tr', {}, el('td', { colspan: '9', class: 'muted' }, 'Nenhum produto encontrado.')));
  renderPager('products-pager', data, (nextPage) => {
    productsPage = nextPage;
    loadProducts();
  });
}

function openProductForm(product) {
  const modal = openModal('tpl-product-form');

  const isEdit = Boolean(product);
  document.getElementById('product-form-title').textContent = isEdit ? 'Editar produto' : 'Novo produto';
  document.getElementById('p-initial-stock-label').style.display = isEdit ? 'none' : '';
  document.getElementById('p-initial-stock').style.display = isEdit ? 'none' : '';

  if (isEdit) {
    document.getElementById('p-id').value = product.id;
    document.getElementById('p-name').value = product.name;
    document.getElementById('p-category').value = product.category || '';
    document.getElementById('p-barcode').value = product.barcode || '';
    document.getElementById('p-unit').value = product.unit;
    document.getElementById('p-sale-price').value = product.salePrice;
    document.getElementById('p-cost-price').value = product.costPrice ?? '';
    document.getElementById('p-min-stock').value = product.minStock;
    document.getElementById('p-expiry').value = product.expiryDate ? product.expiryDate.slice(0, 10) : '';
    const deleteBtn = document.getElementById('product-delete-btn');
    deleteBtn.hidden = false;
    if (product.active) {
      deleteBtn.textContent = 'Desativar produto';
      deleteBtn.classList.add('danger');
      deleteBtn.classList.remove('secondary');
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Desativar "${product.name}"? Ele deixará de aparecer em vendas novas.`)) return;
        await api.del(`/products/${product.id}`);
        closeModal(modal);
        await loadProducts();
      });
    } else {
      // Sem isto, um produto desativado não tinha NENHUMA forma de voltar —
      // nem pela tela, nem pela API — a não ser mexendo direto no banco.
      deleteBtn.textContent = 'Reativar produto';
      deleteBtn.classList.add('secondary');
      deleteBtn.classList.remove('danger');
      deleteBtn.addEventListener('click', async () => {
        await api.put(`/products/${product.id}`, { active: true });
        closeModal(modal);
        await loadProducts();
      });
    }
  }

  document.getElementById('product-cancel-btn').addEventListener('click', () => closeModal(modal));

  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('product-form-msg');
    msg.hidden = true;
    const payload = {
      name: document.getElementById('p-name').value,
      category: document.getElementById('p-category').value || null,
      barcode: document.getElementById('p-barcode').value || null,
      unit: document.getElementById('p-unit').value,
      salePrice: parseFloat(document.getElementById('p-sale-price').value),
      costPrice: parseFloat(document.getElementById('p-cost-price').value),
      minStock: parseFloat(document.getElementById('p-min-stock').value || '0'),
      expiryDate: document.getElementById('p-expiry').value || null,
    };
    if (!isEdit) payload.initialStock = parseFloat(document.getElementById('p-initial-stock').value || '0');

    try {
      if (isEdit) await api.put(`/products/${product.id}`, payload);
      else await api.post('/products', payload);
      closeModal(modal);
      await loadProducts();
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
    }
  });
}

// ---------- Compras ----------
async function renderCompras() {
  activeTemplate('compras');
  const seq = viewSeq;
  const [list, text] = await Promise.all([api.get('/shopping-list'), api.get('/shopping-list?format=text')]);
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia

  const body = document.getElementById('shop-list');
  list.items.forEach((item) => {
    body.appendChild(el('tr', {}, [
      el('td', {}, item.name),
      el('td', {}, item.category || 'Sem categoria'),
      el('td', {}, el('span', { class: `badge ${item.currentStock <= 0 ? 'bad' : 'warn'}` }, `${item.currentStock} ${item.unit}`)),
      el('td', {}, `${item.minStock} ${item.unit}`),
      el('td', {}, item.avgDailySales > 0 ? `${item.avgDailySales} ${item.unit}` : '—'),
      el('td', {}, item.daysUntilStockout === null ? '—' : `${item.daysUntilStockout} dia(s)`),
    ]));
  });
  if (list.items.length === 0) body.appendChild(el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'Nada para comprar: nenhum produto está no estoque mínimo.')));

  document.getElementById('shop-text').value = text;
  const copyBtn = document.getElementById('shop-copy-btn');
  const waLink = document.getElementById('shop-wa-link');
  // shortcut: a lista inteira vai na URL; com centenas de itens o WhatsApp pode cortar — aí, use "Copiar".
  waLink.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  copyBtn.disabled = list.items.length === 0;
  waLink.hidden = list.items.length === 0;

  copyBtn.addEventListener('click', async () => {
    const msg = document.getElementById('shop-msg');
    const error = document.getElementById('shop-error');
    msg.hidden = true;
    error.hidden = true;
    if (await copyText(text)) {
      msg.textContent = `Lista copiada (${list.totalItems} produto(s)). Agora é só colar na conversa do WhatsApp.`;
      msg.hidden = false;
      setTimeout(() => { msg.hidden = true; }, 6000);
    } else {
      error.textContent = 'Não foi possível copiar automaticamente: selecione o texto abaixo e copie.';
      error.hidden = false;
    }
  });
}

// A API de área de transferência só existe em HTTPS ou localhost; acessando pelo
// IP da rede local (http://192.168…), cai no método antigo de copiar.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { readonly: '' }, text);
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// ---------- Estoque ----------
async function renderEstoque() {
  activeTemplate('estoque');
  movementsPage = 1;
  const seq = viewSeq;
  const products = await api.get('/products');
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia

  const entrySelect = document.getElementById('entry-product');
  const adjSelect = document.getElementById('adjustment-product');
  products.forEach((p) => {
    entrySelect.appendChild(el('option', { value: p.id }, `${p.name} (${p.currentStock} ${p.unit})`));
    adjSelect.appendChild(el('option', { value: p.id }, `${p.name} (${p.currentStock} ${p.unit})`));
  });

  // Na entrada basta um código: seleciona o produto, fecha a câmera e vai para a quantidade.
  document.getElementById('entry-scan-btn').addEventListener('click', () => openScanner({
    onCode: (code) => {
      const product = products.find((p) => barcodeVariants(code).includes(p.barcode));
      if (!product) return { ok: false, message: `Código ${code} não cadastrado. Cadastre o produto em Produtos.` };
      entrySelect.value = product.id;
      document.getElementById('entry-qty').focus();
      return { ok: true, message: `✔ ${product.name}` };
    },
  }));

  // Validade obrigatória — é ela que alimenta o PVPS e os alertas de vencimento.
  // Produto que não vence (limpeza, higiene) precisa ser marcado de propósito.
  const expiryInput = document.getElementById('entry-expiry');
  const noExpiry = document.getElementById('entry-no-expiry');
  noExpiry.addEventListener('change', () => {
    expiryInput.disabled = noExpiry.checked;
    expiryInput.required = !noExpiry.checked;
    if (noExpiry.checked) expiryInput.value = '';
  });

  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('entry-msg');
    msg.hidden = true;
    document.getElementById('entry-ok').hidden = true;
    const expiryDate = noExpiry.checked ? null : expiryInput.value;
    if (expiryDate && expiryDate < localDateISO() && !confirm('A validade informada já passou. Registrar o lote mesmo assim?')) return;
    try {
      const { batch } = await api.post('/stock/entries', {
        productId: entrySelect.value,
        quantity: parseFloat(document.getElementById('entry-qty').value),
        reason: document.getElementById('entry-reason').value || undefined,
        expiryDate,
      });
      await renderEstoque();
      const ok = document.getElementById('entry-ok');
      ok.textContent = `Lote registrado: ${batch.quantity} ${batch.unit} de ${batch.product}, ${batch.expiryDate ? `validade ${formatDate(batch.expiryDate)}` : 'sem validade'}.`;
      ok.hidden = false;
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
    }
  });

  document.getElementById('adjustment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('adjustment-msg');
    msg.hidden = true;
    try {
      await api.post('/stock/adjustments', {
        productId: adjSelect.value,
        quantity: -Math.abs(parseFloat(document.getElementById('adjustment-qty').value)),
        reason: document.getElementById('adjustment-reason').value,
        type: 'LOSS',
      });
      document.getElementById('adjustment-form').reset();
      await renderEstoque();
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
    }
  });

  await loadMovements();
}

async function loadMovements() {
  const data = await api.get(`/stock/movements?page=${movementsPage}&pageSize=${LIST_PAGE_SIZE}`);
  const body = document.getElementById('movements-list');
  if (!body) return;
  body.innerHTML = '';
  data.movements.forEach((m) => {
    body.appendChild(el('tr', {}, [
      el('td', {}, formatDateTime(m.createdAt)),
      el('td', {}, m.product),
      el('td', {}, m.type),
      el('td', {}, String(m.quantity)),
      el('td', {}, String(m.newStock)),
      el('td', {}, m.reason || '—'),
      el('td', {}, m.user),
    ]));
  });
  if (data.movements.length === 0) body.appendChild(el('tr', {}, el('td', { colspan: '7', class: 'muted' }, 'Nenhuma movimentação registrada.')));
  renderPager('movements-pager', data, (nextPage) => {
    movementsPage = nextPage;
    loadMovements();
  });
}

// ---------- Importar planilha ----------
// A grade lida do arquivo fica aqui no navegador para que trocar o mapeamento
// de colunas ou uma opção não exija reenviar o arquivo. Quem valida e decide
// o que gravar é sempre o servidor — a tela só mostra o plano que ele devolve.
let importState = null;

const IMPORT_STEPS = ['source', 'mapping', 'preview', 'result'];

function showImportStep(step) {
  IMPORT_STEPS.forEach((name) => {
    document.getElementById(`imp-step-${name}`).hidden = name !== step;
  });
}

async function renderImportar() {
  activeTemplate('importar');
  importState = null;

  document.getElementById('imp-read-btn').addEventListener('click', readSpreadsheet);
  document.getElementById('imp-back-btn').addEventListener('click', () => showImportStep('source'));
  document.getElementById('imp-adjust-btn').addEventListener('click', () => showImportStep('mapping'));
  document.getElementById('imp-preview-btn').addEventListener('click', previewImport);
  document.getElementById('imp-commit-btn').addEventListener('click', commitImport);
  document.getElementById('imp-restart-btn').addEventListener('click', renderImportar);
}

async function readSpreadsheet() {
  const msg = document.getElementById('imp-source-msg');
  const btn = document.getElementById('imp-read-btn');
  msg.hidden = true;

  const file = document.getElementById('imp-file').files[0];
  const pasted = document.getElementById('imp-paste').value.trim();
  if (!file && !pasted) {
    msg.textContent = 'Escolha um arquivo ou cole os dados da planilha.';
    msg.hidden = false;
    return;
  }

  btn.disabled = true;
  try {
    let body;
    if (file) {
      body = new FormData();
      body.append('file', file);
    } else {
      body = { text: pasted };
    }
    importState = await api.post('/imports/products/parse', body);
    renderColumnMapping();
    showImportStep('mapping');
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// Mostra, abaixo de cada seleção, o primeiro valor preenchido daquela coluna.
// É o que permite conferir o mapeamento sem abrir a planilha do lado.
function columnSample(columnIndex) {
  if (columnIndex === '') return '';
  const value = importState.rows.map((row) => row[Number(columnIndex)]).find((cell) => cell !== null && cell !== '');
  return value === undefined ? '(coluna vazia)' : `Ex: ${value}`;
}

function renderColumnMapping() {
  const { headers, rows, fields, mapping } = importState;
  document.getElementById('imp-grid-info').textContent =
    `${rows.length} linha(s) de dados e ${headers.length} coluna(s) lidas. Confira se cada campo aponta para a coluna certa.`;

  const grid = document.getElementById('imp-map-grid');
  grid.innerHTML = '';

  fields.forEach((field) => {
    const selectId = `imp-map-${field.key}`;
    const sample = el('span', { class: 'map-sample' });
    const select = el('select', {
      id: selectId,
      onchange: (e) => { sample.textContent = columnSample(e.target.value); },
    }, [el('option', { value: '' }, '— não importar —')]);

    headers.forEach((header, index) => select.appendChild(el('option', { value: String(index) }, header)));
    select.value = mapping[field.key] === undefined ? '' : String(mapping[field.key]);
    sample.textContent = columnSample(select.value);

    grid.appendChild(el('div', {}, [
      el('label', { for: selectId }, field.required ? `${field.label} (obrigatório)` : field.label),
      select,
      sample,
    ]));
  });
}

function buildImportPayload() {
  const mapping = {};
  importState.fields.forEach((field) => {
    const value = document.getElementById(`imp-map-${field.key}`).value;
    if (value !== '') mapping[field.key] = Number(value);
  });

  return {
    headers: importState.headers,
    rows: importState.rows,
    mapping,
    options: {
      mode: document.getElementById('imp-mode').value,
      matchBy: document.getElementById('imp-match-by').value,
      stockMode: document.getElementById('imp-stock-mode').value,
    },
  };
}

async function previewImport() {
  const msg = document.getElementById('imp-map-msg');
  const btn = document.getElementById('imp-preview-btn');
  msg.hidden = true;
  btn.disabled = true;

  try {
    // O mesmo payload conferido aqui é o que vai para a gravação — assim o
    // que o usuário aprovou na tela é literalmente o que o servidor executa.
    importState.payload = buildImportPayload();
    renderImportPlan(await api.post('/imports/products/preview', importState.payload));
    showImportStep('preview');
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

const IMPORT_ACTIONS = {
  create: { label: 'Cadastrar', badge: 'ok' },
  update: { label: 'Atualizar', badge: 'warn' },
  skip: { label: 'Ignorar', badge: '' },
  error: { label: 'Erro', badge: 'bad' },
};

function formatQuantity(value) {
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function renderImportPlan(plan) {
  const summary = document.getElementById('imp-summary');
  summary.innerHTML = '';
  [
    ['Novos', plan.summary.create],
    ['Atualizações', plan.summary.update],
    ['Ignorados', plan.summary.skip],
    ['Com erro', plan.summary.error],
  ].forEach(([label, value]) => {
    summary.appendChild(el('div', { class: 'card stat' }, [
      el('span', { class: 'stat-label' }, label),
      el('span', { class: 'stat-value' }, String(value)),
    ]));
  });

  // Toda linha com erro ou aviso aparece — são as que exigem decisão. As
  // linhas limpas entram só como amostra: numa planilha de 1.000 itens, listar
  // todas trava a tela sem acrescentar informação.
  const notable = plan.items.filter((i) => i.errors.length > 0 || i.warnings.length > 0);
  const clean = plan.items.filter((i) => i.errors.length === 0 && i.warnings.length === 0);
  const shown = [...notable, ...clean.slice(0, 100)].sort((a, b) => a.line - b.line);

  const body = document.getElementById('imp-preview-body');
  body.innerHTML = '';

  shown.forEach((item) => {
    const action = IMPORT_ACTIONS[item.action];
    const notes = el('ul', { class: 'note-list' });
    item.errors.forEach((text) => notes.appendChild(el('li', { class: 'note-bad' }, text)));
    item.warnings.forEach((text) => notes.appendChild(el('li', { class: 'note-warn' }, text)));
    if (item.reason) notes.appendChild(el('li', {}, item.reason));

    let price = item.values.salePrice === undefined ? '—' : formatMoney(item.values.salePrice);
    if (item.before && item.values.salePrice !== undefined && item.before.salePrice !== item.values.salePrice) {
      price = `${formatMoney(item.before.salePrice)} → ${formatMoney(item.values.salePrice)}`;
    }

    let stock = '—';
    if (item.action === 'create') stock = formatQuantity(item.resultingStock);
    else if (item.stockDelta) stock = `${formatQuantity(item.before.currentStock)} → ${formatQuantity(item.resultingStock)}`;

    body.appendChild(el('tr', { class: item.action === 'error' ? 'row-error' : (item.action === 'skip' ? 'row-skip' : '') }, [
      el('td', {}, String(item.line)),
      el('td', {}, el('span', { class: `badge ${action.badge}` }, action.label)),
      el('td', {}, item.values.name || '—'),
      el('td', {}, price),
      el('td', {}, stock),
      el('td', {}, notes.childElementCount > 0 ? notes : el('span', { class: 'muted' }, '—')),
    ]));
  });

  const omitted = plan.items.length - shown.length;
  if (omitted > 0) {
    body.appendChild(el('tr', {}, el('td', { colspan: '6', class: 'muted' }, `+ ${omitted} linha(s) sem observações não listadas aqui.`)));
  }

  document.getElementById('imp-commit-btn').disabled = plan.summary.create + plan.summary.update === 0;
}

async function commitImport() {
  const msg = document.getElementById('imp-preview-msg');
  const btn = document.getElementById('imp-commit-btn');
  msg.hidden = true;

  if (!confirm('Confirmar a importação? Os produtos serão cadastrados e atualizados conforme a conferência acima.')) return;

  btn.disabled = true;
  try {
    const result = await api.post('/imports/products/commit', importState.payload);
    document.getElementById('imp-result-text').textContent =
      `${result.created} produto(s) cadastrado(s), ${result.updated} atualizado(s), ${result.skipped} ignorado(s).`;

    const failuresBox = document.getElementById('imp-failures');
    const failuresBody = document.getElementById('imp-failures-body');
    failuresBody.innerHTML = '';
    result.failures.forEach((failure) => {
      failuresBody.appendChild(el('tr', {}, [
        el('td', {}, String(failure.line)),
        el('td', {}, failure.name || '—'),
        el('td', {}, failure.error),
      ]));
    });
    failuresBox.hidden = result.failures.length === 0;

    showImportStep('result');
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Relatórios ----------
async function renderRelatorios() {
  activeTemplate('relatorios');
  document.getElementById('rep-apply-btn').addEventListener('click', loadReports);
  await loadReports();
}

async function loadReports() {
  const from = document.getElementById('rep-from').value;
  const to = document.getElementById('rep-to').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const seq = viewSeq;
  const [summary, topProducts, slowMoving] = await Promise.all([
    api.get(`/reports/sales-summary?${qs.toString()}`),
    api.get(`/reports/top-products?${qs.toString()}`),
    api.get('/reports/slow-moving'),
  ]);
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia

  document.getElementById('rep-total').textContent = formatMoney(summary.total);
  document.getElementById('rep-count').textContent = String(summary.count);

  const byDayBody = document.getElementById('rep-by-day');
  byDayBody.innerHTML = '';
  Object.entries(summary.byDay).sort().reverse().forEach(([day, total]) => {
    byDayBody.appendChild(el('tr', {}, [el('td', {}, day), el('td', {}, formatMoney(total))]));
  });
  if (Object.keys(summary.byDay).length === 0) byDayBody.appendChild(el('tr', {}, el('td', { colspan: '2', class: 'muted' }, 'Sem vendas no período.')));

  const topBody = document.getElementById('rep-top-products');
  topBody.innerHTML = '';
  topProducts.forEach((p) => {
    topBody.appendChild(el('tr', {}, [el('td', {}, p.name), el('td', {}, String(p.quantitySold)), el('td', {}, formatMoney(p.revenue))]));
  });
  if (topProducts.length === 0) topBody.appendChild(el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'Sem vendas no período.')));

  const slowBody = document.getElementById('rep-slow-moving');
  slowBody.innerHTML = '';
  slowMoving.forEach((p) => {
    slowBody.appendChild(el('tr', {}, [el('td', {}, p.name), el('td', {}, String(p.currentStock)), el('td', {}, formatMoney(p.capitalParado))]));
  });
  if (slowMoving.length === 0) slowBody.appendChild(el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'Nenhum produto parado.')));
}

// ---------- Usuários ----------
async function renderUsuarios() {
  activeTemplate('usuarios');
  document.getElementById('new-user-btn').addEventListener('click', () => openUserForm(null));
  await loadUsers();
}

async function loadUsers() {
  const seq = viewSeq;
  const users = await api.get('/users');
  if (seq !== viewSeq) return; // trocou de tela enquanto a API respondia
  const body = document.getElementById('users-list');
  body.innerHTML = '';
  users.forEach((u) => {
    body.appendChild(el('tr', {}, [
      el('td', {}, u.name),
      el('td', {}, u.email),
      el('td', {}, u.role === 'ADMIN' ? 'Administrador' : 'Funcionário'),
      el('td', {}, u.active ? 'Sim' : 'Não'),
      el('td', {}, el('button', { class: 'small secondary', type: 'button', onclick: () => openUserForm(u) }, 'Editar')),
    ]));
  });
}

function openUserForm(user) {
  const modal = openModal('tpl-user-form');
  const isEdit = Boolean(user);

  document.getElementById('user-form-title').textContent = isEdit ? 'Editar usuário' : 'Novo usuário';
  document.getElementById('u-email-label').style.display = isEdit ? 'none' : '';
  document.getElementById('u-email').style.display = isEdit ? 'none' : '';
  document.getElementById('u-email').required = !isEdit;
  document.getElementById('u-active-label').style.display = isEdit ? '' : 'none';
  document.getElementById('u-active').style.display = isEdit ? '' : 'none';
  document.getElementById('u-password-label').textContent = isEdit ? 'Nova senha (deixe em branco para manter)' : 'Senha';
  document.getElementById('u-password').required = !isEdit;

  if (isEdit) {
    document.getElementById('u-id').value = user.id;
    document.getElementById('u-name').value = user.name;
    document.getElementById('u-active').checked = user.active;
  }

  document.getElementById('user-cancel-btn').addEventListener('click', () => closeModal(modal));

  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('user-form-msg');
    msg.hidden = true;
    const password = document.getElementById('u-password').value;

    try {
      if (isEdit) {
        const payload = {
          name: document.getElementById('u-name').value,
          active: document.getElementById('u-active').checked,
        };
        if (password) payload.password = password;
        await api.put(`/users/${user.id}`, payload);
      } else {
        await api.post('/users', {
          name: document.getElementById('u-name').value,
          email: document.getElementById('u-email').value,
          password,
        });
      }
      closeModal(modal);
      await loadUsers();
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
    }
  });
}

// ---------- Leitor de código de barras (câmera) ----------
const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const SCAN_REPEAT_MS = 1500;
const CAMERA_ERRORS = {
  NotAllowedError: 'Acesso à câmera negado. Libere a câmera no cadeado da barra de endereço e tente de novo.',
  NotFoundError: 'Nenhuma câmera encontrada neste aparelho.',
  OverconstrainedError: 'Nenhuma câmera encontrada neste aparelho.',
  NotReadableError: 'A câmera está em uso por outro programa.',
};
let scanAudio = null;
let zxingLoading = null;

// UPC-A (12 dígitos) é um EAN-13 que começa com 0: conforme o leitor, o mesmo
// código chega com ou sem esse zero, e o cadastro pode ter qualquer um dos dois.
function barcodeVariants(code) {
  if (/^\d{12}$/.test(code)) return [code, `0${code}`];
  if (/^0\d{12}$/.test(code)) return [code, code.slice(1)];
  return [code];
}

async function findProductByBarcode(code) {
  for (const variant of barcodeVariants(code)) {
    const found = (await api.get(`/products?query=${encodeURIComponent(variant)}`)).find((p) => p.barcode === variant);
    if (found) return found;
  }
  return null;
}

function loadZxing() {
  zxingLoading ||= new Promise((resolve, reject) => {
    document.head.appendChild(el('script', {
      src: '/vendor/zxing/index.min.js',
      onload: resolve,
      onerror: () => { zxingLoading = null; reject(new Error('Não foi possível carregar o leitor de código de barras.')); },
    }));
  });
  return zxingLoading;
}

// Devolve read(video) → código lido ou null. BarcodeDetector nativo onde existe
// (Android, macOS, ChromeOS); Chrome e Edge no Windows não têm, e aí quem lê é o
// @zxing/library (~360 KB), baixado só na primeira vez que a câmera abre.
async function makeBarcodeReader() {
  if ('BarcodeDetector' in window) {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = SCAN_FORMATS.filter((f) => supported.includes(f));
    if (formats.length) {
      const detector = new BarcodeDetector({ formats });
      return async (video) => (await detector.detect(video))[0]?.rawValue || null;
    }
  }
  await loadZxing();
  const { BarcodeFormat, DecodeHintType } = ZXing;
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(new Map([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]],
    [DecodeHintType.TRY_HARDER, true],
  ]));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    try {
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decodeWithState(bitmap).getText();
    } catch {
      return null; // nenhum código legível neste quadro
    }
  };
}

// Bipe agudo no acerto e grave no erro, sem arquivo de áudio.
function beep(ok) {
  if (!scanAudio) return;
  const osc = scanAudio.createOscillator();
  const gain = scanAudio.createGain();
  osc.type = ok ? 'sine' : 'square';
  osc.frequency.value = ok ? 1800 : 220;
  gain.gain.value = 0.1;
  osc.connect(gain).connect(scanAudio.destination);
  osc.start();
  osc.stop(scanAudio.currentTime + (ok ? 0.12 : 0.3));
}

// onCode(code) → { ok, message }. continuous: segue lendo depois de um acerto
// (PDV); sem ele, fecha no primeiro acerto (Entrada de Estoque).
async function openScanner({ onCode, continuous = false }) {
  const backdrop = openModal('tpl-scanner');
  const video = backdrop.querySelector('#scanner-video');
  const view = backdrop.querySelector('.scanner-view');
  const status = backdrop.querySelector('#scanner-status');
  const switchBtn = backdrop.querySelector('#scanner-switch');
  const say = (text, kind = '') => { status.textContent = text; status.className = `scanner-status ${kind}`; };
  let stream = null;
  let timer = null;
  let imageTimer = null;
  let closed = false;
  // Parar a câmera cancela o diagnóstico: senão ele cobriria, 4 s depois, a mensagem do erro real.
  const stopCamera = () => { clearTimeout(imageTimer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  backdrop._onClose = () => { closed = true; clearTimeout(timer); stopCamera(); };
  backdrop.querySelector('#scanner-close').addEventListener('click', () => closeModal(backdrop));
  // Criado no clique: depois de um gesto do usuário o navegador deixa tocar o bipe.
  try { scanAudio ||= new AudioContext(); } catch { /* sem áudio: fica o aviso visual */ }

  if (!navigator.mediaDevices?.getUserMedia) {
    say(window.isSecureContext
      ? 'Este navegador não dá acesso à câmera. Use a busca ou um leitor USB.'
      : 'A câmera só funciona com o sistema aberto em https:// ou em http://localhost. Use a busca ou um leitor USB.', 'bad');
    return;
  }
  video.muted = true; // Safari do iPhone: vídeo da câmera só toca na página (playsinline) e mudo

  // Diagnóstico para o celular, onde não há inspetor à mão: se em 4 s não chegou
  // imagem, diz onde parou (vídeo travado, câmera entregando quadro preto...).
  const checkImage = () => {
    if (closed || !stream) return;
    const track = stream.getVideoTracks()[0];
    const ctx = el('canvas', { width: '32', height: '32' }).getContext('2d');
    let lit = false;
    try {
      ctx.drawImage(video, 0, 0, 32, 32);
      lit = ctx.getImageData(0, 0, 32, 32).data.some((v, i) => i % 4 !== 3 && v > 24);
    } catch { /* ainda sem quadro para desenhar */ }
    if (lit && !video.paused) return;
    const { width, height } = track.getSettings();
    say(`Câmera ligada, mas sem imagem. ${switchBtn.hidden ? 'Mande' : 'Toque em "Trocar câmera" ou mande'} um print desta mensagem. [vídeo ${video.readyState} ${video.paused ? 'pausado' : 'tocando'} ${video.videoWidth}x${video.videoHeight} · câmera "${track.label}" ${track.readyState}${track.muted ? ' muda' : ''} ${width}x${height} · quadro ${lit ? 'com imagem' : 'preto'} · som ${scanAudio ? scanAudio.state : '-'}]`, 'bad');
  };

  // Primeiro a câmera traseira; "Trocar câmera" escolhe outra lente pelo deviceId.
  const startCamera = async (deviceId) => {
    stopCamera();
    const constraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    if (closed) return stopCamera(); // fechou o modal enquanto a câmera abria
    video.srcObject = stream;
    imageTimer = setTimeout(checkImage, 4000); // antes do play(): pega também o caso de ele nunca terminar
    await video.play();
  };

  let read;
  try {
    await startCamera();
    if (closed) return;
    read = await makeBarcodeReader();
  } catch (err) {
    stopCamera();
    say(CAMERA_ERRORS[err.name] || err.message, 'bad');
    return;
  }
  say('Aponte a câmera para o código de barras.');

  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  switchBtn.hidden = cameras.length < 2;
  switchBtn.addEventListener('click', async () => {
    const current = stream.getVideoTracks()[0].getSettings().deviceId;
    const next = cameras[(cameras.findIndex((c) => c.deviceId === current) + 1) % cameras.length];
    switchBtn.disabled = true; // dois cliques seguidos abririam duas câmeras
    try {
      await startCamera(next.deviceId);
      say(`Câmera: ${next.label || 'outra câmera'}. Aponte para o código de barras.`);
    } catch (err) {
      say(CAMERA_ERRORS[err.name] || err.message, 'bad');
    } finally {
      switchBtn.disabled = false;
    }
  });

  let last = null;
  let lastSeen = 0;
  const tick = async () => {
    if (closed) return;
    try {
      const code = video.readyState >= 2 ? await read(video) : null;
      if (code && code === last && Date.now() - lastSeen < SCAN_REPEAT_MS) {
        lastSeen = Date.now(); // o mesmo produto parado na frente da câmera conta uma vez só
      } else if (code) {
        last = code;
        const result = await onCode(code);
        lastSeen = Date.now();
        if (closed) return;
        beep(result.ok);
        say(result.message, result.ok ? 'ok' : 'bad');
        view.classList.remove('hit', 'miss');
        view.classList.add(result.ok ? 'hit' : 'miss');
        setTimeout(() => view.classList.remove('hit', 'miss'), 800);
        if (result.ok && !continuous) {
          timer = setTimeout(() => closeModal(backdrop), 600); // dá tempo de ver o ✔
          return;
        }
      }
    } catch (err) {
      say(err.message, 'bad');
    }
    timer = setTimeout(tick, 100);
  };
  tick();
}

// ---------- Utils ----------
// Hoje no calendário local, no formato AAAA-MM-DD do <input type="date">.
function localDateISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
