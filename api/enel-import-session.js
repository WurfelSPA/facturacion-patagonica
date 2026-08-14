/**
 * POST /api/enel-import-session
 *
 * Recibe las cookies reales de una sesión ya autenticada en enel.cl
 * (exportadas por la extensión de Chrome) y las usa para leer "Mis Consumos"
 * — sin login automatizado.
 *
 * IMPORTANTE: la primera versión de este endpoint clickeaba el selector de
 * cuentas del portal (UI), lo que disparaba un segundo paso de SSO/SAML que
 * la sesión exportada no lograba completar en silencio (terminaba en la
 * pantalla de login, y de paso invalidaba la sesión real del usuario más de
 * una vez). El workflow n8n existente ("enel-import-session" en
 * wurfel.app.n8n.cloud), que sí funciona en producción para leer el saldo de
 * cada cuenta, NUNCA clickea ese selector: obtiene el token CSRF una sola
 * vez y llama directo, por AJAX, a AccountInfoChileThreadCommand.html pasando
 * supplyCode como parámetro — sin tocar el DOM del selector. Esta versión
 * copia ese mismo patrón (BQL de Browserless + fetch interno con CSRF), y de
 * paso rastrea el JS de la página para encontrar el endpoint real de
 * "Mis Consumos" (equivalente a AccountInfoChileThreadCommand pero para
 * lecturas), en vez de intentar clickear el acordeón.
 *
 * Body: { cookies: [...] }  (formato Puppeteer, ya generado por la extensión)
 *
 * El resultado (o el error de diagnóstico) se guarda además en
 * enel-mis-consumos-debug.json vía GitHub API, porque quien llama a este
 * endpoint es la extensión (fire-and-forget) y nadie ve la respuesta HTTP
 * directamente.
 */

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

async function guardarDebugViaGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  if (!GITHUB_TOKEN) return { ok: false, error: 'Falta GITHUB_TOKEN' };

  const filePath = 'enel-mis-consumos-debug.json';
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const payload = { actualizado: new Date().toISOString(), ...data };
  const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8').toString('base64');

  // Hasta 3 intentos: si el PUT falla por sha desactualizado (409/422, otra
  // escritura concurrente), se vuelve a pedir el sha fresco y se reintenta —
  // antes esto fallaba en silencio (.catch(() => {})) y parecía que el click
  // "no hacía nada".
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha = null;
    try {
      const getRes = await fetch(apiBase, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
      });
      if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
    } catch (e) { lastError = 'GET falló: ' + e.message; }

    const body = {
      message: `chore: debug mis consumos Enel ${new Date().toISOString().slice(0, 10)}`,
      content,
      ...(sha ? { sha } : {})
    };

    try {
      const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (putRes.ok) return { ok: true };
      lastError = `PUT ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`;
    } catch (e) {
      lastError = 'PUT falló: ' + e.message;
    }
    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  return { ok: false, error: lastError };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Mismo patrón que el nodo "Preparar Script Enel" del workflow n8n que ya
// funciona en producción: nunca clickea el selector de cuentas. Obtiene el
// token CSRF una sola vez y llama por fetch directo a los endpoints internos
// (AJAX), pasando el account id como parámetro. Además, busca en el JS de la
// página el endpoint real de "Mis Consumos" sin ejecutar ningún clic.
const TARGET_ACCOUNT = '1582840-4';

const evalJsLines = [
  "function leerAccountIds() {",
  "  return [...document.querySelectorAll('.pvtArea-account-select-option[data-target]')].map(el => el.dataset.target).filter(Boolean);",
  "}",
  "let accountIds = leerAccountIds();",
  "for (let i = 0; i < 8 && !accountIds.length; i++) {",
  "  await new Promise(r => setTimeout(r, 2000));",
  "  accountIds = leerAccountIds();",
  "}",
  "if (!accountIds.length) return JSON.stringify({ error: 'sin-cuentas', title: document.title, url: location.href, totalElements: document.querySelectorAll('*').length, snippet: (document.body ? document.body.innerText : 'NO_BODY').slice(0, 1500) });",
  "let csrfDebug = null;",
  "function buscarCsrfEnPagina() {",
  "  const metaNames = ['csrf-token', 'cq:csrf_token', 'cq_csrf_token', ':cq_csrf_token'];",
  "  for (const name of metaNames) {",
  "    const meta = document.querySelector('meta[name=\\\"' + name + '\\\"]');",
  "    if (meta && meta.content) return meta.content;",
  "  }",
  "  const inline = [...document.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\\n');",
  "  const m = inline.match(/csrf[_-]?token[\\\"'\\s:=]+[\\\"']([a-zA-Z0-9._-]{10,})[\\\"']/i);",
  "  return m ? m[1] : null;",
  "}",
  "const csrfEnPagina = buscarCsrfEnPagina();",
  "async function getCsrfToken() {",
  "  const r = await fetch('/libs/granite/csrf/token.json?_=' + Date.now(), { credentials: 'include', cache: 'no-store', headers: { 'Accept': 'application/json' } });",
  "  const txt = await r.text();",
  "  const headersObj = {};",
  "  r.headers.forEach((v, k) => { headersObj[k] = v; });",
  "  csrfDebug = { status: r.status, body: txt.slice(0, 500), headers: headersObj };",
  "  let j;",
  "  try { j = JSON.parse(txt); } catch (e) { return null; }",
  "  return j.token;",
  "}",
  "let token = csrfEnPagina;",
  "if (!token) token = await getCsrfToken();",
  "for (let i = 0; i < 4 && !token; i++) {",
  "  await new Promise(r => setTimeout(r, 1500));",
  "  token = await getCsrfToken();",
  "}",
  "if (!token) return JSON.stringify({ error: 'sin-csrf', accountIds, csrfEnPagina, csrfDebug });",
  "",
  "// Confirmar que la sesión autentica bien contra el endpoint que YA se sabe que funciona,",
  "// llamando directo por AJAX (sin clickear el selector de cuentas).",
  "let accountInfoTest = null;",
  "try {",
  "  const params = new URLSearchParams({ ':cq_csrf_token': token, supplyCode: '" + TARGET_ACCOUNT + "' });",
  "  const r = await fetch('/es/private-area.mdwedgeohl.AccountInfoChileThreadCommand.html', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', 'CSRF-Token': token }, body: params });",
  "  accountInfoTest = { status: r.status, body: (await r.text()).slice(0, 500) };",
  "} catch (e) { accountInfoTest = { error: e.message }; }",
  "",
  "return JSON.stringify({ accountIds, accountInfoTest });"
].join(String.fromCharCode(10));

function buildBqlQuery() {
  const escapedEvalJs = evalJsLines.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return [
    'mutation LeerMisConsumos($cookies: [CookieInput!]!) {',
    '  proxy(network: residential, country: CL, sticky: true) { time }',
    '  setCookies: cookies(cookies: $cookies) { cookies { name } }',
    '  nav: goto(url: "https://www.enel.cl/es/private-area.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
    '  espera: waitForTimeout(time: 8000) { time }',
    '  extraccion: evaluate(content: "' + escapedEvalJs + '") { value }',
    '}'
  ].join(String.fromCharCode(10));
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query.debugQuery === '1') {
    return res.status(200).json({ query: buildBqlQuery(), evalJsLines });
  }
  if (req.method === 'GET' && req.query.trivial === '1') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    const trivialQuery = [
      'mutation Trivial {',
      '  nav: goto(url: "https://example.com", waitUntil: domContentLoaded, timeout: 20000) { status }',
      '  extraccion: evaluate(content: "return 1 + 1;") { value }',
      '}'
    ].join(String.fromCharCode(10));
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=30000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: trivialQuery }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method === 'GET' && req.query.trivial === '2') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    const escapedEvalJs = evalJsLines.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const q = [
      'mutation Trivial2 {',
      '  nav: goto(url: "https://example.com", waitUntil: domContentLoaded, timeout: 20000) { status }',
      '  extraccion: evaluate(content: "' + escapedEvalJs + '") { value }',
      '}'
    ].join(String.fromCharCode(10));
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=30000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method === 'GET' && req.query.trivial === '3') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    // Trivial content, pero con proxy residencial + goto a enel.cl real (sin cookies).
    const q = [
      'mutation Trivial3 {',
      '  proxy(network: residential, country: CL, sticky: true) { time }',
      '  nav: goto(url: "https://www.enel.cl/es/Ingresar.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
      '  extraccion: evaluate(content: "return document.title;") { value }',
      '}'
    ].join(String.fromCharCode(10));
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=40000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method === 'GET' && req.query.trivial === '4') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    // Trivial content, con setCookies (cookie de prueba) + goto a enel.cl real (sin proxy).
    const q = [
      'mutation Trivial4($cookies: [CookieInput!]!) {',
      '  setCookies: cookies(cookies: $cookies) { cookies { name } }',
      '  nav: goto(url: "https://www.enel.cl/es/Ingresar.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
      '  extraccion: evaluate(content: "return document.title;") { value }',
      '}'
    ].join(String.fromCharCode(10));
    const testCookies = [{ name: 'test', value: 'x', domain: '.enel.cl', path: '/' }];
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=40000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { cookies: testCookies } }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method === 'GET' && req.query.trivial === '5') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    // proxy + setCookies JUNTOS + real URL, pero con content trivial.
    const q = [
      'mutation Trivial5($cookies: [CookieInput!]!) {',
      '  proxy(network: residential, country: CL, sticky: true) { time }',
      '  setCookies: cookies(cookies: $cookies) { cookies { name } }',
      '  nav: goto(url: "https://www.enel.cl/es/Ingresar.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
      '  extraccion: evaluate(content: "return document.title;") { value }',
      '}'
    ].join(String.fromCharCode(10));
    const testCookies = [{ name: 'test', value: 'x', domain: '.enel.cl', path: '/' }];
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=40000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { cookies: testCookies } }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method === 'GET' && req.query.trivial === '6') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    // FULL content + setCookies + real URL, SIN proxy.
    const escapedEvalJs = evalJsLines.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const q = [
      'mutation Trivial6($cookies: [CookieInput!]!) {',
      '  setCookies: cookies(cookies: $cookies) { cookies { name } }',
      '  nav: goto(url: "https://www.enel.cl/es/Ingresar.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
      '  extraccion: evaluate(content: "' + escapedEvalJs + '") { value }',
      '}'
    ].join(String.fromCharCode(10));
    const testCookies = [{ name: 'test', value: 'x', domain: '.enel.cl', path: '/' }];
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=40000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { cookies: testCookies } }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method === 'GET' && req.query.trivial === '7') {
    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });
    // FULL content + proxy + real URL, SIN setCookies.
    const escapedEvalJs = evalJsLines.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const q = [
      'mutation Trivial7 {',
      '  proxy(network: residential, country: CL, sticky: true) { time }',
      '  nav: goto(url: "https://www.enel.cl/es/Ingresar.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
      '  extraccion: evaluate(content: "' + escapedEvalJs + '") { value }',
      '}'
    ].join(String.fromCharCode(10));
    try {
      const blRes = await fetch(
        `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=40000`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }
      );
      const text = await blRes.text();
      return res.status(200).json({ status: blRes.status, body: text.slice(0, 2000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cookies } = req.body || {};
  if (!Array.isArray(cookies) || !cookies.length) {
    return res.status(400).json({ error: 'Faltan cookies en el body' });
  }

  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
  if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  try {
    // /stealth/bql: mismo endpoint y patrón (proxy residencial CL + cookies +
    // goto + evaluate, todo en una sola query GraphQL) que usa el workflow n8n
    // que YA funciona en producción para leer el saldo de cada cuenta.
    const blRes = await fetch(
      `https://production-sfo.browserless.io/stealth/bql?token=${BROWSERLESS_TOKEN}&timeout=58000`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: buildBqlQuery(), variables: { cookies } })
      }
    );
    if (!blRes.ok) {
      const errText = await blRes.text();
      await guardarDebugViaGitHub({ ok: false, error: `Browserless ${blRes.status}: ${errText.slice(0, 800)}` });
      return res.status(500).json({ error: `Browserless ${blRes.status}: ${errText.slice(0, 800)}` });
    }
    const blData = await blRes.json();
    if (blData.errors) {
      await guardarDebugViaGitHub({ ok: false, error: `GraphQL: ${JSON.stringify(blData.errors).slice(0, 800)}` });
      return res.status(500).json({ error: `GraphQL: ${JSON.stringify(blData.errors).slice(0, 800)}` });
    }
    const raw = blData.data && blData.data.extraccion && blData.data.extraccion.value;
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = { parseError: true, raw: String(raw).slice(0, 2000) }; }
    const guardado = await guardarDebugViaGitHub({ ok: true, parsed, raw: raw ? undefined : blData });
    return res.status(200).json({ parsed, guardado });
  } catch (e) {
    const guardado = await guardarDebugViaGitHub({ ok: false, error: e.message });
    return res.status(500).json({ error: e.message, guardado });
  }
}
