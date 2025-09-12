/*
 * Script de autenticação completo para o Helsen IA. Este módulo lida com
 * registro e login, permite configurar a base da API através de
 * variáveis globais (window.__BACKEND_BASE__ e window.__API_PREFIX__),
 * armazena dados de sessão no localStorage e exibe mensagens de erro
 * amigáveis ao usuário. A estrutura foi inspirada em práticas usadas por
 * sites populares, com tratamento robusto de respostas e feedback visível.
 */

(() => {
  // Determina a URL base do backend. Permite configuração dinâmica
  // via window.__BACKEND_BASE__ definida pela página. Usa uma URL
  // de fallback apenas como exemplo; altere conforme seu ambiente.
  const BASE = (window.__BACKEND_BASE__ || 'https://plataforma-pac-lead-backend-production.up.railway.app').replace(/\/+$/, '');
  // Prefixo opcional para rotas da API (ex: '/api'); pode ser vazio
  const PREFIX = (typeof window.__API_PREFIX__ !== 'undefined' ? window.__API_PREFIX__ : '/api');
  const API = (endpoint) => `${BASE}${PREFIX}${endpoint}`;

  const $ = (id) => document.getElementById(id);
  const errBox = $('errorMsg');

  /*** ============================== INCREMENTOS ============================== ***/
  // Exibe/limpa erros
  const showError = (msg) => {
    console.error(msg);
    if (errBox) {
      errBox.style.display = 'block';
      errBox.textContent = String(msg || 'Erro inesperado.');
    }
  };
  const clearError = () => { if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; } };

  // Helper para limitar tempo de requisições
  async function fetchJson(url, options = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      return await parseJSON(res);
    } finally {
      clearTimeout(t);
    }
  }

  // Tenta vários endpoints até autenticar (suporta URLs absolutas e relativas)
  async function tryAuthEndpoints(paths, payload, headers) {
    for (const p of paths) {
      const url = p.startsWith('http') ? p : (p.startsWith('/') ? `${BASE}${p}` : `${BASE}${PREFIX}${p}`);
      try {
        const data = await fetchJson(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });
        // Se retornou token, consideramos sucesso
        const tok = extractToken(data);
        if (tok) return data;
      } catch (e) {
        // tenta o próximo
      }
    }
    throw new Error('Não foi possível autenticar. Verifique suas credenciais ou tente mais tarde.');
  }

  // Botão em estado "carregando"
  function setLoading(btn, on) {
    if (!btn) return;
    if (on) { btn.classList.add('btn-loading'); btn.disabled = true; }
    else { btn.classList.remove('btn-loading'); btn.disabled = false; }
  }

  /*** ============================== ORIGINAL + ROBUSTEZ ============================== ***/

  /**
   * Exibe uma mensagem de erro amigável. Mostra uma caixa de texto
   * acima dos formulários e também registra no console para depuração.
   * @param {string} msg Mensagem a exibir
   */
  const showErrorOriginal = (msg) => {
    // Mantém a API original (compat) e delega para a versão incrementada
    showError(msg);
  };

  /**
   * Converte a resposta de uma requisição em JSON, lançando um erro
   * com a mensagem apropriada caso o status HTTP não seja OK.
   * @param {Response} res Resposta fetch
   */
  const parseJSON = async (res) => {
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { message: text };
    }
    if (!res.ok) {
      const m = data.message || data.error || `HTTP ${res.status}`;
      throw new Error(m);
    }
    return data;
  };

  /**
   * Tenta extrair o token JWT de diferentes formatos de resposta.
   * Suporta campos: token, jwt, access_token, data.token, data.jwt, etc.
   * @param {object} data Objeto retornado pela API
   * @returns {string|null}
   */
  const extractToken = (data) =>
    data.token || data.jwt || data.access_token ||
    (data.data && (data.data.token || data.data.jwt || data.data.access_token)) ||
    (data.user && (data.user.token || data.user.jwt || data.user.access_token)) || null;

  /**
   * Extrai IDs de organização e fluxo de diferentes formatos de resposta.
   * Se nenhum valor estiver presente, retorna '1' como padrão para testes.
   * @param {object} data Objeto retornado pela API
   */
  const extractOrg = (data) =>
    data.org_id || data.orgId || (data.user && (data.user.org_id || data.user.orgId)) || '1';
  const extractFlow = (data) =>
    data.flow_id || data.flowId || (data.user && (data.user.flow_id || data.user.flowId)) || '1';

  /**
   * Persiste no localStorage os dados de autenticação necessários.
   * @param {object} data Objeto retornado pela API
   */
  const saveAuthData = (data) => {
    const token = extractToken(data);
    if (!token) throw new Error('Resposta sem token');
    localStorage.setItem('token', token);
    localStorage.setItem('org_id', String(extractOrg(data)));
    localStorage.setItem('flow_id', String(extractFlow(data)));
    // Armazena também o nome do usuário (se fornecido) para exibir mensagens de saudação
    try {
      const extractName = (d) =>
        d.name || d.username || (d.user && (d.user.name || d.user.username || d.user.email)) || '';
      const userName = extractName(data);
      if (userName) {
        localStorage.setItem('user_name', userName);
      }
      // Armazena o CPF/CNPJ associado ao cadastro, se estiver presente na resposta
      const extractTax = (d) =>
        d.tax_id || d.taxId || (d.user && (d.user.tax_id || d.user.taxId)) || '';
      const tax = extractTax(data);
      if (tax) {
        localStorage.setItem('tax_id', tax);
      }
    } catch (_) {
      // Ignora erros de armazenamento do nome
    }
  };

  /**
   * Headers padrão, incluindo IDs de organização e fluxo lidos do
   * localStorage caso já existam. Útil para chamadas autenticadas.
   */
  const defaultHeaders = () => ({
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Org-ID': localStorage.getItem('org_id') || '1',
    'X-Flow-ID': localStorage.getItem('flow_id') || '1'
  });

  // ======================== API global para o login.html ========================
  // Se o login.html tiver fallback, ele usará window.HelsenAuth.
  // Aqui oferecemos uma implementação robusta e centralizada.
  window.HelsenAuth = {
    async login({ email, password }) {
      const headers = defaultHeaders();
      const payload = { email, password };
      const paths = [
        `${PREFIX}/auth/login`,
        `${PREFIX}/login`,
        `${PREFIX}/users/login`,
        `${PREFIX}/sessions`,
        `/api/auth/login`,  // redundâncias por compatibilidade
        `/api/login`
      ];
      const data = await tryAuthEndpoints(paths, payload, headers);
      saveAuthData(data);
      try { localStorage.setItem('remember_email', email); } catch(_) {}
      return data;
    },
    async register({ name, email, password, tax_id }) {
      const headers = defaultHeaders();
      const payload = { name, email, password, tax_id };
      const paths = [
        `${PREFIX}/auth/register`,
        `${PREFIX}/register`,
        `${PREFIX}/users`,
        `${PREFIX}/signup`,
        `/api/auth/register`, // redundâncias por compatibilidade
        `/api/register`
      ];
      const data = await tryAuthEndpoints(paths, payload, headers);
      saveAuthData(data);
      return data;
    }
  };

  // ====================== HANDLERS (mantidos e incrementados) ======================
  // Observação: Para evitar chamadas duplicadas (login.html também liga handlers),
  // usamos um "wrapper" em fase de captura que interrompe a propagação e chama
  // nossos manipuladores apenas uma vez por submit.

  function alreadyHandled(e) {
    if (e.__authjsHandled) return true;
    e.__authjsHandled = true;
    return false;
  }

  // Manipulador de envio do formulário de login
  async function handleLogin(e) {
    e.preventDefault();
    if (alreadyHandled(e)) return;
    clearError();

    const emailEl = $('login-email');
    const passEl = $('login-password');
    const btn = $('login-submit');

    const email = (emailEl && emailEl.value || '').trim();
    const password = (passEl && passEl.value) || '';

    if (!email || !password) { showError('Preencha email e senha.'); return; }

    setLoading(btn, true);
    try {
      // 1) Tenta via API global robusta
      let data = null;
      try {
        data = await window.HelsenAuth.login({ email, password });
      } catch (err1) {
        // 2) Fallback: mantém a chamada original a /auth/login (NÃO removida)
        const res = await fetch(API('/auth/login'), {
          method: 'POST',
          headers: defaultHeaders(),
          body: JSON.stringify({ email, password })
        });
        data = await parseJSON(res);
        saveAuthData(data);
        try { localStorage.setItem('remember_email', email); } catch(_) {}
      }

      // redireciona para o dashboard após login (ajuste para index.html)
      location.href = 'index.html';
    } catch (err) {
      showErrorOriginal(err.message || 'Falha no login.');
    } finally {
      setLoading(btn, false);
    }
  }

  // Manipulador de envio do formulário de registro
  async function handleRegister(e) {
    e.preventDefault();
    if (alreadyHandled(e)) return;
    clearError();

    const nameEl = $('register-name');
    const emailEl = $('register-email');
    const passEl = $('register-password');
    const taxEl = $('register-tax');
    const btn = $('register-submit');

    const name = (nameEl && nameEl.value || '').trim();
    const email = (emailEl && emailEl.value || '').trim();
    const password = (passEl && passEl.value) || '';
    const rawTax = (taxEl && taxEl.value || '').trim();
    const taxDigits = rawTax.replace(/\D/g, '');

    if (!name || !email || !password || !taxDigits) {
      showError('Preencha todos os campos do cadastro.');
      return;
    }
    if (taxDigits.length !== 11 && taxDigits.length !== 14) {
      showError('CPF/CNPJ inválido. Informe um número com 11 ou 14 dígitos.');
      return;
    }

    setLoading(btn, true);
    try {
      // 1) Tenta via API global robusta
      let data = null;
      try {
        data = await window.HelsenAuth.register({ name, email, password, tax_id: taxDigits });
      } catch (err1) {
        // 2) Fallback: mantém a chamada original a /auth/register (NÃO removida)
        const res = await fetch(API('/auth/register'), {
          method: 'POST',
          headers: defaultHeaders(),
          body: JSON.stringify({ name, email, password, tax_id: taxDigits })
        });
        data = await parseJSON(res);
        const token = extractToken(data);
        if (token) {
          saveAuthData(data);
          location.href = 'index.html';
          return;
        }
      }

      // Se registrou e já autenticou, redireciona
      const token = extractToken(data);
      if (token) {
        location.href = 'index.html';
        return;
      }

      // Caso não tenha vindo token, troca para a tela de login (mantendo lógica original + fallback)
      const tabBtn = document.querySelector('[data-bs-target="#login"]');
      if (tabBtn) { tabBtn.click(); }
      // Fallback simples para alternar telas do nosso layout (sem abas)
      const loginForm = $('login-form');
      const registerForm = $('register-form');
      if (loginForm && registerForm) {
        registerForm.style.display = 'none';
        loginForm.style.display = 'block';
      }
    } catch (err) {
      showErrorOriginal(err.message || 'Falha no cadastro.');
    } finally {
      setLoading(btn, false);
    }
  }

  // Wrappers em CAPTURA para evitar handlers duplicados do login.html
  function captureLoginWrapper(e) {
    // intercepta no capture, impede propagação e chama uma única vez
    if (!e) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleLogin(e);
  }
  function captureRegisterWrapper(e) {
    if (!e) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleRegister(e);
  }

  // Faz o bind em CAPTURA (sem remover nada do final do arquivo)
  const lf = $('login-form');
  const rf = $('register-form');
  if (lf && !lf.dataset.authjsCaptureBound) {
    lf.dataset.authjsCaptureBound = '1';
    lf.addEventListener('submit', captureLoginWrapper, true); // capture = true
  }
  if (rf && !rf.dataset.authjsCaptureBound) {
    rf.dataset.authjsCaptureBound = '1';
    rf.addEventListener('submit', captureRegisterWrapper, true); // capture = true
  }

  /*** ============================== FIM DOS INCREMENTOS ============================== ***/

  // ====================== (LINHAS ORIGINAIS MANTIDAS/CONFIGURADAS) ======================
  // Associação dos formulários aos manipuladores (mantidas para compatibilidade).
  // Observação: continuam aqui, mas como temos wrappers em "capture",
  // estes não irão disparar duplicado. E, se dispararem, handleLogin/handleRegister
  // garantem execução única por evento via "alreadyHandled".
  const loginForm = $('login-form');
  const registerForm = $('register-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (registerForm) registerForm.addEventListener('submit', handleRegister);
})();
