/**
 * nubox-scraper.js
 * Flujo de 3 pasos para exportar "Resumen de Ventas Últimos 12 meses":
 *   1. GET Dashboard.aspx?utn=TOKEN  →  sesión + ViewState inicial
 *   2. POST btnBusquedaPorVencer      →  servidor renderiza reporte, devuelve ViewState con datos
 *   3. POST btnImprimirXLS            →  Excel descargado (application/vnd.ms-excel)
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

function mergeCookies(base, nuevas) {
  const mapa = {};
  for (const par of (base || '').split(';').map(s => s.trim()).filter(Boolean)) {
    const k = par.split('=')[0].trim();
    if (k) mapa[k] = par;
  }
  for (const par of (nuevas || '').split(';').map(s => s.trim()).filter(Boolean)) {
    const k = par.split('=')[0].trim();
    if (k) mapa[k] = par;
  }
  return Object.values(mapa).join('; ');
}

function baseParams(html) {
  // Extraer los campos ocultos estándar de ASP.NET + ReportViewer
  const p = new URLSearchParams();
  p.set('__VIEWSTATE',          extraerHidden(html, '__VIEWSTATE'));
  p.set('__VIEWSTATEGENERATOR', extraerHidden(html, '__VIEWSTATEGENERATOR'));
  p.set('__EVENTVALIDATION',    extraerHidden(html, '__EVENTVALIDATION'));
  // Campos ReportViewer conocidos necesarios para que el servidor reconozca el estado
  p.set('ReportViewer1$AsyncWait$HiddenCancelField',      'False');
  p.set('ReportViewer1$ToggleParam$collapse',              'false');
  p.set('ReportViewer1$ToggleParam$store',                 '');
  p.set('ReportViewer1$ctl07$collapse',                    'false');
  p.set('ReportViewer1$ctl07$store',                       '');
  p.set('ReportViewer1$ctl08$ClientClickedId',             '');
  p.set('ReportViewer1$ctl09$ReportControl$ctl02',         '');
  p.set('ReportViewer1$ctl09$ReportControl$ctl03',         '');
  p.set('ReportViewer1$ctl09$ReportControl$ctl04',         '100');
  p.set('ReportViewer1$ctl09$ScrollPosition',              '');
  p.set('ReportViewer1$ctl09$VisibilityState$ctl00',       'ReportPage');
  p.set('ReportViewer1$ctl10',                             '');
  p.set('ReportViewer1$ctl11',                             'standards');
  p.set('ReportViewer1$ctl03$ctl00',                       '');
  p.set('ReportViewer1$ctl03$ctl01',                       '');
  p.set('hdnFirstLoad',     'Resumen de Ventas');
  p.set('hdnMesesMostrar',  '0');
  p.set('hdnParametrosDrill', '');
  p.set('hdnPeriodo',       '');
  p.set('hdnRadiobutton',   '');
  p.set('hdnVencimiento',   '');
  p.set('mostrarPaginador', 'NO');
  p.set('selector',         '1');  // 1 = Últimos 12 meses
  p.set('txtRutDiv',        '');
  p.set('txtRutDivX',       '');
  return p;
}

async function descargarExcelDirecto(utn) {
  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;
  const hdrs = {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-CL,es;q=0.9',
  };

  // ── Paso 1: GET → sesión + ViewState inicial ─────────────────────────────
  console.log('[scraper] Paso 1: GET Dashboard.aspx con UTN...');
  const r1 = await fetch(dashUrl, { headers: hdrs, redirect: 'follow' });
  let cookies = parsearCookies(r1.headers);
  const html1 = await r1.text();
  const url1  = r1.url;
  console.log(`[scraper] Paso 1 → ${r1.status} url=${url1} htmlLen=${html1.length}`);

  if (url1.toLowerCase().includes('login') || url1.toLowerCase().includes('account')) {
    throw new Error('UTN_EXPIRED: redirigido a ' + url1);
  }
  if (html1.toLowerCase().includes('<title>nubox | error</title>')) {
    throw new Error('UTN_INVALID: Nubox devolvió error page');
  }
  const vs1 = extraerHidden(html1, '__VIEWSTATE');
  if (!vs1) throw new Error('VIEWSTATE_NO_ENCONTRADO en paso 1. url=' + url1);
  console.log(`[scraper] ViewState OK (${vs1.length} chars)`);

  // ── Paso 2: POST "VER REPORTE Últimos 12 meses" → ViewState con datos ────
  console.log('[scraper] Paso 2: POST btnBusquedaPorVencer (VER REPORTE)...');
  const p2 = baseParams(html1);
  p2.set('btnBusquedaPorVencer', 'Ver reporte');

  const r2 = await fetch(DASHBOARD, {
    method:  'POST',
    headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies, 'Referer': dashUrl },
    body:    p2.toString(),
    redirect: 'follow',
  });
  const nuevasCookies2 = parsearCookies(r2.headers);
  if (nuevasCookies2) cookies = mergeCookies(cookies, nuevasCookies2);
  const ct2 = r2.headers.get('content-type') || '';

  // Si el servidor ya devuelve Excel directo con este POST, devolvemos ahora
  if (ct2.includes('excel') || ct2.includes('spreadsheet') || ct2.includes('octet-stream') ||
      (r2.headers.get('content-disposition') || '').includes('.xls')) {
    const buf = await r2.buffer();
    console.log(`[scraper] Excel en paso 2 — ${buf.length} bytes`);
    return buf;
  }

  const html2 = await r2.text();
  console.log(`[scraper] Paso 2 → ${r2.status} ct=${ct2} htmlLen=${html2.length}`);

  const vs2 = extraerHidden(html2, '__VIEWSTATE');
  if (!vs2) throw new Error('VIEWSTATE_NO_ENCONTRADO en paso 2.');

  // ── Paso 3: POST btnImprimirXLS → Excel ───────────────────────────────────
  console.log('[scraper] Paso 3: POST btnImprimirXLS (EXPORTAR)...');
  const p3 = baseParams(html2);
  p3.set('btnImprimirXLS', 'Exportar');

  const r3 = await fetch(DASHBOARD, {
    method:  'POST',
    headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies, 'Referer': DASHBOARD },
    body:    p3.toString(),
    redirect: 'follow',
  });
  const ct3 = r3.headers.get('content-type') || '';
  const cd3 = r3.headers.get('content-disposition') || '';
  console.log(`[scraper] Paso 3 → ${r3.status} ct=${ct3} cd=${cd3}`);

  if (ct3.includes('excel') || ct3.includes('spreadsheet') || ct3.includes('octet-stream') || cd3.includes('.xls')) {
    const buf = await r3.buffer();
    console.log(`[scraper] Excel OK — ${buf.length} bytes`);
    return buf;
  }

  const txt = await r3.text();
  throw new Error(`POST_DEVOLVIO_HTML: status=${r3.status} ct=${ct3} | ${txt.slice(0, 400)}`);
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const excelBuffer = await descargarExcelDirecto(utn);
  return { excelBuffer, tablas: null, documentos: [], fuente: 'http-directo' };
}

module.exports = { scrapeNubox };
