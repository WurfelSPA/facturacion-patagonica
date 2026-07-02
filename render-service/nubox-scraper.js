/**
 * nubox-scraper.js
 * Browserless → Dashboard.aspx con UTN → fetch desde browser context → base64
 */
const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_APP = 'https://app.nubox.com';
const DASHBOARD = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;

async function descargarExcelViaBrowserless(utn) {
  const bToken  = process.env.BROWSERLESS_TOKEN;
  if (!bToken) throw new Error('Falta BROWSERLESS_TOKEN');
  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  const script = `
export default async ({ page }) => {
  const dashUrl = ${JSON.stringify(dashUrl)};

  // 1. Navegar a Dashboard con UTN
  await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise(r => setTimeout(r, 3000));

  const url = page.url();
  if (url.includes('/Login/') || url.includes('/Account/')) {
    throw new Error('UTN_EXPIRED: redirigido a ' + url);
  }

  const hasResumen = await page.evaluate(() =>
    document.body.innerText.includes('Resumen de Ventas')
  ).catch(() => false);
  if (!hasResumen) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
    throw new Error('RESUMEN_NO_CARGADO: url=' + url + ' | ' + body);
  }

  // 2. Hacer el POST desde el browser context (tiene cookies de sesion)
  const result = await page.evaluate(async () => {
    const form = document.getElementById('form1');
    if (!form) return { ok: false, error: 'form1 no encontrado' };

    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) params.set(k, v);
    params.set('btnImprimirXLS', 'Exportar');
    params.set('selector', '0');

    let r;
    try {
      r = await fetch(form.action, {
        method:      'POST',
        headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:        params.toString(),
        credentials: 'include',
      });
    } catch (e) {
      return { ok: false, error: 'FETCH_ERROR: ' + e.message };
    }

    const ct = r.headers.get('content-type') || '';
    const cd = r.headers.get('content-disposition') || '';

    if (!ct.includes('excel') && !ct.includes('octet-stream') &&
        !ct.includes('spreadsheet') && !cd.includes('.xls')) {
      const txt = await r.text().catch(() => '');
      return { ok: false, status: r.status, ct, cd, txt: txt.slice(0, 400) };
    }

    // Convertir a base64 en el browser
    const ab = await r.arrayBuffer();
    const u8 = new Uint8Array(ab);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode(...u8.subarray(i, i + chunk));
    }
    return { ok: true, b64: btoa(binary), ct, size: ab.byteLength };
  });

  if (!result || !result.ok) {
    throw new Error('EXCEL_FETCH_FAILED: ' + JSON.stringify(result).slice(0, 400));
  }

  return Response.json({ b64: result.b64, ct: result.ct, size: result.size });
};
`;

  console.log('[scraper] Browserless → Dashboard.aspx + fetch Excel desde browser...');
  const resp = await fetch(
    `${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true`,
    { method: 'POST', headers: { 'Content-Type': 'application/javascript' }, body: script }
  );

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Browserless error ${resp.status}: ${errBody.slice(0, 500)}`);
  }

  const result = await resp.json();
  if (!result.b64) {
    throw new Error('Browserless: sin Excel b64. Respuesta: ' + JSON.stringify(result).slice(0, 400));
  }

  const buf = Buffer.from(result.b64, 'base64');
  console.log(`[scraper] Excel OK — ${buf.length} bytes`);
  return buf;
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const excelBuffer = await descargarExcelViaBrowserless(utn);
  return { excelBuffer, documentos: [], fuente: 'excel-browserless-dashboard' };
}

module.exports = { scrapeNubox };
