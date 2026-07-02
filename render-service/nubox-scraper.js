/**
 * nubox-scraper.js — flujo Nubox confirmado julio 2026
 */
const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_BASE       = 'https://app.nubox.com';
const DTE_PAGE         = `${NUBOX_BASE}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;

function buildLoginScript(rut, password) {
  return `
export default async ({ page }) => {
  const rut      = ${JSON.stringify(rut)};
  const password = ${JSON.stringify(password)};

  // Helper: devuelve info de diagnóstico sin romper el script
  async function diag(step, extra) {
    const url    = page.url();
    const title  = await page.title().catch(() => '?');
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i =>
        ({ type: i.type, placeholder: i.placeholder, id: i.id, name: i.name }))
    ).catch(() => []);
    const scr = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 })
                          .catch(() => null);
    return Response.json({
      debug: true, step,
      url, title, inputs,
      screenshot: scr ? 'data:image/jpeg;base64,' + scr : null,
      ...extra,
    });
  }

  // ── Paso 1: Ir a login ────────────────────────────────────────────────────
  try {
    await page.goto('https://web.nubox.com/Login/Account/Login', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
  } catch (e) {
    return diag('goto-failed', { error: e.message });
  }

  // ── Paso 2: Esperar formulario ────────────────────────────────────────────
  let formReady = false;
  try {
    await page.waitForSelector('input[placeholder="Ingresa tu rut"]', { timeout: 20000 });
    formReady = true;
  } catch (_) {}

  if (!formReady) {
    return diag('form-not-found');
  }

  // ── Paso 3: Llenar y enviar formulario ───────────────────────────────────
  try {
    await page.click('input[placeholder="Ingresa tu rut"]', { clickCount: 3 });
    await page.keyboard.type(rut);
    await page.click('input[placeholder="Ingresa tu contraseña"]', { clickCount: 3 });
    await page.keyboard.type(password);
    await new Promise(r => setTimeout(r, 800));

    const nav1 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 });
    const method = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const btn = btns.find(b => /ingresar/i.test(b.textContent));
      if (btn) { btn.click(); return 'btn'; }
      const sub = document.querySelector('input[type="submit"]');
      if (sub) { sub.click(); return 'submit'; }
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form'; }
      return null;
    });
    if (!method) {
      await page.keyboard.press('Enter');
    }
    await nav1;
  } catch (e) {
    return diag('login-submit-failed', { error: e.message });
  }

  // ── Paso 4: Seleccionar Factura Electrónica ──────────────────────────────
  await new Promise(r => setTimeout(r, 2000));

  let sysLoginOk = false;
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('Factura Electrónica'),
      { timeout: 15000 }
    );
    sysLoginOk = true;
  } catch (_) {}

  if (!sysLoginOk) {
    return diag('sistemaLogin-not-found');
  }

  try {
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
      throw new Error('texto Factura Electrónica no encontrado en DOM');
    });
    await nav2;
  } catch (e) {
    return diag('factura-click-failed', { error: e.message });
  }

  // ── Paso 5: Extraer UTN ──────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 1000));

  const finalUrl = page.url();
  const utnMatch = finalUrl.match(/[?&]utn=([^&]+)/);
  const utn      = utnMatch ? decodeURIComponent(utnMatch[1]) : null;

  if (!utn) {
    return diag('utn-not-found');
  }

  const cookiesArr = await page.cookies();
  const cookies    = cookiesArr.map(c => c.name + '=' + c.value).join('; ');

  return Response.json({ utn, cookies, finalUrl });
};
`;
}

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

  if (result.debug) {
    throw new Error(
      'NUBOX_DEBUG[' + result.step + '] url=' + result.url +
      ' | title=' + result.title +
      ' | inputs=' + JSON.stringify(result.inputs) +
      (result.error ? ' | err=' + result.error : '')
    );
  }

  const { utn, cookies, finalUrl } = result;
  if (!utn) throw new Error('Sin UTN. URL: ' + finalUrl);

  console.log('[scraper] Login OK. URL:', finalUrl);
  return { utn, cookies };
}

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
      token: utn, EstadoId: 3, estadoEnvio: 0,
      fechaDesde, fechaHasta,
      filtro: '<Terminos></Terminos>', folioDesde: 0, folioHasta: 0,
      usaFormatoImpresionEspecial: false,
    }),
  });

  if (!filtroResp.ok) throw new Error(`ObtenerPorFiltro HTTP ${filtroResp.status}`);
  const outer = await filtroResp.json();
  if (!outer.d) throw new Error('ObtenerPorFiltro: sin campo .d');
  const inner = JSON.parse(outer.d);
  const docs  = inner.data || [];
  console.log(`[scraper] ${docs.length} documentos para ${mes}`);
  return docs;
}

async function descargarExcelReporteria(cookies, utn, mes) {
  const [year, month] = mes.split('-');
  const lastDay    = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaDesde = `01/${month}/${year}`;
  const fechaHasta = `${String(lastDay).padStart(2, '0')}/${month}/${year}`;
  const H = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cookie': cookies, 'Referer': DTE_PAGE,
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/vnd.ms-excel, application/octet-stream, */*',
  };
  for (const ep of [`${DTE_PAGE}/ExportarExcel`, `${DTE_PAGE}/ExportarReporte`, `${DTE_PAGE}/Exportar`]) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: H,
        body: JSON.stringify({ token: utn, EstadoId: 3, estadoEnvio: 0, fechaDesde, fechaHasta,
          filtro: '<Terminos></Terminos>', folioDesde: 0, folioHasta: 0 }) });
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('excel') || ct.includes('octet-stream') || ct.includes('spreadsheet')) {
          console.log(`[scraper] Excel desde: ${ep}`);
          return await r.buffer();
        }
      }
    } catch (_) {}
  }
  console.log('[scraper] Sin Excel — se usa lista de documentos');
  return null;
}

async function scrapeNubox(mes) {
  const { cookies, utn } = await loginNubox();
  const excelBuffer = await descargarExcelReporteria(cookies, utn, mes);
  const documentos  = await obtenerDocumentosMes(cookies, utn, mes);
  return { excelBuffer, documentos };
}

module.exports = { scrapeNubox };
