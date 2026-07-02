/**
 * nubox-scraper.js
 *
 * Flujo real de login Nubox (confirmado julio 2026):
 *   1. POST login en web.nubox.com/Login/Account/Login
 *   2. Seleccionar "Factura Electrónica" en web.nubox.com/SistemaLogin/
 *   3. Redirect a app.nubox.com/ServiFactura/?utn=TOKEN
 *   4. Usar utn + cookies para llamar a ObtenerPorFiltro
 *
 * Variables de entorno:
 *   BROWSERLESS_TOKEN   — API token de browserless.io
 *   NUBOX_RUT           — RUT de login, ej: "9.562.956-3"
 *   NUBOX_PASSWORD      — Contraseña Nubox
 */

const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_BASE       = 'https://app.nubox.com';
const DTE_PAGE         = `${NUBOX_BASE}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;

// ── Script Browserless v2 — login completo en 3 pasos ────────────────────────
function buildLoginScript(rut, password) {
  return `
export default async ({ page }) => {
  const rut      = ${JSON.stringify(rut)};
  const password = ${JSON.stringify(password)};

  // ── Paso 1: Login ──────────────────────────────────────────────────────────
  console.log('[browser] Navegando a login...');
  await page.goto('https://web.nubox.com/Login/Account/Login', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });

  await page.waitForSelector('input[placeholder="Ingresa tu rut"]', { timeout: 15000 });
  console.log('[browser] Formulario cargado');

  // Limpiar y llenar RUT
  await page.click('input[placeholder="Ingresa tu rut"]', { clickCount: 3 });
  await page.keyboard.type(rut);

  // Limpiar y llenar contraseña
  await page.click('input[placeholder="Ingresa tu contraseña"]', { clickCount: 3 });
  await page.keyboard.type(password);

  // Pequeña pausa para que React renderice el botón
  await new Promise(r => setTimeout(r, 1000));

  // Enviar formulario — 4 estrategias de fallback
  const nav1 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 });
  const submitted = await page.evaluate(() => {
    // 1. Botón con texto "ingresar" (case-insensitive)
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const btn = btns.find(b => /ingresar/i.test(b.textContent));
    if (btn) { btn.click(); return 'btn-text'; }
    // 2. input[type=submit]
    const sub = document.querySelector('input[type="submit"]');
    if (sub) { sub.click(); return 'input-submit'; }
    // 3. form.submit()
    const form = document.querySelector('form');
    if (form) { form.submit(); return 'form-submit'; }
    return null;
  });
  if (!submitted) {
    // 4. Enter desde contraseña
    await page.focus('input[placeholder="Ingresa tu contraseña"]');
    await page.keyboard.press('Enter');
    console.log('[browser] Submit via Enter');
  } else {
    console.log('[browser] Submit via:', submitted);
  }
  await nav1;
  console.log('[browser] Post-login URL:', page.url());

  // ── Paso 2: Seleccionar Factura Electrónica ────────────────────────────────
  await new Promise(r => setTimeout(r, 2000));

  await page.waitForFunction(
    () => document.body.innerText.includes('Factura Electrónica'),
    { timeout: 15000 }
  );
  console.log('[browser] SistemaLogin cargado, buscando Factura Electrónica...');

  const nav2 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === 'Factura Electrónica') {
        let el = node.parentElement;
        while (el && !el.onclick && el.tagName !== 'A' && el.tagName !== 'BUTTON') {
          el = el.parentElement;
        }
        (el || node.parentElement).click();
        return;
      }
    }
    throw new Error('Factura Electrónica no encontrada en SistemaLogin');
  });
  await nav2;

  // ── Paso 3: Extraer UTN y cookies ─────────────────────────────────────────
  await new Promise(r => setTimeout(r, 1000));

  const finalUrl = page.url();
  const utnMatch = finalUrl.match(/[?&]utn=([^&]+)/);
  const utn      = utnMatch ? decodeURIComponent(utnMatch[1]) : null;

  if (!utn) {
    const title      = await page.title();
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500));
    throw new Error('UTN no encontrado — URL: ' + finalUrl + ' | Title: ' + title + ' | Body: ' + bodySnippet);
  }

  const cookiesArr = await page.cookies();
  const cookies    = cookiesArr.map(c => c.name + '=' + c.value).join('; ');

  console.log('[browser] UTN extraído OK');
  return Response.json({ utn, cookies, finalUrl });
};
`;
}

/**
 * loginNubox() — Llama a Browserless v2 y obtiene utn + cookies
 */
async function loginNubox() {
  const bToken   = process.env.BROWSERLESS_TOKEN;
  const rut      = process.env.NUBOX_RUT;
  const password = process.env.NUBOX_PASSWORD;

  if (!bToken)   throw new Error('Falta BROWSERLESS_TOKEN');
  if (!rut)      throw new Error('Falta NUBOX_RUT');
  if (!password) throw new Error('Falta NUBOX_PASSWORD');

  console.log('[scraper] Iniciando login Nubox via Browserless...');

  const script = buildLoginScript(rut, password);
  const resp = await fetch(`${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body:    script,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Browserless error ${resp.status}: ${body.slice(0, 400)}`);
  }

  const result = await resp.json();
  if (result.error) throw new Error('Browserless script error: ' + result.error);

  const { utn, cookies, finalUrl } = result;
  if (!utn) throw new Error('Login OK pero sin UTN. URL final: ' + finalUrl);

  console.log('[scraper] Login OK. URL final:', finalUrl);
  return { utn, cookies };
}

/**
 * obtenerDocumentosMes() — Con utn + cookies, obtiene DTEs del mes via API
 */
async function obtenerDocumentosMes(cookies, utn, mes) {
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
      token:                       utn,
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

  if (!filtroResp.ok) throw new Error(`ObtenerPorFiltro HTTP ${filtroResp.status}`);

  const outer = await filtroResp.json();
  if (!outer.d) throw new Error('ObtenerPorFiltro: respuesta sin campo .d');

  const inner = JSON.parse(outer.d);
  const docs  = inner.data || [];

  console.log(`[scraper] ${docs.length} documentos para ${mes}`);
  return docs;
}

/**
 * descargarExcelReporteria() — Intenta descargar el Excel del mes (opcional)
 */
async function descargarExcelReporteria(cookies, utn, mes) {
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

  for (const endpoint of [`${DTE_PAGE}/ExportarExcel`, `${DTE_PAGE}/ExportarReporte`, `${DTE_PAGE}/Exportar`]) {
    try {
      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: H,
        body: JSON.stringify({ token: utn, EstadoId: 3, estadoEnvio: 0, fechaDesde, fechaHasta, filtro: '<Terminos></Terminos>', folioDesde: 0, folioHasta: 0 }),
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

  console.log('[scraper] Sin Excel — se usará lista de documentos');
  return null;
}

/**
 * scrapeNubox() — Función principal exportada
 */
async function scrapeNubox(mes) {
  const { cookies, utn } = await loginNubox();
  const excelBuffer = await descargarExcelReporteria(cookies, utn, mes);
  const documentos  = await obtenerDocumentosMes(cookies, utn, mes);
  return { excelBuffer, documentos };
}

module.exports = { scrapeNubox };
