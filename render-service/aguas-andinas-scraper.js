/**
 * render-service/aguas-andinas-scraper.js
 *
 * Invoca Browserless /function con el código Puppeteer de Aguas Andinas.
 * Sustituye __RUT__ y __CLAVE__ con las env vars AGUAS_ANDINAS_USER / AGUAS_ANDINAS_PASS.
 *
 * Env vars requeridas:
 *   BROWSERLESS_TOKEN   — token de Browserless.io
 *   AGUAS_ANDINAS_USER  — RUT de acceso al portal (e.g. "12345678-9")
 *   AGUAS_ANDINAS_PASS  — Contraseña del portal
 */

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const BROWSERLESS_HOSTS = [
  'https://production-sfo.browserless.io',
  'https://production-lon.browserless.io',
];

// Node-fetch socket timeout: 2 min (Browserless usa el default del plan)
const NODE_FETCH_TIMEOUT_MS = 120000;

function buildBrowserCode() {
  const tpl   = fs.readFileSync(path.join(__dirname, 'aguas-andinas-browser.js'), 'utf8');
  const rut   = process.env.AGUAS_ANDINAS_USER  || '';
  const clave = process.env.AGUAS_ANDINAS_PASS  || '';
  if (!rut || !clave) throw new Error('Faltan AGUAS_ANDINAS_USER y/o AGUAS_ANDINAS_PASS');
  return tpl
    .replace('__RUT__',   JSON.stringify(rut))
    .replace('__CLAVE__', JSON.stringify(clave));
}

async function scrapeAguasAndinas() {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN');

  const browserCode = buildBrowserCode();
  let lastErr = null;

  for (const host of BROWSERLESS_HOSTS) {
    try {
      const url = `${host}/function?token=${token}`;
      console.log('[aguas] POST', host + '/function ...');

      const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body:    browserCode,
        timeout: NODE_FETCH_TIMEOUT_MS,
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.slice(0, 300)}`);
      }

      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error) {
        throw new Error('Browser error: ' + result.error);
      }
      if (!Array.isArray(result.results)) {
        throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));
      }

      console.log(`[aguas] OK — ${result.total} boletas descargadas, ${result.failures} fallos`);
      if (result.failureList && result.failureList.length > 0) {
        console.warn('[aguas] Fallos:', JSON.stringify(result.failureList).slice(0, 500));
      }
      return result;

    } catch (err) {
      console.warn(`[aguas] ${host} falló: ${err.message.slice(0, 200)}`);
      lastErr = err;
    }
  }

  throw new Error('Todos los endpoints Browserless fallaron. Último: ' + lastErr.message);
}

module.exports = { scrapeAguasAndinas };
