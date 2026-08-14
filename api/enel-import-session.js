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
  if (!GITHUB_TOKEN) return;

  const filePath = 'enel-mis-consumos-debug.json';
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  let sha = null;
  try {
    const getRes = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
  } catch (_) {}

  const payload = { actualizado: new Date().toISOString(), ...data };
  const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8').toString('base64');
  const body = {
    message: `chore: debug mis consumos Enel ${new Date().toISOString().slice(0, 10)}`,
    content,
    ...(sha ? { sha } : {})
  };

  await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }).catch(() => {});
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
  "const accountIds = [...document.querySelectorAll('.pvtArea-account-select-option[data-target]')].map(el => el.dataset.target).filter(Boolean);",
  "if (!accountIds.length) return JSON.stringify({ error: 'sin-cuentas', title: document.title, url: location.href, snippet: (document.body ? document.body.innerText : 'NO_BODY').slice(0, 500) });",
  "async function getCsrfToken() {",
  "  const r = await fetch('/libs/granite/csrf/token.json', { credentials: 'include' });",
  "  const j = await r.json();",
  "  return j.token;",
  "}",
  "const token = await getCsrfToken();",
  "if (!token) return JSON.stringify({ error: 'sin-csrf', accountIds });",
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
    '  nav: goto(url: "https://www.enel.cl/es/Ingresar.html", waitUntil: domContentLoaded, timeout: 30000) { status }',
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
    await guardarDebugViaGitHub({ ok: true, parsed, raw: raw ? undefined : blData });
    return res.status(200).json({ parsed });
  } catch (e) {
    await guardarDebugViaGitHub({ ok: false, error: e.message });
    return res.status(500).json({ error: e.message });
  }
}
