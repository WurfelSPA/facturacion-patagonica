/**
 * render-service/nubox-scraper.js
 * Lee browser-code.js separado y sustituye __NUBOX_URL__.
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

async function scrapeNuboxResumen() {
  const utn   = process.env.NUBOX_UTN;
  const token = process.env.BROWSERLESS_TOKEN;
  if (!utn)   throw new Error('Falta NUBOX_UTN');
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN');

  const targetUrl   = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas&utn=' + encodeURIComponent(utn);
  const browserCode = buildBrowserCode(targetUrl);
  let lastErr = null;

  for (const host of BROWSERLESS_HOSTS) {
    try {
      console.log('[scraper] POST ' + host + '/function ...');
      const resp = await fetch(host + '/function?token=' + token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body: browserCode,
        timeout: 90000,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('HTTP ' + resp.status + ': ' + t.slice(0, 200));
      }
      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error && result.error.startsWith('DIAG_')) {
        console.warn('[diag-ssrsLoaded]', result.ssrsLoaded);
        console.warn('[diag-tdsBefore]', result.tdsBefore);
        console.warn('[diag-step1]', JSON.stringify(result.step1));
        console.warn('[diag-results]', JSON.stringify(result.results));
        console.warn('[diag-reqLog]', JSON.stringify(result.reqLog));
        throw new Error(result.error);
      }

      if (result.error) {
        // Loguear diag si existe (ej: SSRS_TIMEOUT con estado del DOM)
        if (result.diag) {
          console.warn('[scraper] diag:', JSON.stringify(result.diag));
        }
        if (result.details) {
          console.warn('[scraper] details:', JSON.stringify(result.details));
        }
        const e = new Error('Browser error: ' + result.error + (result.diag ? ' | diag=' + JSON.stringify(result.diag) : ''));
        e.details = result.details;
        throw e;
      }
      if (!Array.isArray(result.clientes)) throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));

      console.log('[scraper] OK - ' + result.clientes.length + ' clientes, meses: ' + (result.MESES || []).join(', '));
      return { clientes: result.clientes, meses: result.MESES || [] };
    } catch(err) {
      console.warn('[scraper] ' + host + ' fallo: ' + err.message.slice(0, 200));
      lastErr = err;
    }
  }
  const finalErr = new Error('Todos los endpoints fallaron. Ultimo: ' + lastErr.message);
  finalErr.details = lastErr.details;
  throw finalErr;
}

module.exports = { scrapeNuboxResumen };
