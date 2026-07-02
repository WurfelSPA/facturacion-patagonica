/**
 * nubox-scraper.js
 * Browserless → Dashboard.aspx con UTN → extrae tabla del DOM (sin descarga de archivo)
 */
const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_APP = 'https://app.nubox.com';
const DASHBOARD = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;

async function extraerTablaViaBrowserless(utn) {
  const bToken = process.env.BROWSERLESS_TOKEN;
  if (!bToken) throw new Error('Falta BROWSERLESS_TOKEN');
  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  // IMPORTANTE: el script Browserless NO puede tener funciones async anidadas en page.evaluate.
  // Usamos networkidle2 para esperar AJAX en vez de setTimeout.
  // Extraemos la tabla directamente del DOM — sin descarga de archivo.
  const script = `
export default async ({ page }) => {
  const dashUrl = ${JSON.stringify(dashUrl)};

  try {
    await page.goto(dashUrl, { waitUntil: 'networkidle2', timeout: 50000 });
  } catch (e) {
    return Response.json({ ok: false, stage: 'goto', error: e.message });
  }

  const pageUrl   = page.url();
  const pageTitle = await page.title().catch(() => '');

  if (pageUrl.toLowerCase().includes('login') || pageUrl.toLowerCase().includes('account')) {
    return Response.json({ ok: false, stage: 'auth', error: 'UTN_EXPIRED', pageUrl });
  }

  const pageData = await page.evaluate(() => {
    const txt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 200) : '';
    if (!txt.includes('Resumen de Ventas') && !txt.includes('Resumen')) {
      return { ok: false, error: 'RESUMEN_NO_CARGADO', txt };
    }

    // Extraer TODAS las tablas de la pagina
    var tables = [];
    var allTables = document.querySelectorAll('table');
    for (var ti = 0; ti < allTables.length; ti++) {
      var tbl = allTables[ti];
      var tblRows = [];
      var trs = tbl.querySelectorAll('tr');
      for (var ri = 0; ri < trs.length; ri++) {
        var cells = [];
        var tds = trs[ri].querySelectorAll('td, th');
        for (var ci = 0; ci < tds.length; ci++) {
          cells.push(tds[ci].innerText.trim());
        }
        if (cells.length > 0) tblRows.push(cells);
      }
      if (tblRows.length > 0) tables.push(tblRows);
    }

    return { ok: true, tables: tables, txt: txt };
  }).catch(function(e) {
    return { ok: false, error: 'EVAL_ERROR: ' + e.message };
  });

  return Response.json({ ok: pageData.ok, pageUrl: pageUrl, pageTitle: pageTitle, data: pageData });
};
`;

  console.log('[scraper] Browserless → Dashboard.aspx extrayendo tabla DOM...');
  const resp = await fetch(
    `${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true&timeout=60000`,
    { method: 'POST', headers: { 'Content-Type': 'application/javascript' }, body: script }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Browserless HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  }

  const raw = await resp.json();
  console.log('[scraper] Browserless raw:', JSON.stringify(raw).slice(0, 500));

  if (!raw || !raw.ok) {
    throw new Error('Browserless fallo: ' + JSON.stringify(raw).slice(0, 500));
  }

  const tablas = (raw.data && raw.data.tables) || [];
  if (!tablas.length) {
    throw new Error('Sin tablas en DOM. pageUrl=' + raw.pageUrl + ' | ' + (raw.data && raw.data.txt || ''));
  }

  console.log(`[scraper] DOM OK — ${tablas.length} tabla(s), url: ${raw.pageUrl}`);
  return tablas;
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const tablas = await extraerTablaViaBrowserless(utn);
  return { tablas, excelBuffer: null, documentos: [], fuente: 'dom-dashboard' };
}

module.exports = { scrapeNubox };
