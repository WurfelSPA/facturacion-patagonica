/**
 * render-service/nubox-scraper.js v23
 * Fase 1: Browserless (captura ControlID + cookies, ~12s)
 * Fase 2: Node.js fetch directo al endpoint SSRS CSV (sin limite de 60s)
 */

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const BROWSERLESS_HOSTS = [
  'https://production-sfo.browserless.io',
  'https://production-lon.browserless.io',
];

function buildBrowserCode(targetUrl) {
  const template = fs.readFileSync(path.join(__dirname, 'browser-code.js'), 'utf8');
  return template.replace("'__NUBOX_URL__'", JSON.stringify(targetUrl));
}

async function callBrowserless(browserCode) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN');
  let lastErr = null;
  for (const host of BROWSERLESS_HOSTS) {
    try {
      console.log('[scraper] POST ' + host + '/function ...');
      const resp = await fetch(host + '/function?token=' + token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body: browserCode,
        timeout: 30000,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('HTTP ' + resp.status + ': ' + t.slice(0, 200));
      }
      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;
      if (result.error) throw new Error('Browser error: ' + result.error);
      return result;
    } catch(err) {
      console.warn('[scraper] ' + host + ' fallo: ' + err.message.slice(0, 200));
      lastErr = err;
    }
  }
  throw new Error('Todos los endpoints Browserless fallaron: ' + lastErr.message);
}

async function exportSSRSCsv(controlId, cookies) {
  const exportUrl =
    'https://app.nubox.com/ServiFactura/Reserved.ReportViewerWebControl.axd' +
    '?OpType=Export&ControlID=' + controlId +
    '&ReportStack=1&Format=CSV&ContentDisposition=AlwaysInline';

  const cookieStr = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');

  console.log('[scraper] Exportando CSV: ControlID=' + controlId);

  const resp = await fetch(exportUrl, {
    method:  'GET',
    headers: {
      'Cookie':     cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Referer':    'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx',
      'Accept':     '*/*',
    },
    timeout: 30000,
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error('Export HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
  if (!text || text.length < 50) {
    throw new Error('CSV vacio: ' + text.slice(0, 100));
  }
  if (text.charCodeAt(0) === 60) { // '<' = HTML error
    throw new Error('Export devolvio HTML (no CSV). Preview: ' + text.slice(0, 300));
  }

  return text;
}

async function scrapeNuboxResumen() {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN');

  const targetUrl  = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas&utn=' + encodeURIComponent(utn);
  const browserCode = buildBrowserCode(targetUrl);

  // FASE 1: Browserless — cargar pagina, capturar ControlID + cookies (~12s)
  console.log('[scraper] Fase 1: capturando ControlID via Browserless...');
  const phase1 = await callBrowserless(browserCode);

  if (!phase1.phase1 || !phase1.controlId) {
    throw new Error('Fase1 sin ControlID: ' + JSON.stringify(phase1).slice(0, 200));
  }

  const { controlId, cookies } = phase1;
  console.log('[scraper] Fase 1 OK — ControlID=' + controlId + ', cookies=' + cookies.length);

  // FASE 2: Esperar 50s para que SSRS renderice el reporte en el servidor
  console.log('[scraper] Fase 2: esperando 50s para que SSRS procese el reporte...');
  await new Promise(function(resolve) { setTimeout(resolve, 50000); });

  // FASE 3: Exportar CSV directamente (Node.js fetch, sin browser)
  console.log('[scraper] Fase 3: exportando CSV...');
  let csvText = null;
  let lastErr  = null;

  for (let intento = 0; intento < 3; intento++) {
    try {
      csvText = await exportSSRSCsv(controlId, cookies);
      console.log('[scraper] CSV OK — ' + csvText.length + ' bytes, intento ' + intento);
      break;
    } catch(err) {
      console.warn('[scraper] Export intento ' + intento + ' fallo: ' + err.message.slice(0, 200));
      lastErr = err;
      if (intento < 2) await new Promise(function(resolve) { setTimeout(resolve, 10000); });
    }
  }

  if (!csvText) {
    throw new Error('Export CSV fallo: ' + lastErr.message);
  }

  // FASE 4: Parsear CSV — retornar preview para verificar formato
  const lines = csvText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
  console.log('[scraper] CSV parseado: ' + lines.length + ' lineas');

  // Devolver datos crudos para inspeccion del formato
  return {
    _csvPreview: lines.slice(0, 8).join('\n'),
    _totalLineas: lines.length,
    clientes: [],
    MESES: [],
  };
}

module.exports = { scrapeNuboxResumen };
