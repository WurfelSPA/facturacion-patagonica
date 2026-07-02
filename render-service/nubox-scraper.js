/**
 * nubox-scraper.js
 * Navega a Dashboard.aspx con UTN via Browserless (sin login/reCAPTCHA)
 */
const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_APP  = 'https://app.nubox.com';
const DASHBOARD  = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;

// ── Descarga Excel usando Browserless → Dashboard.aspx directo ────────────────
async function descargarExcelViaBrowserless(utn) {
  const bToken = process.env.BROWSERLESS_TOKEN;
  if (!bToken) throw new Error('Falta BROWSERLESS_TOKEN');

  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  const script = `
export default async ({ page }) => {
  const dashUrl = ${JSON.stringify(dashUrl)};

  // Paso 1: Navegar a Dashboard.aspx con UTN
  await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise(r => setTimeout(r, 2000));

  const url   = page.url();
  const title = await page.title().catch(() => '');
  const body  = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');

  // Si redirigió al login, lanzar error descriptivo
  if (url.includes('/Login/') || url.includes('/Account/')) {
    throw new Error('UTN_EXPIRED: redirigido a ' + url + ' | body: ' + body);
  }

  // Paso 2: Verificar que el resumen cargó
  const tieneResumen = await page.evaluate(() =>
    document.body.innerText.includes('Resumen de Ventas')
  ).catch(() => false);

  if (!tieneResumen) {
    throw new Error('RESUMEN_NO_CARGADO: url=' + url + ' | body=' + body);
  }

  // Paso 3: Hacer click en Exportar XLS
  const exportBtn = await page.$('#btnImprimirXLS');
  if (!exportBtn) {
    throw new Error('BOTON_NO_ENCONTRADO: url=' + url + ' | body=' + body);
  }

  // Configurar captura de descarga
  const downloadResp = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const form = document.getElementById('form1');
      const originalSubmit = form.submit.bind(form);

      // Override submit para capturar via fetch
      const fd = new FormData(form);
      fd.set('btnImprimirXLS', 'Exportar');
      fd.set('selector', '0');

      const body = new URLSearchParams();
      for (const [k, v] of fd.entries()) body.set(k, v);

      fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      }).then(async r => {
        const ct = r.headers.get('content-type') || '';
        const cd = r.headers.get('content-disposition') || '';
        if (ct.includes('excel') || ct.includes('octet-stream') || cd.includes('.xls')) {
          const ab = await r.arrayBuffer();
          const arr = Array.from(new Uint8Array(ab));
          resolve({ ok: true, bytes: arr, ct, cd, status: r.status });
        } else {
          const txt = await r.text();
          resolve({ ok: false, status: r.status, ct, txt: txt.slice(0, 300) });
        }
      }).catch(e => reject(new Error('FETCH_ERROR: ' + e.message)));

      setTimeout(() => reject(new Error('TIMEOUT: 20s sin respuesta')), 20000);
    });
  });

  if (!downloadResp.ok) {
    throw new Error('POST_FAILED: status=' + downloadResp.status + ' ct=' + downloadResp.ct + ' txt=' + downloadResp.txt);
  }

  return Response.json({ bytes: downloadResp.bytes, ct: downloadResp.ct });
};
`;

  console.log('[scraper] Browserless → Dashboard.aspx con UTN...');
  const resp = await fetch(
    `${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true`,
    { method: 'POST', headers: { 'Content-Type': 'application/javascript' }, body: script }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Browserless error ${resp.status}: ${body.slice(0, 500)}`);
  }

  const result = await resp.json();
  if (!result.bytes) throw new Error('Browserless: sin bytes de Excel. Respuesta: ' + JSON.stringify(result).slice(0,300));

  const buf = Buffer.from(result.bytes);
  console.log(`[scraper] Excel recibido via Browserless — ${buf.length} bytes`);
  return buf;
}

// ── Función principal ─────────────────────────────────────────────────────────
async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');

  const excelBuffer = await descargarExcelViaBrowserless(utn);
  return { excelBuffer, documentos: [], fuente: 'excel-browserless-dashboard' };
}

module.exports = { scrapeNubox };
