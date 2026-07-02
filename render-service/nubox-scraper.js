/**
 * nubox-scraper.js
 * Browserless → Dashboard.aspx con UTN → intercepta respuesta Excel via page.on('response')
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

  // 1. Navegar a Dashboard directo con UTN
  await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise(r => setTimeout(r, 2000));

  const url = page.url();
  if (url.includes('/Login/') || url.includes('/Account/')) {
    throw new Error('UTN_EXPIRED: redirigido a ' + url);
  }

  const hasResumen = await page.evaluate(() =>
    document.body.innerText.includes('Resumen de Ventas')
  ).catch(() => false);
  if (!hasResumen) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
    throw new Error('RESUMEN_NO_CARGADO: url=' + url + ' | ' + body);
  }

  const btn = await page.$('#btnImprimirXLS');
  if (!btn) throw new Error('BOTON_XLS_NO_ENCONTRADO: url=' + url);

  // 2. Interceptar respuesta Excel ANTES de hacer click
  const excelPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('EXCEL_TIMEOUT: 30s sin respuesta Excel')),
      30000
    );

    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] || '';
      const cd = response.headers()['content-disposition'] || '';
      if (
        ct.includes('excel') || ct.includes('octet-stream') ||
        ct.includes('spreadsheet') || cd.includes('.xls')
      ) {
        clearTimeout(timeout);
        try {
          const buffer = await response.buffer();
          const b64    = buffer.toString('base64');
          resolve({ b64, ct, size: buffer.length });
        } catch (e) {
          reject(new Error('BUFFER_ERROR: ' + e.message));
        }
      }
    });
  });

  // 3. Click Exportar
  await btn.click();

  // 4. Esperar la respuesta
  const { b64, ct, size } = await excelPromise;
  return Response.json({ b64, ct, size });
};
`;

  console.log('[scraper] Browserless → Dashboard.aspx con UTN...');
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
    throw new Error('Browserless: sin Excel. Respuesta: ' + JSON.stringify(result).slice(0, 300));
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
