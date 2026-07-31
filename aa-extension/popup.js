const btn = document.getElementById('btn');
const diagBtn = document.getElementById('diag');
const statusEl = document.getElementById('status');

diagBtn.addEventListener('click', async () => {
  diagBtn.disabled = true;
  statusEl.textContent = 'Probando distintas formas de buscar cookies...';
  const lineas = [];
  const objetivo = ['JSESSIONID', 'reese84'];

  async function probar(etiqueta, filtro) {
    try {
      const cs = await chrome.cookies.getAll(filtro);
      const encontradas = objetivo.filter(nombre => cs.some(c => c.name === nombre));
      lineas.push(`${etiqueta}: ${cs.length} cookies | encontró: ${encontradas.length ? encontradas.join(',') : 'ninguna'}`);
    } catch (e) {
      lineas.push(`${etiqueta}: ERROR ${e.message}`);
    }
  }

  await probar('domain=aguasandinas.cl', { domain: 'aguasandinas.cl' });
  await probar('domain=www.aguasandinas.cl', { domain: 'www.aguasandinas.cl' });
  await probar('url=https://www.aguasandinas.cl/', { url: 'https://www.aguasandinas.cl/' });
  await probar('sin filtro (getAll({}))', {});

  // Buscar en TODAS las cookies visibles (aunque no sean de aguasandinas) por si
  // el Domain real no contiene ese texto.
  try {
    const todas = await chrome.cookies.getAll({});
    for (const nombre of objetivo) {
      const c = todas.find(c => c.name === nombre);
      lineas.push(c ? `${nombre} SÍ existe → domain real: "${c.domain}", path: "${c.path}"` : `${nombre} no aparece en NINGUNA cookie visible para la extensión`);
    }
  } catch (e) {}

  // chrome.cookies.get() por nombre exacto (distinto de getAll) — probar con
  // varias combinaciones de url, por si el matching de getAll es el problema.
  const urlsAProbar = [
    'https://www.aguasandinas.cl/',
    'https://www.aguasandinas.cl',
    'https://aguasandinas.cl/'
  ];
  for (const nombre of objetivo) {
    for (const url of urlsAProbar) {
      try {
        const c = await chrome.cookies.get({ url, name: nombre });
        lineas.push(`get(${nombre}, ${url}) → ${c ? 'ENCONTRADA valor=' + c.value.slice(0, 20) + '...' : 'null'}`);
      } catch (e) {
        lineas.push(`get(${nombre}, ${url}) → ERROR ${e.message}`);
      }
    }
  }

  // Listar los cookie stores disponibles (por si hay más de uno y estamos
  // consultando el que no corresponde a la pestaña real).
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    lineas.push('Cookie stores: ' + JSON.stringify(stores.map(s => ({ id: s.id, tabIds: s.tabIds }))));
  } catch (e) {
    lineas.push('getAllCookieStores ERROR: ' + e.message);
  }

  statusEl.textContent = lineas.join('\n');
  diagBtn.disabled = false;
});

const N8N_WEBHOOK_URL = 'https://wurfel.app.n8n.cloud/webhook/3535c25a-a7f1-4a2a-a376-23dba9b990b9/aa-import-session';

// chrome.cookies usa sameSite: 'no_restriction'|'lax'|'strict'|'unspecified' y
// expirationDate en segundos Unix; Puppeteer (que corre en Browserless) espera
// sameSite: 'None'|'Lax'|'Strict' y expires en segundos Unix (o ausente/-1
// para cookies de sesión). Se convierte acá para que el workflow n8n no tenga
// que adivinar el formato.
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

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Leyendo cookies de aguasandinas.cl...';
  try {
    // getAll({}) trae la mayoría, pero por alguna rareza de la API de Chrome
    // omite JSESSIONID y reese84 aunque SÍ existen (confirmado con
    // chrome.cookies.get() por nombre exacto, que a esas dos sí las
    // encuentra). Se combinan ambos resultados para no perder las críticas.
    const todas = await chrome.cookies.getAll({});
    const cookies = todas.filter(c => c.domain && c.domain.includes('aguasandinas'));

    const criticas = ['JSESSIONID', 'reese84'];
    for (const nombre of criticas) {
      if (cookies.some(c => c.name === nombre)) continue;
      const c = await chrome.cookies.get({ url: 'https://www.aguasandinas.cl/', name: nombre }).catch(() => null);
      if (c) cookies.push(c);
    }

    if (!cookies.length) {
      statusEl.textContent = 'No se encontraron cookies. ¿Estás logueado en aguasandinas.cl?';
      btn.disabled = false;
      return;
    }
    statusEl.textContent = `Enviando ${cookies.length} cookies a n8n...`;
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: cookies.map(toPuppeteerCookie) })
    });
    if (res.ok) {
      statusEl.textContent = '✅ Sesión enviada a n8n. El scraping corre en la nube (~5-9 min) y actualiza aa-cache.json solo.';
    } else {
      statusEl.textContent = '❌ n8n respondió con error ' + res.status;
    }
  } catch (e) {
    statusEl.textContent = '❌ No se pudo conectar a n8n: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});
