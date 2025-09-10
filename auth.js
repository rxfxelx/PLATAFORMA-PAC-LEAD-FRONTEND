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
  const BASE = (window.__BACKEND_BASE__ || 'https://pac-lead-production.up.railway.app').replace(/\/+$/, '');
  // Prefixo opcional para rotas da API (ex: '/api'); pode ser vazio
  const PREFIX = (typeof window.__API_PREFIX__ !== 'undefined' ? window.__API_PREFIX__ : '/api');
  const API = (endpoint) => `${BASE}${PREFIX}${endpoint}`;

  const $ = (id) => document.getElementById(id);
  const errBox = $('errorMsg');

  /**
   * Exibe uma mensagem de erro amigável. Mostra uma caixa de texto
   * acima dos formulários e também registra no console para depuração.
   * @param {string} msg Mensagem a exibir
   */
  const showError = (msg) => {
    console.error(msg);
    if (errBox) {
      errBox.style.display = 'block';
      errBox.textContent = String(msg || 'Erro inesperado.');
    }
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
    'X-Org-ID': localStorage.getItem('org_id') || '1',
    'X-Flow-ID': localStorage.getItem('flow_id') || '1'
  });

  // Manipulador de envio do formulário de login
  async function handleLogin(e) {
    e.preventDefault();
    if (errBox) errBox.style.display = 'none';
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    try {
      const res = await fetch(API('/auth/login'), {
        method: 'POST',
        headers: defaultHeaders(),
        body: JSON.stringify({ email, password })
      });
      const data = await parseJSON(res);
      saveAuthData(data);
      // redireciona para o dashboard após login
      location.href = '/';
    } catch (err) {
      showError(err.message || 'Falha no login.');
    }
  }

  // Manipulador de envio do formulário de registro
  async function handleRegister(e) {
    e.preventDefault();
    if (errBox) errBox.style.display = 'none';
    const name = $('register-name').value.trim();
    const email = $('register-email').value.trim();
    const password = $('register-password').value;
    const rawTax = ($('register-tax') && $('register-tax').value.trim()) || '';
    // remove non‑digit characters from CPF/CNPJ
    const taxDigits = rawTax.replace(/\D/g, '');
    // validate the identifier: must be 11 or 14 digits (CPF or CNPJ)
    if (taxDigits.length !== 11 && taxDigits.length !== 14) {
      showError('CPF/CNPJ inválido. Informe um número com 11 ou 14 dígitos.');
      return;
    }
    try {
      const res = await fetch(API('/auth/register'), {
        method: 'POST',
        headers: defaultHeaders(),
        body: JSON.stringify({ name, email, password, tax_id: taxDigits })
      });
      const data = await parseJSON(res);
      // se a API já devolver token no cadastro, salva e redireciona
      const token = extractToken(data);
      if (token) {
        saveAuthData(data);
        location.href = '/';
      } else {
        // caso contrário, muda para a aba de login
        const loginTab = document.querySelector('[data-bs-target="#login"]');
        if (loginTab) loginTab.click();
      }
    } catch (err) {
      showError(err.message || 'Falha no cadastro.');
    }
  }

  // Associação dos formulários aos manipuladores
  const loginForm = $('login-form');
  const registerForm = $('register-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (registerForm) registerForm.addEventListener('submit', handleRegister);
})();
