/**
 * render-service/nubox-scraper.js
 *
 * DIAGNOSTIC MODE: retorna outerHTML del elemento "Año actual",
 * todos los onclick handlers y el parentHTML — para identificar
 * cómo disparar el postback de ASP.NET.
 *
 * Vars requeridas:
 *   BROWSERLESS_TOKEN  — token de Browserless.io
 *   NUBOX_UTN          — token UTN de sesión Nubox
 */

const fetch = require('node-fetch');

const DASHBOARD = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas';

const BROWSERLESS_HOSTS = [
  'https://production-sfo.browserless.io',
  'https://production-lon.browserless.io',
];

function buildBrowserCode(targetUrl) {
  return `
export default async function({ page }) {
  // 1. Navegar
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Verificar login
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // 3. Esperar 6s para que el JS de la página se ejecute completamente
  await new Promise(r => setTimeout(r, 6000));

  // 4. Diagnóstico DOM completo — retornar INMEDIATAMENTE sin esperar datos
  const diag = await page.evaluate(() => {
    // Encontrar el elemento con texto "Año actual"
    const all = Array.from(document.querySelectorAll('*'));
    const anioEl = all.find(e => {
      const t = (e.innerText || e.textContent || '').trim();
      return t === 'Año actual';
    });

    // Todos los <li> con sus datos
    const liItems = Array.from(document.querySelectorAll('li'))
      .map(li => ({
        text: (li.innerText || '').trim().slice(0, 60),
        outerHTML: li.outerHTML.slice(0, 600),
        onclick: li.getAttribute('onclick') || null
      }))
      .filter(li => li.text)
      .slice(0, 15);

    // Todos los elementos con onclick
    const onclicks = Array.from(document.querySelectorAll('[onclick]'))
      .map(e => ({
        tag: e.tagName, id: e.id,
        text: (e.innerText || '').trim().slice(0, 40),
        onclick: e.getAttribute('onclick').slice(0, 250)
      }))
      .slice(0, 20);

    // ¿Existe __doPostBack?
    let hasDoPostBack = false;
    try { hasDoPostBack = typeof __doPostBack !== 'undefined'; } catch(e) {}

    // Fragmentos de scripts que mencionan doPostBack
    const scriptSnips = Array.from(document.querySelectorAll('script'))
      .map(s => s.textContent || '')
      .filter(t => t.includes('doPostBack'))
      .map(t => {
        const idx = t.indexOf('doPostBack');
        return t.slice(Math.max(0, idx - 40), idx + 120);
      })
      .slice(0, 5);

    // Todos los <a> (debería mostrar 0 si el frame principal no tiene)
    const links = Array.from(document.querySelectorAll('a'))
      .map(a => ({
        text: (a.innerText || '').trim().slice(0, 40),
        href: (a.getAttribute('href') || '').slice(0, 150),
        onclick: (a.getAttribute('onclick') || '').slice(0, 150)
      }))
      .filter(l => l.text || l.href)
      .slice(0, 30);

    return {
      anioEl: anioEl ? {
        tag: anioEl.tagName,
        id: anioEl.id || null,
        onclick: anioEl.getAttribute('onclick') || null,
        outerHTML: anioEl.outerHTML.slice(0, 600),
        parentTag: anioEl.parentElement ? anioEl.parentElement.tagName : null,
        parentOuterHTML: anioEl.parentElement ? anioEl.parentElement.outerHTML.slice(0, 800) : null
      } : null,
      liItems,
      onclicks,
      hasDoPostBack,
      scriptSnips,
      links,
      tdCount: document.querySelectorAll('td').length,
      url: location.href
    };
  });

  // Retornar diagnóstico directamente (sin esperar tabla)
  return { _diagnostic: true, diag };
}
`;
}

async function scrapeNuboxResumen() {
  const utn   = process.env.NUBOX_UTN;
  const token = process.env.BROWSERLESS_TOKEN;

  if (!utn)   throw new Error('Falta NUBOX_UTN en env vars');
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN en env vars');

  const targetUrl   = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;
  const browserCode = buildBrowserCode(targetUrl);

  let lastErr = null;

  for (const host of BROWSERLESS_HOSTS) {
    try {
      console.log(`[scraper] POST ${host}/function ...`);
      const resp = await fetch(`${host}/function?token=${token}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body:    browserCode,
        timeout: 45000,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Browserless HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      }

      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error) {
        throw new Error('Browser error: ' + result.error);
      }

      if (result._diagnostic) {
        // Modo diagnóstico: loguear todo y retornar error descriptivo
        console.warn('[scraper] DIAGNOSTIC:', JSON.stringify(result.diag));
        throw new Error('DIAGNOSTIC_MODE — ver logs para DOM info');
      }

      if (!Array.isArray(result.clientes)) {
        throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));
      }

      console.log(`[scraper] OK — ${result.clientes.length} clientes, meses: ${result.MESES?.join(', ')}`);
      return { clientes: result.clientes, meses: result.MESES || [] };

    } catch (err) {
      console.warn(`[scraper] ${host} falló: ${err.message}`);
      lastErr = err;
    }
  }

  throw new Error('Todos los endpoints de Browserless fallaron. Último error: ' + lastErr?.message);
}

module.exports = { scrapeNuboxResumen };
