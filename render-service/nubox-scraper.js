/**
 * render-service/nubox-scraper.js v28
 * Fase 1: Browserless captura ControlID + cookies (~12s)
 * Fase 2: Node.js espera 50s
 * Fase 3: Browserless restaura sesion + extrae DOM (reporte deberia estar cacheado)
 */

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const BROWSERLESS_HOSTS = [
  'https://production-sfo.browserless.io',
  'https://production-lon.browserless.io',
];

function buildBrowserCodeP1(targetUrl) {
  const template = fs.readFileSync(path.join(__dirname, 'browser-code.js'), 'utf8');
  return template.replace("'__NUBOX_URL__'", JSON.stringify(targetUrl));
}

function buildBrowserCodeP2(targetUrl, cookies) {
  const template = fs.readFileSync(path.join(__dirname, 'browser-code-p2.js'), 'utf8');
  return template
    .replace('__COOKIES_JSON__', JSON.stringify(cookies))
    .replace('__TARGET_URL__', JSON.stringify(targetUrl));
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
        timeout: timeoutMs || 30000,
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

async function scrapeNuboxResumen() {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN');

  const targetUrl = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas&utn=' + encodeURIComponent(utn);

  // FASE 1: Capturar cookies y ControlID via Browserless (~12s)
  console.log('[scraper] Fase 1: capturando sesion...');
  const phase1 = await callBrowserless(buildBrowserCodeP1(targetUrl), 25000);
  if (!phase1.phase1 || !phase1.controlId) {
    throw new Error('Fase1 sin ControlID: ' + JSON.stringify(phase1).slice(0, 200));
  }
  const { controlId, cookies } = phase1;
  console.log('[scraper] Fase 1 OK — ControlID=' + controlId + ', cookies=' + cookies.length);

  // FASE 2: Esperar 50s para que el servidor SSRS renderice el reporte
  console.log('[scraper] Fase 2: esperando 50s para que SSRS procese...');
  await new Promise(function(resolve) { setTimeout(resolve, 50000); });

  // FASE 3: Restaurar sesion + extraer DOM via Browserless (~20-60s)
  console.log('[scraper] Fase 3: extrayendo datos del DOM con sesion restaurada...');
  const result = await callBrowserless(buildBrowserCodeP2(targetUrl, cookies), 90000);

  if (!Array.isArray(result.clientes)) {
    throw new Error('Fase3 respuesta inesperada: ' + JSON.stringify(result).slice(0, 300));
  }

  console.log('[scraper] OK — ' + result.clientes.length + ' clientes, meses: ' + (result.MESES || []).join(', '));
  return { clientes: result.clientes, meses: result.MESES || [] };
}

module.exports = { scrapeNuboxResumen };
