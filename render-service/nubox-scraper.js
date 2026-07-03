/**
 * render-service/nubox-scraper.js
 *
 * Fix v5: clic directo en <input type="radio" id="s-option"> para seleccionar
 * "Año actual". El <li> no tiene onclick — el radio button es el control real.
 * Después del clic se disparan eventos change/input y si no carga en 10s se
 * hace __doPostBack('ReportViewer1$ctl03','') para forzar el refresh del SSRS.
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
  // 1. Navegar con UTN
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Verificar que no redirigió a login
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // 3. Esperar 4s para que el JS de la página inicialice
  await new Promise(r => setTimeout(r, 4000));

  // 4. Seleccionar "Año actual": click en el radio button id="s-option"
  const clickResult = await page.evaluate(() => {
    const radio = document.getElementById('s-option');
    if (!radio) {
      // Fallback: buscar input[type=radio] con value="1" o name="selector"
      const r2 = document.querySelector('input[type="radio"][value="1"], input[type="radio"][name="selector"][id*="s-"]');
      if (r2) {
        r2.click();
        r2.dispatchEvent(new Event('change', { bubbles: true }));
        r2.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, method: 'fallback', id: r2.id, value: r2.value };
      }
      return { ok: false, reason: 's-option not found' };
    }
    // Click el radio y disparar eventos para que el JS del sitio reaccione
    radio.click();
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    radio.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, method: 'radio_click', id: radio.id, checked: radio.checked, value: radio.value };
  });

  // 5. Esperar 8s para que el AJAX del ReportViewer inicie
  await new Promise(r => setTimeout(r, 8000));

  // 6. Si la tabla no cambió, forzar __doPostBack del ReportViewer SSRS
  const tdCount1 = await page.evaluate(() => document.querySelectorAll('td').length);
  let forcedPostback = false;
  if (tdCount1 <= 50) {
    forcedPostback = true;
    await page.evaluate(() => {
      try {
        // Postback del ReportViewer para refrescar con nuevo parámetro
        if (typeof __doPostBack === 'function') {
          __doPostBack('ReportViewer1$ctl03', '');
        }
      } catch(e) {}
    });
  }

  // 7. Esperar que aparezcan datos: RUT pattern / columnas de meses / tdCount aumenta
  let timedOut = false;
  try {
    await page.waitForFunction(
      (ic) => {
        const tds = Array.from(document.querySelectorAll('td'));
        // Opción A: celdas RUT
        if (tds.some(td => /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/.test((td.innerText || '').trim()))) return true;
        // Opción B: columnas de meses en el body
        if (/Ene-\\d{2}|Feb-\\d{2}|Mar-\\d{2}/.test(document.body.innerText)) return true;
        // Opción C: tdCount creció significativamente
        if (tds.length > ic + 20) return true;
        return false;
      },
      { timeout: 35000 },
      tdCount1
    );
  } catch(e) {
    timedOut = true;
  }

  if (timedOut) {
    const postDiag = await page.evaluate(() => ({
      tdCount:        document.querySelectorAll('td').length,
      bodySnip:       document.body.innerText.slice(0, 600),
      url:            location.href,
    }));
    return { error: 'TIMEOUT_35s', clickResult, forcedPostback, tdCount1, postDiag };
  }

  // 8. Extraer datos del DOM
  const resultado = await page.evaluate(() => {
    const allTds = Array.from(document.querySelectorAll('td'));

    // Buscar celda de encabezado con columnas de meses
    const headerCell = allTds.find(td => {
      const text = td.innerText || '';
      return text.includes('Cliente') && text.includes('Total') &&
             /[A-Z][a-z]{2}-\\d{2}/.test(text);
    });

    if (!headerCell) {
      const rutPattern = /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;
      const rutCount = allTds.filter(td => rutPattern.test((td.innerText || '').trim())).length;
      return {
        error: 'Encabezado sin columnas de meses',
        clientes: [], MESES: [],
        rutCount,
        bodySnip: document.body.innerText.slice(0, 400)
      };
    }

    const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\d{2})/g)].map(m => m[1]);
    if (!MESES.length) return { error: 'Sin columnas mes en encabezado', clientes: [], MESES: [] };

    const rutPattern = /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;
    const rutCells   = allTds.filter(td => rutPattern.test((td.innerText || '').trim()));

    const results = [];
    const seen    = new Set();

    rutCells.forEach(rutCell => {
      const rut = (rutCell.innerText || '').trim();
      if (seen.has(rut)) return;
      seen.add(rut);
      const row = rutCell.closest('tr');
      if (!row) return;
      const cells = Array.from(row.querySelectorAll('td')).map(c => (c.innerText || '').trim());
      const rutIdx = cells.indexOf(rut);
      if (rutIdx < 0) return;
      const nombre     = cells[rutIdx + 2] || cells[rutIdx + 1] || '';
      const monthStart = rutIdx + 4;
      const meses = {};
      for (let i = 0; i < MESES.length; i++) {
        const val = (cells[monthStart + i] || '').trim();
        if (val) {
          const num = parseInt(val.replace(/\\./g, ''), 10);
          if (!isNaN(num) && num > 0) meses[MESES[i]] = num * 1000;
        }
      }
      const totalStr = (cells[cells.length - 1] || '').trim();
      const total    = totalStr ? parseInt(totalStr.replace(/\\./g, ''), 10) * 1000 : 0;
      results.push({ rut, nombre, meses, total });
    });

    return { clientes: results, MESES };
  });

  return resultado;
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
        if (result.clickResult) console.warn('[scraper] CLICK:', JSON.stringify(result.clickResult));
        if (result.postDiag)   console.warn('[scraper] POST-DIAG:', JSON.stringify(result.postDiag));
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
