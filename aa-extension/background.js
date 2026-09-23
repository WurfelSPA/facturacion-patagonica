const N8N_WEBHOOK_URL_AA = 'https://wurfel.app.n8n.cloud/webhook/aa-import-session-v2';
const N8N_WEBHOOK_URL_ENEL = 'https://wurfel.app.n8n.cloud/webhook/enel-import-session';
const N8N_WEBHOOK_URL_AA_BOLETA = 'https://wurfel.app.n8n.cloud/webhook/aa-ver-boleta';

// Endpoint temporal en Vercel: usa las mismas cookies para leer "Mis Consumos"
// directamente vía Browserless, sin depender del flujo de n8n.
//
// IMPORTANTE: esto se ESPERA (no es fire-and-forget) porque en Manifest V3 el
// service worker de la extensión puede apagarse apenas termina de responder al
// webhook de n8n, matando cualquier fetch en paralelo que siga pendiente antes
// de completarse. Por eso el popup puede tardar hasta ~1 minuto en mostrar el
// resultado final: está esperando a que Browserless termine de verdad.
const VERCEL_ENEL_IMPORT_URL = 'https://facturacion-patagonica.vercel.app/api/enel-import-session';

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

async function obtenerCookies({ dominioFiltro, criticas, urlParaCriticas }) {
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

  if (!cookies.length) return null;
  return cookies.map(toPuppeteerCookie);
}

async function exportarSesion({ dominioFiltro, criticas, webhookUrl, urlParaCriticas, extraWebhookUrl }) {
  const puppeteerCookies = await obtenerCookies({ dominioFiltro, criticas, urlParaCriticas });
  if (!puppeteerCookies) {
    return { ok: false, error: `No se encontraron cookies. ¿Estás logueado en ${dominioFiltro}?` };
  }
  const cookies = puppeteerCookies;

  // Se esperan AMBAS peticiones (Promise.allSettled) antes de responder al
  // popup: si el service worker se apaga tras la primera en resolver, la otra
  // se pierde. Ninguna de las dos bloquea a la otra si falla.
  const [n8nResult, extraResult] = await Promise.allSettled([
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: puppeteerCookies })
    }),
    extraWebhookUrl
      ? fetch(extraWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: puppeteerCookies })
        })
      : Promise.resolve(null)
  ]);

  if (extraResult.status === 'rejected') {
    console.warn('enel-import-session error:', extraResult.reason && extraResult.reason.message);
  }

  if (n8nResult.status === 'fulfilled' && n8nResult.value.ok) {
    return { ok: true, count: cookies.length };
  }
  if (n8nResult.status === 'fulfilled') {
    return { ok: false, error: 'n8n respondió con error ' + n8nResult.value.status };
  }
  return { ok: false, error: 'No se pudo conectar a n8n: ' + n8nResult.reason.message };
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
    // Antes filtraba solo "enel.cl": el rebote a SSO al elegir cualquier cuenta
    // sugiere que falta una cookie del proveedor de identidad (WSO2), que podría
    // vivir en un dominio distinto (ej. enel.com). Se amplía a "enel" a secas.
    dominioFiltro: 'enel',
    criticas: [],
    webhookUrl: N8N_WEBHOOK_URL_ENEL,
    urlParaCriticas: 'https://www.enel.cl/',
    extraWebhookUrl: VERCEL_ENEL_IMPORT_URL
  });
}

// A diferencia de exportarSesionAA (fire-and-forget: solo confirma que las
// cookies llegaron), acá SÍ se espera la respuesta completa del workflow de
// n8n: éste hace el scraping de esa cuenta puntual en Browserless y devuelve
// {ok, boletaUrl, deuda, nombre} recién cuando termina (puede tardar
// bastante, ver comentario de VERCEL_ENEL_IMPORT_URL más arriba sobre por
// qué el service worker no debe apagarse a mitad de camino).
async function verBoletaAA(idAgua) {
  const cookies = await obtenerCookies({
    dominioFiltro: 'aguasandinas',
    criticas: ['JSESSIONID', 'reese84'],
    urlParaCriticas: 'https://www.aguasandinas.cl/'
  });
  if (!cookies) {
    return { ok: false, error: '¿Estás logueado en aguasandinas.cl? No se encontraron cookies.' };
  }
  try {
    const resp = await fetch(N8N_WEBHOOK_URL_AA_BOLETA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies, idAgua })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: data.error || ('n8n respondió con error ' + resp.status) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: 'No se pudo conectar a n8n: ' + e.message };
  }
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
  if (msg && msg.action === 'verBoletaAA') {
    verBoletaAA(msg.idAgua).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // respuesta async
  }
}

// Mensajes desde el popup de la propia extensión.
chrome.runtime.onMessage.addListener(manejarMensaje);

// Mensajes desde la app de Patagónica (ver "externally_connectable" en manifest.json).
chrome.runtime.onMessageExternal.addListener(manejarMensaje);
