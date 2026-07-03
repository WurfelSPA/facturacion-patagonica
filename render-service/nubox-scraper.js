/**
 * render-service/nubox-scraper.js
 *
 * Fix v6: usa page.click() NATIVO de Puppeteer (no page.evaluate(() => el.click()))
 * para disparar la secuencia real de eventos del mouse (mousemove → mousedown → mouseup
 * → click → change) que activa los listeners jQuery/addEventListener de Nubox.
 *
 * También monitorea XHR requests para descubrir qué llamada de red dispara el radio.
 *
 * Vars requeridas:
 *   BROWSERLESS_TOKEN  — token de Browserless.io
 *   NUBOX_UTN          — token UTN de sesión Nubox
 */

const fetch = require('node-fetch');

const DASHBOARD = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas';

const BROWSERLESS_HOSTS = [
  'https://production-sfo.browserless.io',
  'https://production-lon.browserless.io',
];

function buildBrowserCode(targetUrl) {
  return `
export default async function({ page }) {
  // 1. Monitorear requests XHR/fetch ANTES de cualquier acción
  const xhrLog = [];
  page.on('request', req => {
    const t = req.resourceType();
    if (t === 'xhr' || t === 'fetch' || req.url().includes('Dashboard.aspx') || req.url().includes('ReportViewer')) {
      xhrLog.push({
        url: req.url().replace(/utn=[^&]+/, 'utn=***').slice(0, 300),
        method: req.method(),
        type: t,
        post: (req.postData() || '').slice(0, 150),
      });
    }
  });

  // 2. Navegar con UTN — networkidle2 para que JS esté completamente listo
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle2', timeout: 30000 });

  // 3. Verificar que no redirigió a login
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // 4. Esperar 3s extra para inicialización de JS
  await new Promise(r => setTimeout(r, 3000));

  const tdBefore = await page.evaluate(() => document.querySelectorAll('td').length);
  const bodyBefore = await page.evaluate(() => document.body.innerText.slice(0, 400));

  // 5. Limpiar el log de XHR que acumuló durante la carga inicial
  xhrLog.length = 0;

  // 6. CLICK NATIVO de Puppeteer en el radio button #s-option
  //    page.click() genera: mousemove + mousedown + mouseup + click + change
  //    Esto activa todos los listeners incluyendo jQuery .on('change', ...)
  let clickErr = null;
  try {
    await page.click('#s-option');
  } catch(e) {
    clickErr = e.message;
    // Fallback: click en el label (que redirige al radio)
    try { await page.click('label[for="s-option"]'); } catch(e2) { clickErr += ' | label: ' + e2.message; }
  }

  // 7. Esperar 20s para que SSRS re-renderice con el nuevo parámetro
  await new Promise(r => setTimeout(r, 20000));

  const tdAfter  = await page.evaluate(() => document.querySelectorAll('td').length);
  const bodyAfter = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  const radioState = await page.evaluate(() => ({
    checked: document.getElementById('s-option')?.checked,
    value:   document.getElementById('s-option')?.value,
  }));

  // 8. Intentar extraer datos si el table cambió
  if (tdAfter > tdBefore + 10) {
    const resultado = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td'));

      const headerCell = allTds.find(td => {
        const text = td.innerText || '';
        return /[A-Z][a-z]{2}-\\d{2}/.test(text);
      });

      if (!headerCell) {
        return {
          ok: false,
          reason: 'No header con meses',
          rutCount: allTds.filter(td => /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/.test((td.innerText||'').trim())).length,
          first200: allTds.slice(0, 20).map(td => td.innerText.trim()).filter(t => t),
        };
      }

      const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\d{2})/g)].map(m => m[1]);
      const rutPattern = /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;
      const rutCells = allTds.filter(td => rutPattern.test((td.innerText || '').trim()));

      const results = [];
      const seen = new Set();
      rutCells.forEach(rutCell => {
        const rut = rutCell.innerText.trim();
        if (seen.has(rut)) return;
        seen.add(rut);
        const row = rutCell.closest('tr');
        if (!row) return;
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        const rutIdx = cells.indexOf(rut);
        if (rutIdx < 0) return;
        const nombre = cells[rutIdx + 2] || cells[rutIdx + 1] || '';
        const monthStart = rutIdx + 4;
        const meses = {};
        for (let i = 0; i < MESES.length; i++) {
          const val = (cells[monthStart + i] || '').trim();
          if (val) { const n = parseInt(val.replace(/\\./g,''),10); if(!isNaN(n)&&n>0) meses[MESES[i]]=n*1000; }
        }
        const total = parseInt((cells[cells.length-1]||'').replace(/\\./g,''),10)*1000||0;
        results.push({ rut, nombre, meses, total });
      });
      return { ok: true, clientes: results, MESES };
    });

    if (resultado.ok && resultado.clientes.length > 0) {
      return resultado; // SUCCESS
    }
  }

  // 9. Si no cambió, retornar diagnóstico completo
  return {
    error: 'DIAG_v6',
    clickErr,
    radioState,
    tdBefore,
    tdAfter,
    bodyBefore,
    bodyAfter,
    xhrLog: xhrLog.slice(0, 20),
  };
}
`;
}

async function scrapeNuboxResumen() {
  const utn   = process.env.NUBOX_UTN;
  const token = process.env.BROWSERLESS_TOKEN;

  if (!utn)   throw new Error('Falta NUBOX_UTN en env vars');
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN en env vars');

  const targetUrl   = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;
  const browserCode = buildBrowserCode(targetUrl);

  let lastErr = null;

  for (const host of BROWSERLESS_HOSTS) {
    try {
      console.log(`[scraper] POST ${host}/function ...`);
      const resp = await fetch(`${host}/function?token=${token}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body:    browserCode,
        timeout: 90000,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Browserless HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      }

      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error) {
        // Log diagnóstico completo
        if (result.xhrLog)    console.warn('[scraper] XHR-LOG:', JSON.stringify(result.xhrLog));
        if (result.bodyAfter) console.warn('[scraper] BODY-AFTER:', result.bodyAfter.slice(0, 400));
        if (result.clickErr)  console.warn('[scraper] CLICK-ERR:', result.clickErr);
        console.warn('[scraper] tdBefore:', result.tdBefore, '→ tdAfter:', result.tdAfter);
        throw new Error('Browser error: ' + result.error);
      }

      if (!Array.isArray(result.clientes)) {
        throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));
      }

      console.log(`[scraper] OK — ${result.clientes.length} clientes, meses: ${result.MESES?.join(', ')}`);
      return { clientes: result.clientes, meses: result.MESES || [] };

    } catch (err) {
      console.warn(`[scraper] ${host} falló: ${err.message}`);
      lastErr = err;
    }
  }

  throw new Error('Todos los endpoints de Browserless fallaron. Último error: ' + lastErr?.message);
}

module.exports = { scrapeNuboxResumen };
