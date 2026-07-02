/**
 * nubox-scraper.js
 * Browserless → Dashboard.aspx con UTN → fetch PDF/Excel desde browser context
 * IMPORTANTE: El script Browserless NUNCA lanza throw (Browserless devuelve {} para errores no capturados).
 *             Siempre retorna Response.json({ ok, ... }) con diagnostico completo.
 */
const fetch = require('node-fetch');

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const NUBOX_APP = 'https://app.nubox.com';
const DASHBOARD = `${NUBOX_APP}/ServiFactura/paginas/Dashboard.aspx?action=Ventas`;

async function descargarArchivoViaBrowserless(utn) {
  const bToken  = process.env.BROWSERLESS_TOKEN;
  if (!bToken) throw new Error('Falta BROWSERLESS_TOKEN');
  const dashUrl = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  const script = `
export default async ({ page }) => {
  const dashUrl = ${JSON.stringify(dashUrl)};

  // 1. Navegar a Dashboard con UTN
  try {
    await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) {
    return Response.json({ ok: false, stage: 'goto', error: e.message });
  }
  await new Promise(r => setTimeout(r, 3000));

  // 2. Verificar que no redirigió al login
  const url = page.url();
  if (url.includes('/Login/') || url.includes('/Account/') || url.includes('/login')) {
    return Response.json({ ok: false, stage: 'auth', error: 'UTN_EXPIRED', url });
  }

  // 3. Verificar que cargó el Resumen de Ventas
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
  if (!bodyText.includes('Resumen de Ventas')) {
    return Response.json({ ok: false, stage: 'verify', error: 'RESUMEN_NO_CARGADO', url, bodyText });
  }

  // 4. Hacer POST desde el browser context (con cookies de sesion activas)
  //    Intenta primero PDF (btnImprimir), luego Excel (btnImprimirXLS)
  const result = await page.evaluate(async () => {
    const form = document.getElementById('form1');
    if (!form) return { ok: false, error: 'form1 no encontrado' };

    const makePost = async (btnName, btnValue) => {
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(form)) params.set(k, v);
      params.set(btnName, btnValue);
      params.set('selector', '0');

      let r;
      try {
        r = await fetch(form.action || window.location.href, {
          method:      'POST',
          headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:        params.toString(),
          credentials: 'include',
        });
      } catch (e) {
        return { ok: false, btn: btnName, error: 'FETCH_ERROR: ' + e.message };
      }

      const ct = r.headers.get('content-type') || '';
      const cd = r.headers.get('content-disposition') || '';
      const isPdf   = ct.includes('pdf')   || cd.includes('.pdf');
      const isExcel = ct.includes('excel') || ct.includes('spreadsheet') || ct.includes('octet-stream') || cd.includes('.xls');

      if (!isPdf && !isExcel) {
        const txt = await r.text().catch(() => '');
        return { ok: false, btn: btnName, status: r.status, ct, cd, txt: txt.slice(0, 300) };
      }

      // Convertir a base64
      const ab   = await r.arrayBuffer();
      const u8   = new Uint8Array(ab);
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < u8.length; i += chunk) {
        binary += String.fromCharCode(...u8.subarray(i, i + chunk));
      }
      return { ok: true, btn: btnName, b64: btoa(binary), ct, size: ab.byteLength };
    };

    // Primero PDF, si falla intenta Excel
    const pdf = await makePost('btnImprimir', 'Descargar');
    if (pdf.ok) return pdf;
    const xls = await makePost('btnImprimirXLS', 'Exportar');
    return xls.ok ? xls : { ...xls, pdfDiag: pdf };
  }).catch(e => ({ ok: false, error: 'EVALUATE_ERROR: ' + e.message }));

  return Response.json(result || { ok: false, error: 'EVALUATE_NULL' });
};
`;

  console.log('[scraper] Browserless → Dashboard.aspx, descargando PDF/Excel...');
  const resp = await fetch(
    `${BROWSERLESS_BASE}/chromium/function?token=${bToken}&stealth=true`,
    { method: 'POST', headers: { 'Content-Type': 'application/javascript' }, body: script }
  );

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Browserless HTTP ${resp.status}: ${errBody.slice(0, 500)}`);
  }

  const result = await resp.json();
  console.log('[scraper] Resultado Browserless:', JSON.stringify(result).slice(0, 300));

  if (!result.ok) {
    throw new Error('Browserless diagnostico: ' + JSON.stringify(result).slice(0, 500));
  }
  if (!result.b64) {
    throw new Error('Browserless: b64 vacio. ' + JSON.stringify(result).slice(0, 300));
  }

  const buf = Buffer.from(result.b64, 'base64');
  console.log(`[scraper] Archivo OK — ${buf.length} bytes, tipo: ${result.ct}, boton: ${result.btn}`);
  return { buffer: buf, tipo: result.ct.includes('pdf') ? 'pdf' : 'excel' };
}

async function scrapeNubox(mes) {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');
  const { buffer, tipo } = await descargarArchivoViaBrowserless(utn);
  return { excelBuffer: tipo === 'excel' ? buffer : null, pdfBuffer: tipo === 'pdf' ? buffer : null, tipo, documentos: [], fuente: 'browserless-dashboard' };
}

module.exports = { scrapeNubox };
