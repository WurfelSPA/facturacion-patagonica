const N8N_WEBHOOK_URL_AA = 'https://wurfel.app.n8n.cloud/webhook/aa-import-session-v2';
const N8N_WEBHOOK_URL_ENEL = 'https://wurfel.app.n8n.cloud/webhook/enel-import-session';

// chrome.cookies usa sameSite: 'no_restriction'|'lax'|'strict'|'unspecified' y
// expirationDate en segundos Unix; Puppeteer/BrowserQL (que corren en Browserless)
// esperan sameSite: 'None'|'Lax'|'Strict' y expires en segundos Unix.
function toPuppeteerCookie(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure
  };
  if (!c.session && c.expirationDate) out.expires = c.expirationDate;
  if (c.sameSite === 'no_restriction') out.sameSite = 'None';
  else if (c.sameSite === 'lax') out.sameSite = 'Lax';
  else if (c.sameSite === 'strict') out.sameSite = 'Strict';
  return out;
}

async function exportarSesion({ dominioFiltro, criticas, webhookUrl, urlParaCriticas }) {
  // getAll({}) trae la mayoría, pero por una rareza de la API de Chrome a veces
  // omite algunas cookies críticas aunque SÍ existen (confirmado con
  // chrome.cookies.get() por nombre exacto). Se combinan ambos resultados.
  const todas = await chrome.cookies.getAll({});
  const cookies = todas.filter(c => c.domain && c.domain.includes(dominioFiltro));

  for (const nombre of criticas) {
    if (cookies.some(c => c.name === nombre)) continue;
    const c = await chrome.cookies.get({ url: urlParaCriticas, name: nombre }).catch(() => null);
    if (c) cookies.push(c);
  }

  if (!cookies.length) {
    return { ok: false, error: `No se encontraron cookies. ¿Estás logueado en ${dominioFiltro}?` };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: cookies.map(toPuppeteerCookie) })
    });
    if (res.ok) return { ok: true, count: cookies.length };
    return { ok: false, error: 'n8n respondió con error ' + res.status };
  } catch (e) {
    return { ok: false, error: 'No se pudo conectar a n8n: ' + e.message };
  }
}

function exportarSesionAA() {
  return exportarSesion({
    dominioFiltro: 'aguasandinas',
    criticas: ['JSESSIONID', 'reese84'],
    webhookUrl: N8N_WEBHOOK_URL_AA,
    urlParaCriticas: 'https://www.aguasandinas.cl/'
  });
}

function exportarSesionEnel() {
  return exportarSesion({
    dominioFiltro: 'enel.cl',
    criticas: [],
    webhookUrl: N8N_WEBHOOK_URL_ENEL,
    urlParaCriticas: 'https://www.enel.cl/'
  });
}

function manejarMensaje(msg, sender, sendResponse) {
  if (msg && msg.action === 'exportarSesionAA') {
    exportarSesionAA().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // respuesta async
  }
  if (msg && msg.action === 'exportarSesionEnel') {
    exportarSesionEnel().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // respuesta async
  }
}

// Mensajes desde el popup de la propia extensión.
chrome.runtime.onMessage.addListener(manejarMensaje);

// Mensajes desde la app de Patagónica (ver "externally_connectable" en manifest.json).
chrome.runtime.onMessageExternal.addListener(manejarMensaje);
