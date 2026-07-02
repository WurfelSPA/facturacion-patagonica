/**
 * nubox-scraper.js
 * Browserless v2 API: retorna { data: {...}, type: "application/json" }
 * NO usar Response.json() -- eso es v1 y devuelve {} silenciosamente
 */
const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_APP = 'https://app.nubox.com';
const DASHBOARD = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;

async function extraerTablaViaBrowserless(utn) {
  const bToken = process.env.BROWSERLESS_TOKEN;
  if (!bToken) throw new Error('Falta BROWSERLESS_TOKEN');
  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  const script = `
export default async ({ page }) => {
  const dashUrl = ${JSON.stringify(dashUrl)};

  try {
    await page.goto(dashUrl, { waitUntil: 'networkidle2', timeout: 50000 });
  } catch (e) {
    return { data: { ok: false, stage: 'goto', error: e.message }, type: 'application/json' };
  }

  const pageUrl   = page.url();
  const pageTitle = await page.title().catch(() => '');

  if (pageUrl.toLowerCase().includes('login') || pageUrl.toLowerCase().includes('account')) {
    return { data: { ok: false, stage: 'auth', error: 'UTN_EXPIRED', pageUrl }, type: 'application/json' };
  }

  const pageData = await page.evaluate(() => {
    var txt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 200) : '';
    if (txt.indexOf('Resumen') === -1 && txt.indexOf('Ventas') === -1) {
      return { ok: false, error: 'RESUMEN_NO_CARGADO', txt: txt };
    }
    var tables = [];
    var allTables = document.querySelectorAll('table');
    for (var ti = 0; ti < allTables.length; ti++) {
      var tblRows = [];
      var trs = allTables[ti].querySelectorAll('tr');
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

  return {
    data: { ok: pageData.ok, pageUrl: pageUrl, pageTitle: pageTitle, pageData: pageData },
    type: 'application/json'
  };
};
`;

  console.log('[scraper] Browserless v2 → Dashboard.aspx, extrayendo tabla...');
  const resp = await fetch(
    `${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true`,
    { method: 'POST', headers: { 'Content-Type': 'application/javascript' }, body: script }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Browserless HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  }

  // Browserless v2 envuelve en { data: {...}, type: "application/json" }
  const raw = await resp.json();
  const result = (raw && raw.data !== undefined) ? raw.data : raw;
  console.log('[scraper] Browserless result:', JSON.stringify(result).slice(0, 500));

  if (!result || !result.ok) {
    throw new Error('Browserless fallo: ' + JSON.stringify(result).slice(0, 500));
  }

  const tablas = (result.pageData && result.pageData.tables) || [];
  if (!tablas.length) {
    throw new Error('Sin tablas en DOM. pageUrl=' + result.pageUrl + ' | ' + (result.pageData && result.pageData.txt || ''));
  }

  console.log(`[scraper] Tablas OK — ${tablas.length} tabla(s), url: ${result.pageUrl}`);
  return tablas;
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const tablas = await extraerTablaViaBrowserless(utn);
  return { tablas, excelBuffer: null, documentos: [], fuente: 'dom-dashboard' };
}

module.exports = { scrapeNubox };
