/**
 * nubox-scraper.js
 * Descarga directa sin Browserless:
 *   1. GET Dashboard.aspx?action=Ventas&utn=TOKEN  →  sesión en la IP de Render + ViewState
 *   2. POST con btnImprimirXLS                     →  Excel descargado
 */
const fetch = require('node-fetch');

const NUBOX_APP = 'https://app.nubox.com';
const DASHBOARD = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extraerHidden(html, name) {
  const re = new RegExp('id="' + name + '" value="([^"]*)"|name="' + name + '" value="([^"]*)"');
  const m = html.match(re);
  return m ? (m[1] || m[2] || '') : '';
}

function parsearCookies(headers) {
  const raw = headers.raw ? headers.raw()['set-cookie'] : null;
  if (raw && raw.length) return raw.map(c => c.split(';')[0]).join('; ');
  const single = headers.get('set-cookie');
  if (single) return single.split(';')[0];
  return '';
}

async function descargarExcelDirecto(utn) {
  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  // ── Paso 1: GET para obtener sesión + ViewState ───────────────────────────
  console.log('[scraper] GET Dashboard.aspx con UTN...');
  const getResp = await fetch(dashUrl, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-CL,es;q=0.9',
    },
    redirect: 'follow',
  });

  const cookies  = parsearCookies(getResp.headers);
  const html     = await getResp.text();
  const finalUrl = getResp.url;

  console.log(`[scraper] GET → ${getResp.status} url=${finalUrl} cookies=${cookies.slice(0, 60)}`);

  if (finalUrl.toLowerCase().includes('login') || finalUrl.toLowerCase().includes('account')) {
    throw new Error('UTN_EXPIRED: redirigido a ' + finalUrl);
  }
  if (html.toLowerCase().includes('nubox | error')) {
    throw new Error('UTN_INVALID: Nubox devolvió página de error. url=' + finalUrl);
  }

  const viewState    = extraerHidden(html, '__VIEWSTATE');
  const viewStateGen = extraerHidden(html, '__VIEWSTATEGENERATOR');
  const eventValid   = extraerHidden(html, '__EVENTVALIDATION');

  if (!viewState) {
    throw new Error('VIEWSTATE_NO_ENCONTRADO: url=' + finalUrl + ' html[:200]=' + html.slice(0, 200));
  }
  console.log(`[scraper] ViewState OK (${viewState.length} chars)`);

  // ── Paso 2: POST para exportar Excel ─────────────────────────────────────
  const params = new URLSearchParams();
  params.set('__VIEWSTATE',          viewState);
  params.set('__VIEWSTATEGENERATOR', viewStateGen);
  params.set('__EVENTVALIDATION',    eventValid);
  params.set('btnImprimirXLS',       'Exportar');
  params.set('selector',             '0');

  console.log('[scraper] POST exportar Excel...');
  const postResp = await fetch(DASHBOARD, {
    method:  'POST',
    headers: {
      'User-Agent':   UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       cookies,
      'Referer':      dashUrl,
    },
    body: params.toString(),
  });

  const ct = postResp.headers.get('content-type') || '';
  const cd = postResp.headers.get('content-disposition') || '';
  console.log(`[scraper] POST → ${postResp.status} ct=${ct} cd=${cd}`);

  if (ct.includes('excel') || ct.includes('spreadsheet') || ct.includes('octet-stream') || cd.includes('.xls')) {
    const buf = await postResp.buffer();
    console.log(`[scraper] Excel OK — ${buf.length} bytes`);
    return buf;
  }

  const txt = await postResp.text();
  throw new Error(`POST_DEVOLVIO_HTML: status=${postResp.status} ct=${ct} cd=${cd} | ${txt.slice(0, 400)}`);
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const excelBuffer = await descargarExcelDirecto(utn);
  return { excelBuffer, tablas: null, documentos: [], fuente: 'http-directo' };
}

module.exports = { scrapeNubox };
