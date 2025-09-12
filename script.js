/* =========================================================
   Helsen IA - Frontend Script
   - WhatsApp (uazapi) com QR code robusto
   - Produtos, Analytics e Chatbot
   ========================================================= */

// ===== VARIÁVEIS GLOBAIS =====
let products = [];
let chartInstance = null;
let currentTab = 0;
const tabs = ['perfil', 'comportamento', 'conversa-ativacao'];

// ==== Variáveis e funções de integração com WhatsApp (uazapi) ====
let waCurrentInstance = null;
let waCurrentToken = null;
let waPollInterval = null;

// ===== BACKEND URLs =====
const BACKEND_BASE = (window.__BACKEND_BASE__ || 'https://plataforma-pac-lead-backend-production.up.railway.app').replace(/\/+$/, '');
// URL do AGENTE PackLead (permanece disponível; por padrão agora sugerimos o webhook da PLATAFORMA)
const AGENT_BACKEND_BASE = (window.__AGENT_BACKEND_BASE__ || 'https://paclead-agente-backend-production.up.railway.app').replace(/\/+$/, '');
const VISION_UPLOAD_URL = BACKEND_BASE + '/api/vision/upload';

// Define cabeçalhos padrão utilizados em todas as chamadas à API.
const defaultHeaders = (() => {
  let orgId = '1';
  let flowId = '1';
  let authHeader;
  try {
    const storedOrg = localStorage.getItem('org_id');
    const storedFlow = localStorage.getItem('flow_id');
    const token = localStorage.getItem('token');
    if (storedOrg) orgId = storedOrg;
    if (storedFlow) flowId = storedFlow;
    if (token) authHeader = `Bearer ${token}`;
  } catch (_) {}
  const headers = {
    'Content-Type': 'application/json',
    'X-Org-ID': orgId,
    'X-Flow-ID': flowId
  };
  if (authHeader) headers['Authorization'] = authHeader;
  return headers;
})();

/* =========================================================
   UTILITÁRIOS
   ========================================================= */

// Parse de lista CSV/espacos/; para array de strings
function parseList(str, def = []) {
  if (!str || typeof str !== 'string') return def.slice();
  const parts = str.split(/[,; ]+/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : def.slice();
}

/* =========================================================
   UTILITÁRIOS de QR/Status
   ========================================================= */

// Garante que exista um drawer para desenhar QR via canvas (quando vier texto)
function ensureQrDrawer() {
  let drawer = document.getElementById('wa-qr-drawer');
  if (!drawer) {
    const img = document.getElementById('wa-qr-code');
    const holder = img?.parentElement || document.getElementById('wa-instance-info');
    if (holder) {
      drawer = document.createElement('div');
      drawer.id = 'wa-qr-drawer';
      drawer.style.display = 'none';
      drawer.style.marginTop = '8px';
      holder.appendChild(drawer);
    }
  }
  return drawer;
}

// Desenha QR quando vier apenas código textual (requer qrcode.min.js)
function drawQrInto(containerEl, text) {
  if (!containerEl || !text) return;
  if (typeof QRCode === 'undefined') {
    containerEl.style.display = 'block';
    containerEl.style.padding = '8px';
    containerEl.style.background = '#111';
    containerEl.style.borderRadius = '8px';
    containerEl.innerHTML = `<small style="color:#ddd">QR code (texto):</small><pre style="white-space:pre-wrap;color:#9cd">${text}</pre>`;
    return;
  }
  containerEl.innerHTML = '';
  const canvas = document.createElement('canvas');
  QRCode.toCanvas(canvas, text, { width: 220, margin: 1 }, (err) => {
    if (err) {
      console.error('Erro ao desenhar QR:', err);
      containerEl.style.display = 'none';
      return;
    }
    containerEl.appendChild(canvas);
    containerEl.style.display = 'block';
  });
}

// Procura QR em várias chaves/estruturas (inclusive aninhadas)
function extractQrFrom(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = ['qrcode','qrCode','qr_code','qrbase64','qrBase64','code','imageUrl','image_url','dataUrl','data_url'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 5) return v;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const found = extractQrFrom(v);
      if (found) return found;
    }
  }
  return null;
}

// Normaliza o status para string amigável
function friendlyState(raw) {
  if (typeof raw === 'string') {
    const low = raw.toLowerCase();
    if (low === 'connected') return 'connected';
    if (low.includes('wait') || low.includes('qr')) return 'waiting-qr';
    return raw;
  }
  if (raw && typeof raw === 'object') {
    if (raw.connected === true && raw.loggedIn === true) return 'connected';
    if (raw.connected === true && raw.loggedIn === false) return 'waiting-qr';
    try { return JSON.stringify(raw); } catch { return 'connecting'; }
  }
  return 'connecting';
}

// Renderiza o QR: base64 (imagem) ou texto (canvas)
function renderQr(qr) {
  const img = document.getElementById('wa-qr-code');
  const drawer = ensureQrDrawer();
  if (!qr) {
    if (img) img.style.display = 'none';
    if (drawer) drawer.style.display = 'none';
    return;
  }
  if (typeof qr === 'string' && qr.startsWith('data:image')) {
    if (drawer) drawer.style.display = 'none';
    if (img) { img.src = qr; img.style.display = 'block'; }
  } else if (typeof qr === 'string') {
    if (img) img.style.display = 'none';
    if (drawer) drawQrInto(drawer, qr);
  } else {
    if (img) img.style.display = 'none';
    if (drawer) drawer.style.display = 'none';
  }
}

// Fallback: tenta buscar QR diretamente em endpoint dedicado (se existir)
async function tryFetchQrFallback() {
  if (!waCurrentInstance || !waCurrentToken) return null;
  const urlCandidates = [
    `${BACKEND_BASE}/api/wa/instances/${encodeURIComponent(waCurrentInstance)}/qr?token=${encodeURIComponent(waCurrentToken)}`,
    `${BACKEND_BASE}/api/wa/instances/${encodeURIComponent(waCurrentInstance)}/qrcode?token=${encodeURIComponent(waCurrentToken)}`
  ];
  for (const url of urlCandidates) {
    try {
      const r = await fetch(url, { headers: defaultHeaders });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      const qr = extractQrFrom(j);
      if (qr) return qr;
    } catch (_) {}
  }
  return null;
}

/* =========================================================
   WHATSAPP (uazapi)
   ========================================================= */

// Persiste/recupera a instância atual no localStorage
function persistWhatsAppInstance() {
  try {
    if (waCurrentInstance) localStorage.setItem('wa_instance', waCurrentInstance);
    if (waCurrentToken) localStorage.setItem('wa_token', waCurrentToken);
  } catch (_) {}
}
function restoreWhatsAppInstance() {
  try {
    const inst = localStorage.getItem('wa_instance');
    const tok = localStorage.getItem('wa_token');
    if (inst && tok) {
      waCurrentInstance = inst;
      waCurrentToken = tok;
      const infoDiv = document.getElementById('wa-instance-info');
      if (infoDiv) infoDiv.style.display = 'block';
      const idEl = document.getElementById('wa-instance-id');
      const tokEl = document.getElementById('wa-instance-token');
      if (idEl) idEl.value = waCurrentInstance;
      if (tokEl) tokEl.value = waCurrentToken;
      const webhookEl = document.getElementById('wa-webhook-url');
      if (webhookEl && !webhookEl.value) {
        webhookEl.value = `${BACKEND_BASE}/api/webhooks/wa/${encodeURIComponent(waCurrentInstance)}`;
      }
      if (waPollInterval) clearInterval(waPollInterval);
      updateWhatsAppStatus();
      waPollInterval = setInterval(updateWhatsAppStatus, 4000);
    }
  } catch (_) {}
}

// Cria uma nova instância via backend e já mostra o QR quando possível
async function createWhatsAppInstance() {
  const name = (document.getElementById('wa-instance-name')?.value || '').trim();
  if (!name) {
    alert('Informe um nome para a instância.');
    return;
  }
  try {
    const res = await fetch(`${BACKEND_BASE}/api/wa/instances`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error('Não autorizado (401). Verifique as variáveis do Uazapi no backend.');
      }
      throw new Error(text || 'Erro ao criar instância');
    }
    const data = await res.json();

    waCurrentInstance = data.instanceId || data.instance || data.name || name;
    waCurrentToken = data.token;

    // Preenche campos
    const infoDiv = document.getElementById('wa-instance-info');
    if (infoDiv) infoDiv.style.display = 'block';
    const idEl = document.getElementById('wa-instance-id');
    const tokEl = document.getElementById('wa-instance-token');
    if (idEl) idEl.value = waCurrentInstance || '';
    if (tokEl) tokEl.value = waCurrentToken || '';

    // >>> Ajuste: sugerir webhook da PLATAFORMA (que encaminha para o Agente e loga no banco)
    const webhookEl = document.getElementById('wa-webhook-url');
    if (webhookEl) webhookEl.value = `${BACKEND_BASE}/api/webhooks/wa/${encodeURIComponent(waCurrentInstance)}`;
    // (mantemos AGENT_BACKEND_BASE disponível se você quiser trocar manualmente)

    // Se veio payload connect, tenta mostrar QR imediatamente
    const statusEl = document.getElementById('wa-status');
    const c = data.connect || {};
    const rawState = c.status || c.state || data.status || data.state || 'connecting';
    const stateStr = friendlyState(rawState);
    if (statusEl) statusEl.textContent = stateStr;

    const initialQr = extractQrFrom(c) || extractQrFrom(data);
    renderQr(initialQr);

    // Persiste instância
    persistWhatsAppInstance();

    // Começa o polling
    if (waPollInterval) clearInterval(waPollInterval);
    await updateWhatsAppStatus();
    waPollInterval = setInterval(updateWhatsAppStatus, 4000);
  } catch (err) {
    console.error(err);
    alert('Falha ao criar instância: ' + err.message);
  }
}

// Atualiza status e QR periodicamente
async function updateWhatsAppStatus() {
  if (!waCurrentInstance || !waCurrentToken) return;
  try {
    const res = await fetch(
      `${BACKEND_BASE}/api/wa/instances/${encodeURIComponent(waCurrentInstance)}/status?token=${encodeURIComponent(waCurrentToken)}`,
      { method: 'GET', headers: defaultHeaders }
    );
    if (!res.ok) {
      console.warn('Falha ao buscar status:', await res.text());
      return;
    }
    const data = await res.json();
    const statusEl = document.getElementById('wa-status');

    const rawState =
      data.status ||
      data.state ||
      (data.instance && (data.instance.status || data.instance.state)) ||
      (data.connect && (data.connect.status || data.connect.state)) ||
      (data.session && (data.session.status || data.session.state));

    const stateStr = friendlyState(rawState);
    if (statusEl) statusEl.textContent = stateStr;

    // Se realmente conectado, encerra polling e oculta QR
    const connected =
      (typeof rawState === 'string' && rawState.toLowerCase() === 'connected') ||
      (rawState && rawState.connected === true && rawState.loggedIn !== false);

    if (connected) {
      if (waPollInterval) clearInterval(waPollInterval);
      renderQr(null);
      return;
    }

    // Quando não logado (waiting-qr), tenta mostrar QR
    const qrFromStatus = extractQrFrom(data) || extractQrFrom(data.connect || {}) || extractQrFrom(data.session || {});
    if (qrFromStatus) {
      renderQr(qrFromStatus);
    } else if (stateStr === 'waiting-qr') {
      const qrFallback = await tryFetchQrFallback();
      renderQr(qrFallback);
    } else {
      renderQr(null);
    }
  } catch (err) {
    console.error(err);
  }
}

// Define a URL de webhook para a instância atual via backend.
async function setWhatsAppWebhook() {
  if (!waCurrentInstance || !waCurrentToken) {
    alert('Crie uma instância primeiro.');
    return;
  }
  // Se o campo estiver vazio, preenche automaticamente com o endpoint da PLATAFORMA
  let url = (document.getElementById('wa-webhook-url')?.value || '').trim();
  if (!url) {
    url = `${BACKEND_BASE}/api/webhooks/wa/${encodeURIComponent(waCurrentInstance)}`;
    const webhookEl = document.getElementById('wa-webhook-url');
    if (webhookEl) webhookEl.value = url;
  }

  const eventsStr = document.getElementById('wa-events')?.value || 'messages,connection';
  const excludeStr = document.getElementById('wa-exclude-events')?.value || 'wasSentByApi,isGroupYes';
  const events = parseList(eventsStr, ['messages','connection']);
  const exclude = parseList(excludeStr, ['wasSentByApi','isGroupYes']);

  if (!url) {
    alert('Informe a URL do webhook.');
    return;
  }
  try {
    const res = await fetch(`${BACKEND_BASE}/api/wa/instances/${encodeURIComponent(waCurrentInstance)}/webhook`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        url,
        events,
        // Enviamos em várias chaves para compatibilizar com diferentes backends:
        exclude,            // nossa chave
        excludeEvents: exclude,
        ignore: exclude,
        token: waCurrentToken
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Erro ao definir webhook');
    }
    // tenta ler JSON, senão exibe texto
    let msg = 'Webhook definido com sucesso!';
    try {
      const data = await res.json();
      if (data && (data.ok || data.status === 'ok')) msg = 'Webhook definido com sucesso!';
    } catch (_) {}
    alert(msg);
  } catch (err) {
    console.error(err);
    alert('Falha ao definir webhook: ' + err.message);
  }
}

// Envia uma mensagem de teste via instância atual para um número
async function sendWhatsAppTest() {
  if (!waCurrentInstance || !waCurrentToken) {
    alert('Crie uma instância primeiro.');
    return;
  }
  const toRaw = document.getElementById('wa-test-number')?.value || '';
  const to = toRaw.trim();
  const text = document.getElementById('wa-test-message')?.value.trim();
  if (!to || !text) {
    alert('Informe o número e a mensagem.');
    return;
  }
  try {
    const res = await fetch(`${BACKEND_BASE}/api/wa/instances/${encodeURIComponent(waCurrentInstance)}/send/text`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ token: waCurrentToken, to, text })
    });
    if (!res.ok) {
      const t = await res.text();
      // Tratamento amigável de desconexão
      if (res.status === 503 && /disconnected/i.test(t)) {
        alert('WhatsApp desconectado. Escaneie o QR code para conectar e tente novamente.');
        await updateWhatsAppStatus();
        return;
      }
      throw new Error(t || 'Erro ao enviar mensagem');
    }
    alert('Mensagem enviada!');
  } catch (err) {
    console.error(err);
    alert('Falha ao enviar mensagem: ' + err.message);
  }
}

/* =========================================================
   Funções de integração com o backend (produtos/analytics etc.)
   ========================================================= */

async function fetchProducts() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/products`, { headers: defaultHeaders });
    if (!res.ok) throw new Error('Falha ao listar produtos');
    const data = await res.json();
    products = (data.items || []).map(p => {
      const price = p.price_cents ? (p.price_cents / 100) : 0;
      let img = null;
      const raw = p.image_url || p.image_base64;
      if (raw) {
        const lower = String(raw).toLowerCase();
        if (lower.startsWith('http') || lower.startsWith('data:')) {
          img = raw;
        } else if (lower.startsWith('/')) {
          img = `${BACKEND_BASE}${raw}`;
        } else {
          img = `data:image/png;base64,${raw}`;
        }
      }
      return {
        id: p.id,
        name: p.title,
        description: p.slug || '',
        category: p.category || 'Sem categoria',
        price,
        priceCents: p.price_cents || 0,
        stock: p.stock || 0,
        status: p.status || 'active',
        imageRaw: raw || '',
        image: img
      };
    });
    updateProductTable();
  } catch (err) {
    console.error(err);
    updateProductTable();
  }
}

async function createProductOnBackend(product) {
  try {
    const payload = {
      org_id: Number(defaultHeaders['X-Org-ID']),
      flow_id: Number(defaultHeaders['X-Flow-ID']),
      title: product.name,
      slug: product.description,
      status: 'active',
      image_url: product.imageUrl || '',
      price_cents: product.priceCents || 0,
      stock: product.stock || 0,
      category: product.category || ''
    };
    const res = await fetch(`${BACKEND_BASE}/api/products`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Falha ao criar produto');
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function deleteProductOnBackend(id) {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/products/${id}`, { method: 'DELETE', headers: defaultHeaders });
    if (!res.ok) throw new Error('Falha ao remover produto');
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

async function fetchAnalyticsSummary() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/analytics/summary`, { headers: defaultHeaders });
    if (!res.ok) throw new Error('Falha ao buscar resumo analítico');
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function fetchTopProducts() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/analytics/top-products`, { headers: defaultHeaders });
    if (!res.ok) throw new Error('Falha ao buscar top produtos');
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function fetchSalesByHour() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/analytics/sales-by-hour`, { headers: defaultHeaders });
    if (!res.ok) throw new Error('Falha ao buscar vendas por hora');
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function loadAnalytics() {
  const summary = await fetchAnalyticsSummary();
  if (summary) {
    const convEl = document.getElementById('conversations-count');
    const leadsEl = document.getElementById('leads-count');
    const salesEl = document.getElementById('sales-count');
    const convRateEl = document.getElementById('conversion-rate');
    if (convEl) convEl.textContent = summary.conversations;
    if (leadsEl) leadsEl.textContent = summary.leads;
    if (salesEl) salesEl.textContent = summary.sales;
    if (convRateEl) convRateEl.textContent = (summary.conversion_rate || 0).toFixed(1) + '%';
    const recoveredEl = document.getElementById('recovered-leads-value');
    const timeEl = document.getElementById('best-time-range');
    const topProductEl = document.getElementById('top-product-name');
    if (recoveredEl) recoveredEl.textContent = summary.recovered_leads;
    if (timeEl) timeEl.textContent = summary.best_time_range;
    if (topProductEl) topProductEl.textContent = summary.top_product;
  }
  await createPerformanceChart();
}

async function uploadImage(file) {
  if (!file) return null;
  const formData = new FormData();
  formData.append('image', file);
  const headers = {
    'X-Org-ID': defaultHeaders['X-Org-ID'],
    'X-Flow-ID': defaultHeaders['X-Flow-ID']
  };
  if (defaultHeaders['Authorization']) headers['Authorization'] = defaultHeaders['Authorization'];
  const res = await fetch(`${BACKEND_BASE}/api/upload`, { method: 'POST', headers, body: formData });
  if (!res.ok) throw new Error('Falha ao enviar imagem');
  const data = await res.json();
  return data.url;
}

// ===== DADOS EXEMPLO =====
const sampleData = {
  conversations: [
    { id: 1, date: '2023-10-27', lastMessage: 'Olá, gostaria de saber mais sobre...', status: 'Aberta' },
    { id: 2, date: '2023-10-26', lastMessage: 'Qual o valor do frete?', status: 'Fechada' },
    { id: 3, date: '2023-10-25', lastMessage: 'Preciso de ajuda com o produto', status: 'Aberta' },
    { id: 4, date: '2023-10-24', lastMessage: 'Obrigado pelo atendimento!', status: 'Fechada' },
  ],
  leads: [
    { name: 'João Silva', phone: '(11) 98765-4321', lastMessageDate: '2023-10-27', category: 'Lead' },
    { name: 'Maria Oliveira', phone: '(21) 91234-5678', lastMessageDate: '2023-10-26', category: 'Lead Qualificado' },
    { name: 'Carlos Pereira', phone: '(31) 99876-5432', lastMessageDate: '2023-10-25', category: 'Lead Quente' },
    { name: 'Ana Souza', phone: '(41) 98765-1234', lastMessageDate: '2023-10-24', category: 'Prospectivos Clientes' },
    { name: 'Pedro Costa', phone: '(51) 91234-9876', lastMessageDate: '2023-10-23', category: 'Cliente' },
    { name: 'Fernanda Lima', phone: '(85) 99887-6543', lastMessageDate: '2023-10-22', category: 'Lead' },
    { name: 'Roberto Santos', phone: '(62) 98765-4321', lastMessageDate: '2023-10-21', category: 'Lead Qualificado' },
    { name: 'Juliana Rocha', phone: '(47) 91234-5678', lastMessageDate: '2023-10-20', category: 'Lead Quente' },
  ],
  sales: [
    { id: 101, product: 'Smartphone XYZ', value: 1250.00, date: '2023-10-25' },
    { id: 102, product: 'Fone de Ouvido ABC', value: 350.00, date: '2023-10-24' },
    { id: 103, product: 'Notebook Pro', value: 2800.00, date: '2023-10-23' },
    { id: 104, product: 'Smartwatch Elite', value: 899.00, date: '2023-10-22' },
  ],
  satisfaction: [
    { id: 201, rating: 5, comment: 'Atendimento excelente!', date: '2023-10-23' },
    { id: 202, rating: 4, comment: 'Bom, mas poderia ser mais rápido.', date: '2023-10-22' },
    { id: 203, rating: 5, comment: 'Muito satisfeito com o produto.', date: '2023-10-21' },
    { id: 204, rating: 3, comment: 'Atendimento regular.', date: '2023-10-20' },
  ]
};

// ===== SEÇÕES =====
function showSection(sectionId) {
  const sections = document.querySelectorAll('.content-section');
  sections.forEach(section => { section.style.display = 'none'; });
  const targetSection = document.getElementById(sectionId);
  if (targetSection) targetSection.style.display = 'block';
  const navLinks = document.querySelectorAll('.nav-sidebar .nav-link');
  navLinks.forEach(link => { link.classList.remove('active'); });
  const activeLink = document.querySelector(`[onclick="showSection('${sectionId}')"]`);
  if (activeLink) activeLink.classList.add('active');
  if (sectionId === 'analysis') setTimeout(createPerformanceChart, 100);
  if (sectionId === 'company') { try { loadCompany(); } catch (_) {} }

  try {
    const pathMap = {
      'agent-config': '/agente',
      'analysis': '/analise',
      'products': '/produtos',
      'payments': '/pagamentos',
      'company': '/empresa',
      'users': '/usuarios',
      'wa': '/whatsapp'
    };
    const newPath = pathMap[sectionId];
    if (newPath && history.pushState) history.pushState(null, '', newPath);
  } catch (_) {}
}

// Atualiza saudações com o nome do usuário + ações da Empresa
document.addEventListener('DOMContentLoaded', () => {
  try {
    const name = (localStorage.getItem('user_name') || '').toUpperCase();
    document.querySelectorAll('.user-name').forEach(el => { el.textContent = name; });
  } catch (_) {}

  // Busca CNPJ
  const cnpjButtons = document.querySelectorAll('.company-cnpj-search-btn');
  const cnpjInput = document.getElementById('company-cnpj');
  if (cnpjButtons.length && cnpjInput) {
    cnpjButtons.forEach(btn => {
      btn.addEventListener('click', async () => {
        const raw = cnpjInput.value || '';
        const digits = raw.replace(/\D/g, '');
        if (digits.length !== 14) { alert('CNPJ inválido. Digite um número com 14 dígitos.'); return; }
        cnpjButtons.forEach(b => b.disabled = true);
        const originalTexts = Array.from(cnpjButtons).map(b => b.textContent);
        cnpjButtons.forEach((b, idx) => { if (!b.classList.contains('d-sm-none')) b.textContent = 'Buscando...'; });
        try {
          const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`);
          if (!res.ok) throw new Error('Falha na requisição');
          const data = await res.json();
          const setValue = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
          setValue('company-razao', data.razao_social);
          setValue('company-fantasia', data.nome_fantasia);
          if (data.ddd_telefone_1) setValue('company-phone', data.ddd_telefone_1);
          setValue('company-email', data.email);
          const endereco = [data.logradouro, data.complemento].filter(Boolean).join(' ');
          setValue('company-endereco', endereco);
          setValue('company-numero', data.numero);
          setValue('company-bairro', data.bairro);
          setValue('company-cidade', data.municipio);
          setValue('company-cep', data.cep);
          const ufSelect = document.getElementById('company-uf');
          if (ufSelect && data.uf) ufSelect.value = data.uf;
        } catch (err) {
          console.error(err);
          alert('Não foi possível buscar os dados do CNPJ.');
        } finally {
          cnpjButtons.forEach((b, idx) => {
            b.disabled = false;
            if (!b.classList.contains('d-sm-none')) b.textContent = originalTexts[idx] || 'Buscar CNPJ';
          });
        }
      });
    });
  }

  // Salvar empresa
  const saveBtn = document.getElementById('company-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const getVal = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
      const payload = {
        name: null,
        tax_id: getVal('company-cnpj').replace(/\D/g, '') || null,
        razao_social: getVal('company-razao') || null,
        nome_fantasia: getVal('company-fantasia') || null,
        inscricao_estadual: getVal('company-insc') || null,
        segmento: getVal('company-segment') || null,
        telefone: getVal('company-phone') || null,
        email: getVal('company-email') || null,
        bairro: getVal('company-bairro') || null,
        endereco: getVal('company-endereco') || null,
        numero: getVal('company-numero') || null,
        cep: getVal('company-cep') || null,
        cidade: getVal('company-cidade') || null,
        uf: getVal('company-uf') || null,
        observacoes: getVal('company-observacoes') || null
      };
      try {
        const res = await fetch(`${BACKEND_BASE}/api/company`, {
          method: 'PUT',
          headers: defaultHeaders,
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Falha ao salvar dados da empresa');
        alert('Dados da empresa salvos com sucesso!');
      } catch (err) {
        console.error(err);
        alert('Não foi possível salvar os dados da empresa.');
      }
    });
  }
});

// Função de logout
function logout() {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('org_id');
    localStorage.removeItem('flow_id');
    localStorage.removeItem('user_name');
  } catch (_) {}
  window.location.href = 'login.html';
}

// ===== ABAS =====
function nextTab() { if (currentTab < tabs.length - 1) { currentTab++; navigateToTab(tabs[currentTab]); } }
function previousTab() { if (currentTab > 0) { currentTab--; navigateToTab(tabs[currentTab]); } }
function navigateToTab(tabId) {
  currentTab = tabs.indexOf(tabId);
  document.querySelectorAll('.nav-tabs .nav-link').forEach(l => l.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('show','active'));
  const targetTab = document.getElementById(`${tabId}-tab`);
  const targetPane = document.getElementById(tabId);
  if (targetTab && targetPane) { targetTab.classList.add('active'); targetPane.classList.add('show','active'); }
  updateNavigationButtons();
}
function updateNavigationButtons() {
  const prevButtons = document.querySelectorAll('[onclick="previousTab()"]');
  const nextButtons = document.querySelectorAll('[onclick="nextTab()"]');
  prevButtons.forEach(btn => { btn.disabled = currentTab === 0; });
  nextButtons.forEach(btn => { btn.style.display = currentTab === tabs.length - 1 ? 'none' : 'inline-flex'; });
}

// ===== COMPORTAMENTO =====
function toggleWhatsAppConfig() {
  const checkbox = document.getElementById('whatsapp-notification');
  const config = document.getElementById('whatsapp-config');
  if (checkbox && config) config.style.display = checkbox.checked ? 'block' : 'none';
}
function toggleSiteLinkConfig() {
  const checkbox = document.getElementById('site-link');
  const config = document.getElementById('site-link-config');
  if (checkbox && config) config.style.display = checkbox.checked ? 'block' : 'none';
}
function toggleProductLinkConfig() {
  const checkbox = document.getElementById('product-link');
  const config = document.getElementById('product-link-config');
  if (checkbox && config) config.style.display = checkbox.checked ? 'block' : 'none';
}

// Carrega os dados da empresa
async function loadCompany() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/company`, { headers: defaultHeaders });
    if (!res.ok) throw new Error('Falha ao carregar empresa');
    const data = await res.json();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('company-razao', data.razao_social || data.name || '');
    setVal('company-fantasia', data.nome_fantasia || '');
    setVal('company-cnpj', data.tax_id || '');
    setVal('company-insc', data.inscricao_estadual || '');
    setVal('company-segment', data.segmento || '');
    setVal('company-phone', data.telefone || '');
    setVal('company-email', data.email || '');
    setVal('company-bairro', data.bairro || '');
    setVal('company-endereco', data.endereco || '');
    setVal('company-numero', data.numero || '');
    setVal('company-cep', data.cep || '');
    setVal('company-cidade', data.cidade || '');
    const ufSelect = document.getElementById('company-uf');
    if (ufSelect && data.uf) ufSelect.value = data.uf;
    setVal('company-observacoes', data.observacoes || '');
  } catch (err) {
    console.error(err);
  }
}

// ===== PERFIL =====
function saveProfile() {
  // (incremento) persiste o perfil (reutiliza saveAgentConfig localStorage)
  try { saveAgentConfig(); } catch (_) {}
  const modal = new bootstrap.Modal(document.getElementById('successModal'));
  modal.show();
}

// ===== MODAIS =====
function openMetricModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
    populateModalTable(modalId);
  }
}
function closeMetricModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 300);
  }
}
function populateModalTable(modalId, categoryFilter = 'all') {
  let data, tableBodyId, renderFunction;
  switch (modalId) {
    case 'conversations-modal':
      data = sampleData.conversations;
      tableBodyId = 'conversations-table-body';
      renderFunction = (item) => `
        <tr>
          <td>#${item.id}</td>
          <td>${item.date}</td>
          <td>${item.lastMessage}</td>
          <td><span class="badge badge-${item.status === 'Aberta' ? 'success' : 'secondary'}">${item.status}</span></td>
        </tr>`;
      break;
    case 'leads-modal':
      data = sampleData.leads;
      tableBodyId = 'leads-table-body';
      let filteredLeads = categoryFilter === 'all' ? data : data.filter(lead => lead.category === categoryFilter);
      renderFunction = (item) => {
        let badgeClass = 'badge-secondary';
        switch (item.category) {
          case 'Lead': badgeClass = 'badge-lead'; break;
          case 'Lead Qualificado': badgeClass = 'badge-lead-qualificado'; break;
          case 'Lead Quente': badgeClass = 'badge-lead-quente'; break;
          case 'Prospectivos Clientes': badgeClass = 'badge-prospectivos'; break;
          case 'Cliente': badgeClass = 'badge-cliente'; break;
        }
        return `
          <tr>
            <td>${item.name}</td>
            <td>${item.phone}</td>
            <td>${item.lastMessageDate}</td>
            <td><span class="badge ${badgeClass}">${item.category}</span></td>
          </tr>`;
      };
      data = filteredLeads;
      break;
    case 'sales-modal':
      data = sampleData.sales;
      tableBodyId = 'sales-table-body';
      renderFunction = (item) => `
        <tr>
          <td>#${item.id}</td>
          <td>${item.product}</td>
          <td>R$ ${item.value.toFixed(2)}</td>
          <td>${item.date}</td>
        </tr>`;
      break;
    case 'satisfaction-modal':
      data = sampleData.satisfaction;
      tableBodyId = 'satisfaction-table-body';
      renderFunction = (item) => `
        <tr>
          <td>#${item.id}</td>
          <td>${"⭐".repeat(item.rating)}</td>
          <td>${item.comment}</td>
          <td>${item.date}</td>
        </tr>`;
      break;
    default: return;
  }
  const tableBody = document.getElementById(tableBodyId);
  if (tableBody) tableBody.innerHTML = data.map(renderFunction).join('');
}
function filterTable(modalId, searchTerm) {
  const tableBodyId = modalId.replace('-modal', '-table-body');
  const tableBody = document.getElementById(tableBodyId);
  if (!tableBody) return;
  const rows = tableBody.getElementsByTagName('tr');
  const filter = searchTerm.toUpperCase();
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].getElementsByTagName('td');
    let found = false;
    for (let j = 0; j < cells.length; j++) {
      const cellText = cells[j].textContent || cells[j].innerText;
      if (cellText.toUpperCase().indexOf(filter) > -1) { found = true; break; }
    }
    rows[i].style.display = found ? '' : 'none';
  }
}

// ===== PRODUTOS =====
async function addProduct() {
  const form = document.getElementById("product-form");
  const imgFile = form.querySelector("#product-image").files[0];
  const name = form.querySelector("#product-name").value.trim();
  const price = parseFloat(form.querySelector("#product-price").value);
  const category = form.querySelector("#product-category").value;
  const description = form.querySelector("#product-description").value.trim();

  if (!name) { showNotification("Por favor, insira o nome do produto.", "warning"); return; }
  if (!price || price <= 0) { showNotification("Por favor, insira um preço válido.", "warning"); return; }
  if (!description) { showNotification("Por favor, descreva o produto.", "warning"); return; }

  let uploadedUrl = null;
  if (imgFile) {
    try {
      uploadedUrl = await uploadImage(imgFile);
    } catch (err) {
      console.error(err);
      showNotification("Erro ao enviar imagem.", "danger");
      return;
    }
  }
  const product = {
    id: Date.now(),
    name,
    price,
    category: category || "Sem categoria",
    description,
    image: imgFile ? URL.createObjectURL(imgFile) : null,
    imageUrl: uploadedUrl || '',
    priceCents: Math.round(price * 100),
    stock: 0,
  };

  const created = await createProductOnBackend(product);
  if (created) {
    showNotification("Produto adicionado com sucesso!", "success");
    // (incremento) esconder o modal após sucesso
    try {
      const modalEl = document.getElementById('addProductModal');
      if (modalEl) (bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl)).hide();
    } catch (_) {}
  } else {
    showNotification("Erro ao adicionar produto.", "danger");
  }
  form.reset();
  await fetchProducts();
}
function updateProductTable() {
  const tbody = document.getElementById("product-list");
  if (!tbody) return;
  if (!products || products.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center text-muted py-4">
          <i class="fas fa-box-open fa-2x mb-2"></i><br>
          Nenhum produto cadastrado ainda
        </td>
      </tr>`;
    return;
  }
  tbody.innerHTML = products.map(product => `
    <tr>
      <td class="d-none d-md-table-cell">
        ${product.image ?
          `<img src="${product.image}" alt="${product.name}" class="product-image">` :
          `<div class="product-placeholder"><i class="fas fa-image"></i></div>`
        }
      </td>
      <td>
        <strong>${product.name}</strong><br>
        <small class="text-muted">${product.description}</small>
      </td>
      <td class="d-none d-lg-table-cell"><span class="badge badge-primary">${product.category}</span></td>
      <td><span class="price-tag">R$ ${product.price.toFixed(2)}</span></td>
      <td class="d-none d-sm-table-cell"><span class="badge ${product.status === 'active' ? 'badge-success' : 'badge-secondary'}">${product.status === 'active' ? 'Ativo' : 'Inativo'}</span></td>
      <td>
        <button class="btn btn-sm btn-outline-primary" onclick="openEditProduct(${product.id})" title="Editar produto"><i class="fas fa-edit"></i></button>
        <button class="btn btn-sm btn-outline-danger" onclick="removeProduct(${product.id})" title="Remover produto"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join("");
}

// ==== UTILITÁRIOS DE CONVERSÃO ====
function centsToReais(cents) {
  if (!cents || isNaN(cents)) return '0,00';
  return (cents / 100).toFixed(2).replace('.', ',');
}
function reaisToCents(value) {
  if (value === null || value === undefined) return 0;
  let str = String(value).trim();
  if (str === '') return 0;
  str = str.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(str);
  if (isNaN(num) || num < 0) return 0;
  return Math.round(num * 100);
}

// ==== EDIÇÃO DE PRODUTOS ====
async function updateProductOnBackend(id, product) {
  try {
    const payload = { title: product.name, slug: '', category: product.category || '' };
    if (typeof product.priceCents === 'number' && !isNaN(product.priceCents)) {
      payload.price_cents = product.priceCents;
    } else {
      payload.price_cents = null;
    }
    const res = await fetch(`${BACKEND_BASE}/api/products/${id}`, {
      method: 'PUT',
      headers: defaultHeaders,
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Falha ao atualizar produto');
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}
function openEditProduct(id) {
  const product = products.find(p => p.id === id);
  if (!product) { console.warn('Produto não encontrado para edição', id); return; }
  document.getElementById('edit-product-id').value = product.id;
  document.getElementById('edit-product-name').value = product.name || '';
  document.getElementById('edit-product-price').value = (product.price != null ? product.price.toFixed(2) : '');
  document.getElementById('edit-product-category').value = product.category || '';
  const modalEl = document.getElementById('editProductModal');
  if (modalEl) { const modal = new bootstrap.Modal(modalEl); modal.show(); }
}
async function saveEditProduct() {
  const id = parseInt(document.getElementById('edit-product-id').value, 10);
  const name = document.getElementById('edit-product-name').value.trim();
  const priceStr = document.getElementById('edit-product-price').value.trim();
  const category = document.getElementById('edit-product-category').value.trim();
  const priceCents = reaisToCents(priceStr);
  if (!name) { showNotification('O nome do produto é obrigatório.', 'warning'); return; }
  const updated = { name, category, priceCents };
  const ok = await updateProductOnBackend(id, updated);
  if (ok) { showNotification('Produto atualizado com sucesso!', 'success'); }
  else { showNotification('Erro ao atualizar produto.', 'danger'); }
  const modalEl = document.getElementById('editProductModal');
  if (modalEl) { const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl); modal.hide(); }
  await fetchProducts();
}
async function removeProduct(productId) {
  if (confirm("Tem certeza que deseja remover este produto?")) {
    const ok = await deleteProductOnBackend(productId);
    if (ok) showNotification("Produto removido com sucesso!", "info");
    else showNotification("Erro ao remover produto.", "danger");
    await fetchProducts();
  }
}

// ===== NOTIFICAÇÕES =====
function showNotification(message, type = "info") {
  const existingNotification = document.querySelector(".notification");
  if (existingNotification) existingNotification.remove();
  const notification = document.createElement("div");
  notification.className = `notification alert alert-${type} alert-dismissible fade show`;
  notification.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 9999; min-width: 300px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `;
  notification.innerHTML = `
    <div class="d-flex align-items-center">
      <i class="fas fa-${getNotificationIcon(type)} mr-2"></i>
      <span>${message}</span>
      <button type="button" class="close ml-auto" onclick="this.parentElement.parentElement.remove()">
        <span>&times;</span>
      </button>
    </div>
  `;
  document.body.appendChild(notification);
  setTimeout(() => { if (notification.parentElement) notification.remove(); }, 5000);
}
function getNotificationIcon(type) {
  const icons = { success: "check-circle", warning: "exclamation-triangle", danger: "exclamation-circle", info: "info-circle" };
  return icons[type] || "info-circle";
}

// ===== GRÁFICO =====
async function createPerformanceChart() {
  const ctx = document.getElementById("performanceChart");
  if (!ctx) return;
  if (chartInstance) chartInstance.destroy();
  let labels = [];
  let conversions = [];
  let leadsData = [];
  try {
    const res = await fetchSalesByHour();
    if (res && Array.isArray(res.items) && res.items.length > 0) {
      labels = res.items.map(item => {
        const d = new Date(item.t);
        return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      });
      conversions = res.items.map(item => Number(item.c));
      leadsData = conversions.map(c => Math.round(c * 1.5));
    } else {
      labels = ["Semana 1","Semana 2","Semana 3","Semana 4","Semana 5","Semana 6"];
      conversions = [12,19,8,15,22,18];
      leadsData = [8,12,15,10,18,14];
    }
  } catch (err) {
    console.error(err);
    labels = ["Semana 1","Semana 2","Semana 3","Semana 4","Semana 5","Semana 6"];
    conversions = [12,19,8,15,22,18];
    leadsData = [8,12,15,10,18,14];
  }
  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Conversões",
          data: conversions,
          borderColor: "#007bff",
          backgroundColor: "rgba(0, 123, 255, 0.1)",
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#007bff",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8
        },
        {
          label: "Leads",
          data: leadsData,
          borderColor: "#28a745",
          backgroundColor: "rgba(40, 167, 69, 0.1)",
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#28a745",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            padding: 20,
            font: { family: "Inter", size: 12 },
            color: "#ffffff"
          }
        },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          titleColor: "#ffffff",
          bodyColor: "#ffffff",
          borderColor: "#007bff",
          borderWidth: 1,
          cornerRadius: 8,
          displayColors: true,
          intersect: false,
          mode: "index"
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { family: "Inter", size: 11 }, color: "#a0a0a0" }
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(255, 255, 255, 0.1)" },
          ticks: { font: { family: "Inter", size: 11 }, color: "#a0a0a0" }
        }
      },
      interaction: { intersect: false, mode: "index" },
      elements: { point: { hoverBackgroundColor: "#ffffff" } }
    }
  });
}

// ===== INICIALIZAÇÃO =====
document.addEventListener('DOMContentLoaded', function() {
  loadAgentConfig();
  updateNavigationButtons();
  document.querySelectorAll('.nav-tabs .nav-link').forEach(tab => {
    tab.addEventListener('click', function(e) {
      e.preventDefault();
      const targetId = this.getAttribute('data-bs-target').replace('#', '');
      navigateToTab(targetId);
    });
  });
  document.addEventListener('click', function(e) {
    if (e.target.classList.contains('modal')) closeMetricModal(e.target.id);
  });
  if (document.getElementById('analysis').style.display !== 'none') {
    createPerformanceChart();
  }
  // Restaura instância WA se existir
  restoreWhatsAppInstance();

  fetchProducts();
  loadAnalytics();
  console.log('Sistema Helsen IA inicializado com sucesso!');
});

// ===== FORM AGENTE =====
function validateAgentForm() {
  const form = document.getElementById("agent-config-form");
  const name = form.querySelector("#agent-name").value.trim();
  if (!name) { showNotification("Por favor, insira o nome do agente.", "warning"); return false; }
  return true;
}
function saveAgentConfig() {
  if (!validateAgentForm()) return;
  const form = document.getElementById("agent-config-form");
  const config = {
    name: form.querySelector("#agent-name").value.trim(),
    communicationStyle: form.querySelector("#communication-style").value,
    sector: form.querySelector("#agent-sector").value,
    profileType: form.querySelector("#agent-profile-type").value,
    profileCustom: form.querySelector("#agent-profile-custom").value.trim()
  };
  localStorage.setItem("agentConfig", JSON.stringify(config));
  showNotification("Configurações salvas com sucesso!", "success");
}
function loadAgentConfig() {
  const savedConfig = localStorage.getItem("agentConfig");
  if (!savedConfig) return;
  try {
    const config = JSON.parse(savedConfig);
    const form = document.getElementById("agent-config-form");
    if (form) {
      form.querySelector("#agent-name").value = config.name || "";
      form.querySelector("#communication-style").value = config.communicationStyle || "";
      form.querySelector("#agent-sector").value = config.sector || "";
      form.querySelector("#agent-profile-type").value = config.profileType || "";
      form.querySelector("#agent-profile-custom").value = config.profileCustom || "";
    }
  } catch (error) {
    console.error("Erro ao carregar configurações:", error);
  }
}

// ===== CHATBOT =====
class Chatbot {
  constructor() {
    this.webhookUrl = BACKEND_BASE + '/api/chat';
    this.isOpen = false;
    this.isTyping = false;
    this.sessionId = this.generateSessionId();
    this.pendingImageFile = null;

    // memória volátil
    this.history = [];
    this.maxHistory = 20;

    this.init();
  }

  generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  bindOnce(el, evt, handler) {
    if (!el || !evt || !handler) return;
    const key = `__bound_${evt}`;
    if (el.dataset && el.dataset[key]) return;
    el.addEventListener(evt, handler);
    if (el.dataset) el.dataset[key] = '1';
  }

  init() {
    this.bindEvents();
    this.addInitialMessage();
    this.ensureAttachmentControls();
  }

  ensureAttachmentControls() {
    const container = document.querySelector('.chatbot-input-container');
    if (!container) return;

    let imgBtn = document.getElementById('chatbot-image-btn');
    let imgInput = document.getElementById('chatbot-image-input');
    let preview = document.getElementById('chatbot-attachment-preview');

    if (!imgBtn) {
      imgBtn = document.createElement('button');
      imgBtn.id = 'chatbot-image-btn';
      imgBtn.type = 'button';
      imgBtn.className = 'chatbot-send-btn';
      imgBtn.innerHTML = '<i class="fas fa-image"></i>';
      container.insertBefore(imgBtn, container.firstChild);
    }
    if (!imgInput) {
      imgInput = document.createElement('input');
      imgInput.type = 'file';
      imgInput.id = 'chatbot-image-input';
      imgInput.accept = 'image/*';
      imgInput.style.display = 'none';
      container.appendChild(imgInput);
    }
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'chatbot-attachment-preview';
      preview.style.cssText = 'position:absolute; bottom:68px; right:20px; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:8px; padding:8px 10px; display:none; align-items:center; gap:8px; box-shadow:0 4px 12px rgba(0,0,0,.25);';
      preview.innerHTML = '<span style="font-size:.85rem;color:#ddd">Imagem anexada</span> <button type="button" id="chatbot-attachment-remove" class="btn btn-sm btn-outline-secondary" style="padding:.15rem .4rem;">remover</button>';
      const win = document.getElementById('chatbot-window');
      if (win) { win.style.position = 'relative'; win.appendChild(preview); }
    }

    this.bindOnce(imgBtn, 'click', () => imgInput.click());
    this.bindOnce(imgInput, 'change', () => {
      const file = imgInput.files && imgInput.files[0];
      if (!file) return;
      if (!file.type || !file.type.startsWith('image/')) {
        this.addMessage('Arquivo inválido. Selecione uma imagem.', 'bot');
        imgInput.value = '';
        return;
      }
      this.pendingImageFile = file;
      this.showAttachmentPreview();
      this.addImageBubble(URL.createObjectURL(file), 'user');
      imgInput.value = '';
    });
    const removeBtn = document.getElementById('chatbot-attachment-remove');
    this.bindOnce(removeBtn, 'click', () => {
      this.pendingImageFile = null;
      this.hideAttachmentPreview();
    });
  }

  showAttachmentPreview() {
    const el = document.getElementById('chatbot-attachment-preview');
    if (el) el.style.display = 'flex';
  }
  hideAttachmentPreview() {
    const el = document.getElementById('chatbot-attachment-preview');
    if (el) el.style.display = 'none';
  }

  bindEvents() {
    const toggle = document.getElementById('chatbot-toggle');
    const close = document.getElementById('chatbot-close');
    const input = document.getElementById('chatbot-input');
    const sendBtn = document.getElementById('chatbot-send');

    this.bindOnce(toggle, 'click', () => this.toggleChat());
    this.bindOnce(close, 'click', () => this.closeChat());
    this.bindOnce(input, 'keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.bindOnce(sendBtn, 'click', () => this.sendMessage());
  }

  toggleChat() {
    const windowEl = document.getElementById('chatbot-window');
    const container = document.querySelector('.chatbot-container');
    if (!windowEl) return;
    if (this.isOpen) {
      windowEl.classList.remove('show');
      this.isOpen = false;
      if (container) container.classList.remove('open');
    } else {
      windowEl.classList.add('show');
      this.isOpen = true;
      if (container) container.classList.add('open');
      setTimeout(() => {
        const input = document.getElementById('chatbot-input');
        if (input) input.focus();
      }, 300);
    }
  }
  openChat(){ if (!this.isOpen) this.toggleChat(); }
  closeChat(){ if (this.isOpen) this.toggleChat(); }

  addInitialMessage(){ /* opcional */ }

  _pushHistory(role, content){
    this.history.push({ role, content, ts: Date.now() });
    if (this.history.length > this.maxHistory) this.history = this.history.slice(-this.maxHistory);
  }
  clearMemory(){ this.history = []; showNotification('Memória do chat limpa.','info'); }

  async sendMessage() {
    const input = document.getElementById('chatbot-input');
    const raw = input.value || '';
    const message = raw.trim();
    if (this.isTyping) return;

    const hasPendingImage = !!this.pendingImageFile;
    if (!message && !hasPendingImage) return;

    if (message) {
      this.addMessage(message, 'user');
      this._pushHistory('user', message);
    }
    input.value = '';
    input.blur();

    this.showTypingIndicator();

    try {
      if (hasPendingImage) {
        const fileToSend = this.pendingImageFile;
        this.pendingImageFile = null;
        this.hideAttachmentPreview();
        await this.sendImageFile(fileToSend);
      } else {
        const dynHeaders = (() => {
          let orgId = '1';
          let flowId = '1';
          let authHeader;
          try {
            const storedOrg = localStorage.getItem('org_id');
            const storedFlow = localStorage.getItem('flow_id');
            const token = localStorage.getItem('token');
            if (storedOrg) orgId = storedOrg;
            if (storedFlow) flowId = storedFlow;
            if (token) authHeader = `Bearer ${token}`;
          } catch (_) {}
          const h = { 'Content-Type': 'application/json', 'X-Org-ID': orgId, 'X-Flow-ID': flowId };
          if (authHeader) h['Authorization'] = authHeader;
          return h;
        })();

        const normalizedHistory = this.history
          .slice(-this.maxHistory)
          .map(({ role, content }) => ({ role, content }));

        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: dynHeaders,
          body: JSON.stringify({
            message,
            history: normalizedHistory,
            sessionId: this.sessionId,
            timestamp: new Date().toISOString()
          })
        });
        if (!response.ok) throw new Error('Erro na resposta do servidor');
        const data = await response.json();

        this.hideTypingIndicator();

        if (data && data.product) {
          try { fetchProducts(); } catch (_) {}
        }

        const text =
          (data && (data.reply || data.output || data.message || data.text || data.content
            || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content))) || 'OK.';

        this.addMessage(text, 'bot');
        this._pushHistory('assistant', text);
      }
    } catch (error) {
      console.error('Erro ao enviar:', error);
      this.hideTypingIndicator();
      this.addMessage('Desculpe, ocorreu um erro. Tente novamente em alguns instantes.', 'bot');
      this._pushHistory('assistant', '[erro]');
    }
  }

  addMessage(text, sender) {
    const messagesContainer = document.getElementById('chatbot-messages');
    if (!messagesContainer) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;
    const now = new Date();
    const timeString = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    messageDiv.innerHTML = `
      <div class="message-content">
        <p>${this.escapeHtml(text)}</p>
      </div>
      <div class="message-time">${timeString}</div>
    `;
    messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();
  }

  addImageBubble(src, sender) {
    const messagesContainer = document.getElementById('chatbot-messages');
    if (!messagesContainer) return;
    const wrap = document.createElement('div');
    wrap.className = `message ${sender}-message`;
    const now = new Date();
    const timeString = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    wrap.innerHTML = `
      <div class="message-content">
        <img src="${src}" alt="Imagem" style="max-width:220px; border-radius:8px; display:block;">
      </div>
      <div class="message-time">${timeString}</div>
    `;
    messagesContainer.appendChild(wrap);
    this.scrollToBottom();
  }

  async sendImageFile(file, prompt = '') {
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('image', file, file.name || 'image.png');
      fd.append('prompt', prompt);
      fd.append('sessionId', this.sessionId);
      fd.append('history', JSON.stringify(this.history.slice(-this.maxHistory)));

      const dynHeaders = (() => {
        let orgId = '1';
        let flowId = '1';
        let authHeader;
        try {
          const storedOrg = localStorage.getItem('org_id');
          const storedFlow = localStorage.getItem('flow_id');
          const token = localStorage.getItem('token');
          if (storedOrg) orgId = storedOrg;
          if (storedFlow) flowId = storedFlow;
          if (token) authHeader = `Bearer ${token}`;
        } catch (_) {}
        const h = { 'X-Org-ID': orgId, 'X-Flow-ID': flowId };
        if (authHeader) h['Authorization'] = authHeader;
        return h;
      })();

      const resp = await fetch(VISION_UPLOAD_URL, { method: 'POST', headers: dynHeaders, body: fd });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();

      this.hideTypingIndicator();

      if (data && data.image_url) this.addImageBubble(data.image_url, 'bot');

      const text =
        (data && (data.reply || data.output || data.message || data.text || data.content
          || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content))) || 'Imagem recebida.';

      this.addMessage(text, 'bot');
      this._pushHistory('assistant', text);
    } catch (e) {
      console.error(e);
      this.hideTypingIndicator();
      this.addMessage('Erro ao analisar a imagem.', 'bot');
      this._pushHistory('assistant', '[erro imagem]');
    }
  }

  showTypingIndicator() {
    if (this.isTyping) return;
    this.isTyping = true;
    const messagesContainer = document.getElementById('chatbot-messages');
    if (!messagesContainer) return;
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message bot-message';
    typingDiv.id = 'typing-indicator';
    typingDiv.innerHTML = `
      <div class="typing-indicator">
        <div class="typing-dots">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    `;
    messagesContainer.appendChild(typingDiv);
    this.scrollToBottom();
    const sendBtn = document.getElementById('chatbot-send');
    if (sendBtn) sendBtn.disabled = true;
  }

  hideTypingIndicator() {
    this.isTyping = false;
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) typingIndicator.remove();
    const sendBtn = document.getElementById('chatbot-send');
    if (sendBtn) sendBtn.disabled = false;
  }

  scrollToBottom() {
    const messagesContainer = document.getElementById('chatbot-messages');
    if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Inicialização
document.addEventListener('DOMContentLoaded', function() {
  updateProductTable();
  updateNavigationButtons();
  window.chatbot = new Chatbot();

  const saveEditBtn = document.getElementById('save-edit-product-btn');
  if (saveEditBtn) saveEditBtn.addEventListener('click', saveEditProduct);
});

// ==== Controles da Integração WhatsApp ====
document.addEventListener('DOMContentLoaded', function() {
  const createBtn = document.getElementById('wa-create-instance-btn');
  if (createBtn) createBtn.addEventListener('click', createWhatsAppInstance);
  const webhookBtn = document.getElementById('wa-set-webhook-btn');
  if (webhookBtn) webhookBtn.addEventListener('click', setWhatsAppWebhook);
  const sendTestBtn = document.getElementById('wa-send-test-btn');
  if (sendTestBtn) sendTestBtn.addEventListener('click', sendWhatsAppTest);
});

/* =========================================================
   (INCREMENTOS) Qualidade de Vida e Robustez
   ========================================================= */

// Deep-link simples por caminho (ex.: /analise, /empresa etc)
document.addEventListener('DOMContentLoaded', () => {
  const path = (location.pathname || '').toLowerCase();
  const routeToSection = {
    '/analise': 'analysis',
    '/agente': 'agent-config',
    '/produtos': 'products',
    '/pagamentos': 'payments',
    '/empresa': 'company',
    '/usuarios': 'users',
    '/whatsapp': 'wa'
  };
  const sec = routeToSection[path];
  if (sec) {
    try { showSection(sec); } catch (_) {}
  }
});

// Pausa polling de status quando a aba estiver oculta
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (waPollInterval) { clearInterval(waPollInterval); waPollInterval = null; }
  } else {
    if (waCurrentInstance && waCurrentToken && !waPollInterval) {
      waPollInterval = setInterval(updateWhatsAppStatus, 4000);
    }
  }
});

// Limpeza ao descarregar a página
window.addEventListener('beforeunload', () => {
  if (waPollInterval) clearInterval(waPollInterval);
});

/* =========================================================
   Exposição global (para chamadas inline no HTML)
   ========================================================= */
window.showSection = showSection;
window.logout = logout;

window.nextTab = nextTab;
window.previousTab = previousTab;

window.toggleWhatsAppConfig = toggleWhatsAppConfig;
window.toggleSiteLinkConfig = toggleSiteLinkConfig;
window.toggleProductLinkConfig = toggleProductLinkConfig;

window.openMetricModal = openMetricModal;
window.closeMetricModal = closeMetricModal;
window.populateModalTable = populateModalTable;
window.filterTable = filterTable;

window.addProduct = addProduct;
window.openEditProduct = openEditProduct;
window.saveEditProduct = saveEditProduct;
window.removeProduct = removeProduct;

window.saveProfile = saveProfile;

window.createWhatsAppInstance = createWhatsAppInstance;
window.setWhatsAppWebhook = setWhatsAppWebhook;
window.sendWhatsAppTest = sendWhatsAppTest;
