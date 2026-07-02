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

// ── Script que corre DENTRO de Browserless v2 (ES modules) ───────────────────
const BROWSER_LOGIN_SCRIPT = `
export default async ({ page, context }) => {
  const { rut, password } = context;

  // 1. Ir al login
  await page.goto('https://app.nubox.com/Account/LogIn', {
    waitUntil: 'networkidle2', timeout: 30000
  });

  // 2. Aceptar cookies si aparece el banner
  try {
    await page.click('[id*="accept"], [class*="accept-cookie"], button[aria-label*="Accept"]');
    await new Promise(r => setTimeout(r, 1000));
  } catch(_) {}

  // 3. Llenar RUT
  await page.waitForSelector('input[name="Rut"], #Rut, input[id*="rut" i], input[placeholder*="rut" i]', { timeout: 10000 });
  const rutInput = await page.$('input[name="Rut"]') || await page.$('#Rut') || await page.$('input[type="text"]');
  await rutInput.click({ clickCount: 3 });
  await rutInput.type(rut, { delay: 50 });

  // 4. Llenar password
  await page.waitForSelector('input[type="password"]', { timeout: 5000 });
  const pwInput = await page.$('input[type="password"]');
  await pwInput.click({ clickCount: 3 });
  await pwInput.type(password, { delay: 50 });

  // 5. Submit
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    page.keyboard.press('Enter'),
  ]);

  // 6. Verificar login exitoso
  const url = page.url();
  if (url.includes('LogIn') || url.includes('login')) {
    const errorEl = await page.$('.validation-summary-errors, .alert-danger, [class*="error"]');
    const errorText = errorEl ? await page.evaluate(el => el.innerText, errorEl) : 'Credenciales incorrectas';
    throw new Error('Login fallido: ' + errorText.trim());
  }

  // 7. Navegar a la página DTE
  await page.goto('https://app.nubox.com/ServiFactura/paginas/dteDocumentosTributarios.aspx', {
    waitUntil: 'networkidle2', timeout: 30000
  });

  // 8. Extraer token del HTML
  const pageContent = await page.content();
  const tokenMatch = pageContent.match(/var\s+token\s*=\s*["']([A-Za-z0-9+\/=]{20,})["']/)
    || pageContent.match(/"token"\s*:\s*"([A-Za-z0-9+\/=]{20,})"/)
    || pageContent.match(/token\s*=\s*["']([A-Za-z0-9+\/=]{20,})["']/);
  const funcMatch = pageContent.match(/funcionarioId\s*[=:]\s*["']?(\d{4,})["']?/)
    || pageContent.match(/"funcionarioId"\s*:\s*"(\d+)"/);

  const token = tokenMatch ? tokenMatch[1] : null;
  const funcionarioId = funcMatch ? funcMatch[1] : null;

  // 9. Obtener cookies
  const cookies = await page.cookies();
  const cookieHeader = cookies.map(c => c.name + '=' + c.value).join('; ');

  return Response.json({ cookies: cookieHeader, token, funcionarioId, finalUrl: url });
};
`;

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

  const resp = await fetch(`${BROWSERLESS_BASE}/chromium/function?token=${bToken}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code:    BROWSER_LOGIN_SCRIPT,
      context: { rut, password },
      launch: {
        stealth: true,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    }),
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
