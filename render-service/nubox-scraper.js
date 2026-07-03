/**
 * render-service/nubox-scraper.js
 *
 * Fix v7: diagnóstico quirúrgico para encontrar el mecanismo real que cambia
 * la vista de "Últimos 12 meses" a "Año actual" en el Nubox SSRS.
 *
 * Captura:
 *   1. TODOS los textos de los 46 <td> (para ver qué contiene la tabla actual)
 *   2. Scripts inline filtrados por "selector", "ulRB", "s-option", "periodo"
 *   3. Handlers jQuery si están disponibles
 *   4. Intenta también URL con &selector=1 para ver si es un parámetro URL
 */

const fetch = require('node-fetch');

const DASHBOARD = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas';

const BROWSERLESS_HOSTS = [
  'https://production-sfo.browserless.io',
  'https://production-lon.browserless.io',
];

function buildBrowserCode(targetUrl) {
  // También construimos la URL con selector=1
  const urlWithSelector = targetUrl + '&selector=1';

  return `
export default async function({ page }) {
  // ── FASE 1: cargar página por defecto ─────────────────────────────────────
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  await new Promise(r => setTimeout(r, 6000));

  // ── FASE 2: capturar todos los tds y scripts relevantes ───────────────────
  const diag = await page.evaluate(() => {
    // A. Todos los textos de tds (tabla actual)
    const tdTexts = Array.from(document.querySelectorAll('td'))
      .map(td => td.innerText.trim())
      .filter(t => t.length > 0);

    // B. Scripts inline filtrados por palabras clave relevantes
    const keywords = ['selector', 'ulRB', 's-option', 'f-option', 'periodo', 'Period', 'rbSelector', 'anio', 'Anio', 'verReporte', 'cargarReporte', 'loadReport'];
    const filteredScripts = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => {
        const t = s.textContent || '';
        const matched = keywords.some(k => t.includes(k));
        return matched ? t : null;
      })
      .filter(Boolean)
      .join('\\n\\n========\\n\\n')
      .slice(0, 6000);

    // C. Detectar jQuery y sus event handlers en el radio
    let jqEvents = null;
    if (typeof $ !== 'undefined' && $._data) {
      try {
        const el = document.getElementById('s-option');
        jqEvents = JSON.stringify($._data(el, 'events') || {});
      } catch(e) { jqEvents = 'error: ' + e.message; }
    }

    // D. Todos los elementos con event listeners inline + visible radio state
    const radioEl = document.getElementById('s-option');
    const radioInfo = radioEl ? {
      checked: radioEl.checked,
      value: radioEl.value,
      name: radioEl.name,
      outerHTML: radioEl.outerHTML,
    } : null;

    // E. Buscar cualquier función que contenga "selector" en nombre/cuerpo  
    const windowFns = Object.keys(window)
      .filter(k => typeof window[k] === 'function' && k.toLowerCase().includes('selector'))
      .join(', ');

    // F. Capturar src de todos los scripts externos
    const externalScripts = Array.from(document.querySelectorAll('script[src]'))
      .map(s => s.src)
      .filter(u => !u.includes('Microsoft') && !u.includes('WebResource'))
      .slice(0, 10);

    return { tdTexts, filteredScripts, jqEvents, radioInfo, windowFns, externalScripts };
  });

  // ── FASE 3: intentar cargar URL con &selector=1 ───────────────────────────
  await page.goto(${JSON.stringify(urlWithSelector)}, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 6000));

  const diagSelector1 = await page.evaluate(() => {
    const tdTexts = Array.from(document.querySelectorAll('td'))
      .map(td => td.innerText.trim())
      .filter(t => t.length > 0);
    const bodySnip = document.body.innerText.slice(0, 800);
    const radioChecked = document.getElementById('s-option')?.checked;
    return { tdCount: document.querySelectorAll('td').length, tdTexts, bodySnip, radioChecked };
  });

  return { error: 'DIAG_v7', diag, diagSelector1 };
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
        timeout: 90000,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Browserless HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      }

      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error === 'DIAG_v7') {
        const d = result.diag;
        console.warn('[v7] TDs actuales:', JSON.stringify(d.tdTexts));
        console.warn('[v7] Scripts filtrados:\n', d.filteredScripts || '(ninguno)');
        console.warn('[v7] jQuery events:', d.jqEvents || 'jQuery no detectado');
        console.warn('[v7] Window fns con "selector":', d.windowFns || 'ninguna');
        console.warn('[v7] External scripts:', JSON.stringify(d.externalScripts));
        console.warn('[v7] URL con &selector=1 — tdCount:', result.diagSelector1.tdCount);
        console.warn('[v7] URL con &selector=1 — tds:', JSON.stringify(result.diagSelector1.tdTexts));
        console.warn('[v7] URL con &selector=1 — radioChecked:', result.diagSelector1.radioChecked);
        console.warn('[v7] URL con &selector=1 — bodySnip:', result.diagSelector1.bodySnip);
        throw new Error('DIAG_v7 — ver logs');
      }

      if (result.error) throw new Error('Browser error: ' + result.error);
      if (!Array.isArray(result.clientes)) {
        throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));
      }

      console.log(`[scraper] OK — ${result.clientes.length} clientes, meses: ${result.MESES?.join(', ')}`);
      return { clientes: result.clientes, meses: result.MESES || [] };

    } catch (err) {
      console.warn(`[scraper] ${host} falló: ${err.message.slice(0, 100)}`);
      lastErr = err;
    }
  }

  throw new Error('Todos los endpoints de Browserless fallaron. Último error: ' + lastErr?.message);
}

module.exports = { scrapeNuboxResumen };
