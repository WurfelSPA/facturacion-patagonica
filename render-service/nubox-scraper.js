/**
 * nubox-scraper.js
 * Descarga Excel desde dtePrincipal.aspx (resumen anual de DTEs Nubox)
 *   1. GET dtePrincipal.aspx?utn=TOKEN  →  sesion en la IP de Render + ViewState
 *   2. POST con botón de exportación XLS →  Excel con los DTEs del año
 */
const fetch = require('node-fetch');

const NUBOX_APP = 'https://app.nubox.com';
const DTE_PAGE  = `${NUBOX_APP}/ServiFactura/paginas/dtePrincipal.aspx`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extraerHidden(html, name) {
  const re = new RegExp('id="' + name + '" value="([^"]*)"|' +
                        'name="' + name + '" value="([^"]*)"');
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

/**
 * Busca en el HTML botones (<input type="submit">, <button>) cuyo name/id/value
 * sugiera exportación Excel. Devuelve el primero encontrado o null.
 */
function detectarBotonExport(html) {
  // Orden de preferencia
  const candidatos = [
    'btnImprimirXLS', 'btnExportarXLS', 'btnExportXLS',
    'btnExportExcel', 'btnExportarExcel', 'btnImprimirExcel',
    'btnDescargaExcel', 'btnDownload', 'btnExportar',
  ];
  for (const nombre of candidatos) {
    if (html.includes(nombre)) return nombre;
  }
  // Búsqueda genérica: input type=submit con name que contenga "xls" o "excel"
  const m = html.match(/name="([^"]*(?:xls|excel|export|imprimir)[^"]*)"/i);
  if (m) return m[1];
  return null;
}

async function descargarExcelDirecto(utn) {
  const pageUrl = `${DTE_PAGE}?utn=${encodeURIComponent(utn)}`;

  // ── Paso 1: GET para obtener sesión + ViewState ──────────────────────────
  console.log('[scraper] GET dtePrincipal.aspx con UTN...');
  const getResp = await fetch(pageUrl, {
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

  const viewState    = extraerHidden(html, '__VIEWSTATE');
  const viewStateGen = extraerHidden(html, '__VIEWSTATEGENERATOR');
  const eventValid   = extraerHidden(html, '__EVENTVALIDATION');

  if (!viewState) {
    throw new Error('VIEWSTATE_NO_ENCONTRADO: url=' + finalUrl + ' | html[:300]=' + html.slice(0, 300));
  }

  // Detectar botón de exportación
  const boton = detectarBotonExport(html);
  if (!boton) {
    // Loguear los primeros 500 chars del HTML para diagnóstico
    throw new Error('BOTON_NO_ENCONTRADO: botones disponibles en html -> ' +
      [...html.matchAll(/name="(btn[^"]+)"/gi)].map(m => m[1]).join(', ') +
      ' | html[:400]=' + html.slice(0, 400));
  }
  console.log(`[scraper] ViewState OK (${viewState.length} chars) | botón: ${boton}`);

  // ── Paso 2: POST para exportar Excel ─────────────────────────────────────
  const params = new URLSearchParams();
  params.set('__VIEWSTATE',          viewState);
  params.set('__VIEWSTATEGENERATOR', viewStateGen);
  params.set('__EVENTVALIDATION',    eventValid);
  params.set(boton,                  'Exportar');

  console.log('[scraper] POST exportar Excel...');
  const postResp = await fetch(DTE_PAGE, {
    method: 'POST',
    headers: {
      'User-Agent':   UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       cookies,
      'Referer':      pageUrl,
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
