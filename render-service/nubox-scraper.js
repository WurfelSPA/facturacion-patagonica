/**
 * render-service/nubox-scraper.js
 *
 * Lee el browser code desde browser-code.js (archivo separado, sin escaping).
 * Sustituye '__NUBOX_URL__' con la URL real del dashboard.
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

      if (result.error === 'DIAG_v10') {
        console.warn('[v10-ssrsLoaded]', result.ssrsLoaded);
        console.warn('[v10-hdnMesesMostrar]', JSON.stringify(result.pageInfo && result.pageInfo.hdnMesesMostrar));
        console.warn('[v10-fnCtx]', (result.pageInfo && result.pageInfo.fnCtx || '').replace(/\n/g, ' ').slice(0, 1500));
        console.warn('[v10-pbTargets]', JSON.stringify(result.pageInfo && result.pageInfo.pbTargets));
        console.warn('[v10-clickables]', JSON.stringify(result.pageInfo && result.pageInfo.clickables));
        console.warn('[v10-aspNet]', JSON.stringify(result.pageInfo && result.pageInfo.aspNet));
        console.warn('[v10-onclickResult]', JSON.stringify(result.onclickResult));
        console.warn('[v10-triedTargets]', JSON.stringify(result.triedTargets));
        console.warn('[v10-state2]', JSON.stringify(result.state2));
        console.warn('[v10-reqLog]', JSON.stringify(result.reqLog));
        throw new Error('DIAG_v10');
      }

      if (result.error) throw new Error('Browser error: ' + result.error);
      if (!Array.isArray(result.clientes)) throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));

      console.log('[scraper] OK - ' + result.clientes.length + ' clientes, meses: ' + (result.MESES || []).join(', '));
      return { clientes: result.clientes, meses: result.MESES || [] };
    } catch(err) {
      console.warn('[scraper] ' + host + ' fallo: ' + err.message.slice(0, 80));
      lastErr = err;
    }
  }
  throw new Error('Todos los endpoints fallaron. Ultimo: ' + lastErr.message);
}

module.exports = { scrapeNuboxResumen };
