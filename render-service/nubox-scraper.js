/**
 * nubox-scraper.js
 * Flujo de dos pasos:
 *   1. GET Dashboard.aspx?utn=TOKEN  →  crea sesión ASP.NET en la IP de Render
 *   2. GET dtePrincipal.aspx (con cookie de sesión)  →  lista completa de DTEs
 *   3. POST botón export XLS  →  descarga Excel con DTEs individuales
 */
const fetch = require('node-fetch');

const NUBOX_APP = 'https://app.nubox.com';
const DASHBOARD = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;
const DTE_PAGE  = `${NUBOX_APP}/ServiFactura/paginas/dtePrincipal.aspx`;

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

function mergeCookies(base, nuevas) {
  const mapa = {};
  for (const par of (base || '').split(';').map(s => s.trim()).filter(Boolean)) {
    const k = par.split('=')[0].trim();
    mapa[k] = par;
  }
  for (const par of (nuevas || '').split(';').map(s => s.trim()).filter(Boolean)) {
    const k = par.split('=')[0].trim();
    mapa[k] = par;
  }
  return Object.values(mapa).join('; ');
}

function detectarBotonExport(html) {
  const candidatos = [
    'btnImprimirXLS','btnExportarXLS','btnExportXLS',
    'btnExportExcel','btnExportarExcel','btnImprimirExcel',
    'btnDescargaExcel','btnDownload','btnExportar',
  ];
  for (const n of candidatos) {
    if (html.includes(n)) return n;
  }
  const m = html.match(/name="([^"]*(?:xls|excel|export|imprimir)[^"]*)"/i);
  return m ? m[1] : null;
}

async function descargarExcelDirecto(utn) {
  const hdrs = {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-CL,es;q=0.9',
  };

  // ── Paso 1: GET Dashboard?utn=TOKEN → crear sesión ───────────────────────
  console.log('[scraper] Paso 1: GET Dashboard.aspx con UTN...');
  const r1 = await fetch(`${DASHBOARD}&utn=${encodeURIComponent(utn)}`, { headers: hdrs, redirect: 'follow' });
  let cookies = parsearCookies(r1.headers);
  const url1  = r1.url;
  await r1.text(); // consumir body
  console.log(`[scraper] Paso 1 → ${r1.status} url=${url1} cookies=${cookies.slice(0, 60)}`);

  if (url1.toLowerCase().includes('login') || url1.toLowerCase().includes('account')) {
    throw new Error('UTN_EXPIRED: redirigido a ' + url1);
  }
  if (!cookies) throw new Error('SIN_COOKIES: Dashboard no devolvió cookies. ¿UTN expirado?');

  // ── Paso 2: GET dtePrincipal.aspx con cookie de sesión ───────────────────
  console.log('[scraper] Paso 2: GET dtePrincipal.aspx...');
  const r2 = await fetch(DTE_PAGE, {
    headers: { ...hdrs, 'Cookie': cookies, 'Referer': DASHBOARD },
    redirect: 'follow',
  });
  const nuevasCookies2 = parsearCookies(r2.headers);
  if (nuevasCookies2) cookies = mergeCookies(cookies, nuevasCookies2);
  const html2 = await r2.text();
  const url2  = r2.url;
  console.log(`[scraper] Paso 2 → ${r2.status} url=${url2} html_len=${html2.length}`);

  if (url2.toLowerCase().includes('login') || url2.toLowerCase().includes('account')) {
    throw new Error('SIN_SESION: dtePrincipal redirigió a login. url=' + url2);
  }
  if (html2.toLowerCase().includes('<title>nubox | error</title>')) {
    throw new Error('NUBOX_ERROR_PAGE en dtePrincipal. ¿Sesión inválida? html[:200]=' + html2.slice(0, 200));
  }

  const viewState    = extraerHidden(html2, '__VIEWSTATE');
  const viewStateGen = extraerHidden(html2, '__VIEWSTATEGENERATOR');
  const eventValid   = extraerHidden(html2, '__EVENTVALIDATION');

  if (!viewState) {
    throw new Error('VIEWSTATE_NO_ENCONTRADO en dtePrincipal. url=' + url2 + ' html[:300]=' + html2.slice(0, 300));
  }

  const boton = detectarBotonExport(html2);
  if (!boton) {
    const btns = [...html2.matchAll(/name="(btn[^"]+)"/gi)].map(m => m[1]).slice(0, 20).join(', ');
    throw new Error(`BOTON_NO_ENCONTRADO en dtePrincipal. Botones btn*: [${btns || 'ninguno'}] | title=${html2.match(/<title>([^<]*)<\/title>/i)?.[1]}`);
  }
  console.log(`[scraper] ViewState OK (${viewState.length} chars) | botón: ${boton}`);

  // ── Paso 3: POST exportar Excel ───────────────────────────────────────────
  const params = new URLSearchParams();
  params.set('__VIEWSTATE',          viewState);
  params.set('__VIEWSTATEGENERATOR', viewStateGen);
  params.set('__EVENTVALIDATION',    eventValid);
  params.set(boton,                  'Exportar');

  console.log('[scraper] Paso 3: POST exportar Excel...');
  const r3 = await fetch(DTE_PAGE, {
    method: 'POST',
    headers: {
      'User-Agent':   UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       cookies,
      'Referer':      DTE_PAGE,
    },
    body: params.toString(),
  });

  const ct = r3.headers.get('content-type') || '';
  const cd = r3.headers.get('content-disposition') || '';
  console.log(`[scraper] Paso 3 → ${r3.status} ct=${ct} cd=${cd}`);

  if (ct.includes('excel') || ct.includes('spreadsheet') || ct.includes('octet-stream') || cd.includes('.xls')) {
    const buf = await r3.buffer();
    console.log(`[scraper] Excel OK — ${buf.length} bytes`);
    return buf;
  }

  const txt = await r3.text();
  throw new Error(`POST_DEVOLVIO_HTML: status=${r3.status} ct=${ct} cd=${cd} | ${txt.slice(0, 400)}`);
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const excelBuffer = await descargarExcelDirecto(utn);
  return { excelBuffer, tablas: null, documentos: [], fuente: 'http-directo' };
}

module.exports = { scrapeNubox };
