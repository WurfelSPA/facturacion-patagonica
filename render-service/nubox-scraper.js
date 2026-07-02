/**
 * nubox-scraper.js
 * Login via cookies almacenadas + descarga Excel desde Dashboard.aspx
 */
const fetch = require('node-fetch');

const NUBOX_APP  = 'https://app.nubox.com';
const DASHBOARD  = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;
const PRINCIPAL  = `${NUBOX_APP}/ServiFactura/paginas/dtePrincipal.aspx`;

// ── Opción A: cookies almacenadas ─────────────────────────────────────────────
async function loginNubox() {
  const storedCookies = process.env.NUBOX_SESSION_COOKIES;
  const storedUtn     = process.env.NUBOX_UTN;
  if (storedCookies && storedUtn) {
    console.log('[scraper] Usando cookies de sesion almacenadas');
    return { cookies: storedCookies, utn: storedUtn };
  }
  throw new Error('Faltan NUBOX_SESSION_COOKIES y NUBOX_UTN en env vars. Inicia sesion en Nubox y copia las cookies.');
}

// ── Descarga Excel desde Dashboard Resumen de Ventas ──────────────────────────
async function descargarExcelDashboard(cookies, utn) {
  const urlConUtn = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;
  const baseHeaders = {
    'Cookie'    : cookies,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
    'Referer'   : `${PRINCIPAL}?utn=${encodeURIComponent(utn)}`,
    'Accept'    : 'text/html,application/xhtml+xml,*/*;q=0.8',
  };

  // Paso 1: GET para obtener ViewState fresco
  console.log('[scraper] GET Dashboard.aspx resumen de ventas...');
  const getResp = await fetch(urlConUtn, { headers: baseHeaders, redirect: 'follow' });
  if (!getResp.ok) throw new Error(`Dashboard GET HTTP ${getResp.status}`);
  const html = await getResp.text();

  // Extraer campos hidden de ASP.NET
  function extractHidden(name) {
    const patterns = [
      new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i'),
      new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'),
      new RegExp(`value="([^"]*)"[^>]*id="${name}"`, 'i'),
      new RegExp(`value="([^"]*)"[^>]*name="${name}"`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) return m[1];
    }
    console.warn(`[scraper] Campo ${name} no encontrado en HTML`);
    return '';
  }

  const viewstate      = extractHidden('__VIEWSTATE');
  const viewstateGen   = extractHidden('__VIEWSTATEGENERATOR');
  const eventVal       = extractHidden('__EVENTVALIDATION');

  if (!viewstate) {
    const snippet = html.slice(0, 300);
    throw new Error(`ViewState no encontrado — posible sesion expirada. HTML: ${snippet}`);
  }

  // Paso 2: POST con boton Exportar XLS
  console.log('[scraper] POST Dashboard.aspx → Exportar XLS (Ultimos 12 meses)...');
  const body = new URLSearchParams({
    '__EVENTTARGET'     : '',
    '__EVENTARGUMENT'   : '',
    '__VIEWSTATE'       : viewstate,
    '__VIEWSTATEGENERATOR': viewstateGen,
    '__EVENTVALIDATION' : eventVal,
    'mostrarPaginador'  : 'NO',
    'hdnPeriodo'        : '',
    'hdnVencimiento'    : '',
    'hdnMesesMostrar'   : '0',
    'hdnParametrosDrill': '',
    'hdnRadiobutton'    : '',
    'hdnFirstLoad'      : 'Resumen de Ventas',
    'txtRutDiv'         : '',
    'selector'          : '0',   // 0 = Ultimos 12 meses
    'btnImprimirXLS'    : 'Exportar',
  });

  const postResp = await fetch(DASHBOARD, {
    method : 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept'      : 'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
    },
    body   : body.toString(),
    redirect: 'follow',
  });

  const ct = postResp.headers.get('content-type') || '';
  const cd = postResp.headers.get('content-disposition') || '';
  console.log(`[scraper] Dashboard POST: HTTP ${postResp.status} | CT: ${ct} | CD: ${cd}`);

  if (!postResp.ok) {
    const txt = await postResp.text();
    throw new Error(`Dashboard POST HTTP ${postResp.status}: ${txt.slice(0, 300)}`);
  }

  if (ct.includes('excel') || ct.includes('octet-stream') || ct.includes('spreadsheet') || cd.includes('.xls')) {
    console.log('[scraper] Excel recibido OK');
    return await postResp.buffer();
  }

  // Fallback: retornar HTML para parseo directo
  console.log('[scraper] Respuesta no es Excel — CT:', ct, '— guardando HTML como fallback');
  const postHtml = await postResp.text();
  return { fallbackHtml: postHtml };
}

// ── Parsear tabla HTML del dashboard como fallback ────────────────────────────
function parsearTablaHtml(html) {
  const rows = [];
  // Buscar filas de tabla con datos de clientes (RUT - Nombre - montos)
  const trRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const strip = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const cells = [];
    let tdMatch;
    const tdReCopy = new RegExp(tdRe.source, 'gi');
    while ((tdMatch = tdReCopy.exec(trMatch[1])) !== null) {
      cells.push(strip(tdMatch[1]));
    }
    if (cells.length >= 3 && /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/.test(cells[0])) {
      rows.push(cells);
    }
  }
  return rows;
}

// ── Función principal ─────────────────────────────────────────────────────────
async function scrapeNubox(mes) {
  const { cookies, utn } = await loginNubox();
  const result = await descargarExcelDashboard(cookies, utn);

  if (Buffer.isBuffer(result)) {
    console.log(`[scraper] Excel OK — ${result.length} bytes`);
    return { excelBuffer: result, documentos: [], fuente: 'excel-dashboard' };
  }

  if (result && result.fallbackHtml) {
    console.log('[scraper] Usando fallback HTML');
    const rows = parsearTablaHtml(result.fallbackHtml);
    console.log(`[scraper] Filas parseadas del HTML: ${rows.length}`);
    return { excelBuffer: null, documentos: rows, fuente: 'html-dashboard' };
  }

  throw new Error('Sin Excel ni HTML del Dashboard');
}

module.exports = { scrapeNubox };
