// Wrapper de fetch: sempre envia cookies (sessão), sempre inclui o cabeçalho
// que nossa defesa anti-CSRF exige em requisições que alteram estado, e
// padroniza o tratamento de erros da API.
async function apiRequest(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  // Upload de planilha: o Content-Type do multipart precisa carregar o
  // "boundary" que o próprio navegador gera — defini-lo à mão quebraria a
  // leitura do arquivo no servidor.
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : (isFormData ? body : JSON.stringify(body)),
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text(); // texto: ex. lista de compras para o WhatsApp

  // O status vai junto no erro: quem chama distingue, por exemplo, "nenhum
  // caixa aberto" (404) de uma falha de verdade.
  const fail = (message) => Object.assign(new Error(message), { status: res.status });

  if (res.status === 401) {
    if (!location.pathname.endsWith('/index.html') && location.pathname !== '/') {
      location.href = '/index.html';
    }
    // Repassa a mensagem do servidor — no login é ela que diz se foi o
    // e-mail ou a senha que errou.
    throw fail((data && data.error) || 'Não autenticado.');
  }

  if (!res.ok) {
    throw fail((data && data.error) || `Erro (${res.status}).`);
  }

  return data;
}

const api = {
  get: (path) => apiRequest(path),
  post: (path, body) => apiRequest(path, { method: 'POST', body }),
  put: (path, body) => apiRequest(path, { method: 'PUT', body }),
  del: (path) => apiRequest(path, { method: 'DELETE' }),
};

function formatMoney(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Valor em reais digitado no balcão ("50", "7,5", "R$ 1.234,56", "12.50") em
// centavos inteiros — conta de troco sem erro de ponto flutuante. null se inválido.
function parseMoneyCents(text) {
  let s = String(text ?? '').trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// Para datas de calendário (validades), gravadas como meia-noite UTC: no fuso
// do Brasil (UTC-3) a conversão local mostrava um dia antes (31/12 virava 30/12).
function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR');
}

// Cria elementos de forma segura (sem innerHTML), evitando XSS ao exibir
// dados vindos do servidor (nomes de produtos, motivos de ajuste etc.).
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;

  // Correto para funcionar no PC e no Telemóvel:
  const API_BASE_URL = '/api';
}
