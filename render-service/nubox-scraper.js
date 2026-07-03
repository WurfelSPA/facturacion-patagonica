/**
 * render-service/nubox-scraper.js v29
 * Single-phase: una sola llamada Browserless que espera hasta 90s para que
 * SSRS renderice el reporte en el DOM, luego extrae los datos.
 * (La sesion de Browserless Standard permite sesiones largas)
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

async function callBrowserless(browserCode, timeoutMs) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN');
  let lastErr = null;
  for (const host of BROWSERLESS_HOSTS) {
    try {
      console.log('[scraper] POST ' + host + '/function ...');
      const resp = await fetch(host + '/function?token=' + token, {
        method:  'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body:    browserCode,
        timeout: timeoutMs || 150000,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('HTTP ' + resp.status + ': ' + t.slice(0, 300));
      }
      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;
      if (result && result.error) throw new Error('Browser error: ' + result.error);
      return result;
    } catch(err) {
      console.warn('[scraper] ' + host + ' fallo: ' + err.message.slice(0, 200));
      lastErr = err;
    }
  }
  throw new Error('Todos los endpoints fallaron. Ultimo: ' + lastErr.message);
}

async function scrapeNuboxResumen() {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN');

  const targetUrl = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas&utn=' + encodeURIComponent(utn);

  console.log('[scraper] Iniciando — esperando hasta 90s para que SSRS renderice...');
  const result = await callBrowserless(buildBrowserCode(targetUrl), 150000);

  if (!Array.isArray(result.clientes)) {
    throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 300));
  }

  console.log('[scraper] OK — ' + result.clientes.length + ' clientes, meses: ' + (result.MESES || []).join(', '));
  return { clientes: result.clientes, meses: result.MESES || [] };
}

module.exports = { scrapeNuboxResumen };
