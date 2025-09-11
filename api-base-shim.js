<script>
/*
  api-base-shim.js
  - Garante que TODAS as chamadas para /api/... sejam redirecionadas para
    https://plataforma-pac-lead-backend-production.up.railway.app/api/...
  - Evita "/api" duplicado.
  - Corrige casos em que o BACKEND_BASE foi usado sem "https://" (relativo).
*/

(function () {
  // 1) Descobre a base vinda do index.html (ou usa a padrão correta)
  var RAW_BASE =
    (typeof window.__BACKEND_BASE__ === "string" && window.__BACKEND_BASE__.trim()) ||
    "https://plataforma-pac-lead-backend-production.up.railway.app";

  // 2) Garante protocolo (https://) se vier sem
  if (!/^https?:\/\//i.test(RAW_BASE)) {
    RAW_BASE = "https://" + RAW_BASE;
  }

  // 3) Normaliza BACKEND_BASE e API_BASE
  var BACKEND_BASE = RAW_BASE.replace(/\/+$/, "");         // remove / do fim
  var API_PREFIX   = (window.__API_PREFIX__ || "/api");   // se tiver já
  var API_BASE     = BACKEND_BASE + API_PREFIX;           // ex: https://.../api

  // Exponho pra qualquer script que precise
  window.BACKEND_BASE = BACKEND_BASE;
  window.API_BASE     = API_BASE;

  // 4) Funções utilitárias de normalização
  function stripLeading(str, re) { return str.replace(re, ""); }
  function normalizeApiPath(p) {
    // remove barras extras
    p = p.replace(/^\/+/, "");
    // remove "api/" na frente, uma ou mais vezes (evita api/api/...):
    p = p.replace(/^(api\/)+/i, "api/");
    return p;
  }

  // 5) Intercepta fetch para reescrever URLs relativas
  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      // Se for Request, converto pra string
      var url = (typeof input === "string") ? input : (input && input.url) || "";

      // CASO A: já é absoluta (http/https) -> não toco
      if (/^https?:\/\//i.test(url)) {
        return _fetch(input, init);
      }

      // CASO B: o dev passou um "host" sem protocolo (vira caminho relativo, bug)
      //   ex: "plataforma-...railway.app/api/auth/register"
      // Detecto se contém "railway.app" no início do caminho sem http
      if (/^[a-z0-9.-]+\.railway\.app\//i.test(url)) {
        // Prependo https://
        var abs = "https://" + url.replace(/^\/+/, "");
        return _fetch(abs, init);
      }

      // CASO C: caminhos relativos ("/api/..." ou "api/...") -> mando pro BACKEND_BASE
      //         (também lida com "/api/api/..." -> vira "/api/...")
      var candidate = url.trim();

      // Começos possíveis de caminho API relativo
      if (/^\/?api\//i.test(candidate)) {
        // remove barra(s) do começo
        candidate = candidate.replace(/^\/+/, "");
        // normaliza "api/api/..." em "api/..."
        candidate = normalizeApiPath(candidate);

        // monta URL absoluta correta
        var finalUrl = BACKEND_BASE + "/" + candidate; // BACKEND_BASE + /api/...
        return _fetch(finalUrl, init);
      }

      // Demais caminhos relativos (ex.: "/uploads/..") deixo na origem atual
      return _fetch(input, init);
    } catch (e) {
      // Em caso de erro do shim, não bloquear; dispara fetch original
      return _fetch(input, init);
    }
  };

  // 6) Opcional: intercepta XMLHttpRequest também (se houver libs legadas)
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      var u = url || "";

      if (!/^https?:\/\//i.test(u)) {
        if (/^[a-z0-9.-]+\.railway\.app\//i.test(u)) {
          u = "https://" + u.replace(/^\/+/, "");
        } else if (/^\/?api\//i.test(u)) {
          u = u.replace(/^\/+/, "");
          u = normalizeApiPath(u);
          u = BACKEND_BASE + "/" + u;
        }
      }
      return _open.apply(this, [method, u].concat([].slice.call(arguments, 2)));
    } catch (e) {
      return _open.apply(this, arguments);
    }
  };
})();
</script>
