/**
 * nubox-scraper.js
 *
 * Paso 1 — Login via Browserless.io v2:
 *   Abre Chrome headless, hace login en app.nubox.com con RUT + password,
 *   extrae las cookies de sesión y las devuelve.
 *
 * Paso 2 — Descarga directa con cookies:
 *   Usa las cookies obtenidas para llamar directamente a los endpoints
 *   de Nubox y descarga la lista de documentos del mes.
 *
 * Variables de entorno requeridas:
 *   BROWSERLESS_TOKEN   — API token de browserless.io
 *   NUBOX_RUT           — RUT de login, ej: "12.345.678-9"
 *   NUBOX_PASSWORD      — Contraseña Nubox
 */

const fetch = require('node-fetch');

// Browserless v2: production-sfo.browserless.io/chromium/function
const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_BASE       = 'https://app.nubox.com';
const DTE_PAGE         = `${NUBOX_BASE}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;

// ── Genera el script para Browserless v2 con credenciales interpoladas ──────
// Browserless v2 /chromium/function acepta raw JS (Content-Type: application/javascript)
// Las credenciales se inyectan en el string antes de enviarlo — viajan por HTTPS.
function buildLoginScript(rut, password) {
  return `
export default async ({ page }) => {
  const rut      = ${JSON.stringify(rut)};
  const password = ${JSON.stringify(password)};

  // MODO DEBUG: ver qué muestra Nubox al headless browser
  await page.goto('https://app.nubox.com/Account/LogIn', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });

  // Esperar 3s para que cargue JS
  await new Promise(r => setTimeout(r, 3000));

  const debugUrl   = page.url();
  const debugTitle = await page.title();
  const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
  const bodyHtml   = await page.evaluate(() => document.body?.innerHTML?.slice(0, 2000) || '(vacío)');
  const allInputs  = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({
      name: i.name, id: i.id, type: i.type, placeholder: i.placeholder
    }))
  );

  return Response.json({
    debug: true,
    url: debugUrl,
    title: debugTitle,
    inputs: allInputs,
    bodySnippet: bodyHtml,
    screenshot: 'data:image/jpeg;base64,' + screenshot,
  });
};
`;
}

/**
 * loginNubox() — Llama a Browserless v2 y obtiene cookies de sesión
 */
async function loginNubox() {
  const bToken   = process.env.BROWSERLESS_TOKEN;
  const rut      = process.env.NUBOX_RUT;
  const password = process.env.NUBOX_PASSWORD;

  if (!bToken)   throw new Error('Falta BROWSERLESS_TOKEN');
  if (!rut)      throw new Error('Falta NUBOX_RUT');
  if (!password) throw new Error('Falta NUBOX_PASSWORD');

  console.log('[scraper] Llamando a Browserless.io v2 para login en Nubox...');

  // Browserless v2: raw JS como body (Content-Type: application/javascript)
  const script = buildLoginScript(rut, password);
  const resp = await fetch(`${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body:    script,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Browserless error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const result = await resp.json();
  if (result.error) throw new Error('Browserless script error: ' + result.error);

  // v2 devuelve el objeto directamente (sin wrapper { data: ... })
  const { cookies, token: nuboxToken, funcionarioId, finalUrl } = result;

  console.log('[scraper] Login OK. URL final:', finalUrl);
  console.log('[scraper] Token DTE:', nuboxToken ? 'obtenido' : 'NO encontrado');
  console.log('[scraper] FuncionarioId:', funcionarioId || 'NO encontrado');

  return { cookies, token: nuboxToken, funcionarioId };
}

/**
 * obtenerDocumentosMes() — Con las cookies de sesión, obtiene la lista de DTEs del mes
 */
async function obtenerDocumentosMes(cookies, nuboxToken, mes) {
  const [year, month] = mes.split('-');
  const lastDay    = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaDesde = `01/${month}/${year}`;
  const fechaHasta = `${String(lastDay).padStart(2, '0')}/${month}/${year}`;

  console.log(`[scraper] Consultando DTEs: ${fechaDesde} → ${fechaHasta}`);

  const H = {
    'Content-Type':     'application/json; charset=utf-8',
    'Cookie':           cookies,
    'Referer':          DTE_PAGE,
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'X-Requested-With': 'XMLHttpRequest',
  };

  const filtroResp = await fetch(`${DTE_PAGE}/ObtenerPorFiltro`, {
    method:  'POST',
    headers: H,
    body: JSON.stringify({
      token:                       nuboxToken,
      EstadoId:                    3,
      estadoEnvio:                 0,
      fechaDesde,
      fechaHasta,
      filtro:                      '<Terminos></Terminos>',
      folioDesde:                  0,
      folioHasta:                  0,
      usaFormatoImpresionEspecial: false,
    }),
  });

  if (!filtroResp.ok) throw new Error(`ObtenerPorFiltro ${filtroResp.status}`);

  const outer = await filtroResp.json();
  const inner = JSON.parse(outer.d);
  const docs  = inner.data || [];

  console.log(`[scraper] ${docs.length} documentos encontrados para ${mes}`);
  return docs;
}

/**
 * descargarExcelReporteria() — Intenta descargar el Excel del mes
 */
async function descargarExcelReporteria(cookies, nuboxToken, mes) {
  const [year, month] = mes.split('-');
  const lastDay    = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaDesde = `01/${month}/${year}`;
  const fechaHasta = `${String(lastDay).padStart(2, '0')}/${month}/${year}`;

  const H = {
    'Content-Type':     'application/json; charset=utf-8',
    'Cookie':           cookies,
    'Referer':          DTE_PAGE,
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept':           'application/vnd.ms-excel, application/octet-stream, */*',
  };

  const exportEndpoints = [
    `${DTE_PAGE}/ExportarExcel`,
    `${DTE_PAGE}/ExportarReporte`,
    `${DTE_PAGE}/Exportar`,
  ];

  for (const endpoint of exportEndpoints) {
    try {
      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: H,
        body: JSON.stringify({ token: nuboxToken, EstadoId: 3, estadoEnvio: 0, fechaDesde, fechaHasta, filtro: '<Terminos></Terminos>', folioDesde: 0, folioHasta: 0 }),
      });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('excel') || ct.includes('octet-stream') || ct.includes('spreadsheet')) {
          console.log(`[scraper] Excel descargado desde: ${endpoint}`);
          return await resp.buffer();
        }
      }
    } catch (_) {}
  }

  console.log('[scraper] No se encontró endpoint Excel directo — usando lista de documentos');
  return null;
}

/**
 * scrapeNubox() — Función principal exportada
 */
async function scrapeNubox(mes) {
  const { cookies, token, funcionarioId } = await loginNubox();

  if (!token) {
    throw new Error('No se pudo extraer el token DTE. Revisar el script de Browserless.');
  }

  const excelBuffer = await descargarExcelReporteria(cookies, token, mes);
  const documentos  = await obtenerDocumentosMes(cookies, token, mes);

  return { excelBuffer, documentos };
}

module.exports = { scrapeNubox };
