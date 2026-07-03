/**
 * render-service/nubox-scraper.js
 *
 * Llama a la API REST de Browserless.io para ejecutar código de browser
 * en la nube y extraer el Resumen de Ventas de Nubox.
 *
 * No usa puppeteer — solo node-fetch para llamar al endpoint /function.
 * El código del browser viaja como string en el body del POST.
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

/**
 * Construye el código JavaScript que se ejecutará en el browser de Browserless.
 * El código es un ES module con export default function.
 * Los regex usan \\ porque el string vive dentro de un template literal JS.
 */
function buildBrowserCode(targetUrl) {
  return `
export default async function({ page }) {
  // 1. Navegar al Dashboard con UTN
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle2', timeout: 60000 });

  // 2. Verificar que no redirigió a login
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { data: { error: 'UTN_EXPIRED: ' + currentUrl }, type: 'application/json' };
  }

  // 3. Esperar hasta que el ReportViewer cargue (aparecen celdas con patrón RUT)
  try {
    await page.waitForFunction(
      () => {
        const tds = document.querySelectorAll('td');
        return Array.from(tds).some(td =>
          /^\\\\d{1,2}\\\\.\\\\d{3}\\\\.\\\\d{3}-[\\\\dkK]$/.test(td.innerText.trim())
        );
      },
      { timeout: 30000 }
    );
  } catch(e) {
    return { data: { error: 'TIMEOUT: tabla Nubox no cargo en 30s' }, type: 'application/json' };
  }

  // 4. Extraer datos del DOM
  const resultado = await page.evaluate(() => {
    const allTds = document.querySelectorAll('td');

    // Detectar columnas de meses desde el encabezado (ej: "Ene-26", "Feb-26", ...)
    const headerCell = Array.from(allTds).find(td => {
      const text = td.innerText;
      return text.includes('Cliente') && text.includes('Total') &&
             /[A-Z][a-z]{2}-\\\\d{2}/.test(text);
    });

    if (!headerCell) return { error: 'Encabezado no encontrado', clientes: [], MESES: [] };

    const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\\\d{2})/g)].map(m => m[1]);
    if (!MESES.length) return { error: 'Sin columnas de meses', clientes: [], MESES: [] };

    // Extraer filas de clientes (identificadas por celda con patron RUT)
    const rutPattern = /^\\\\d{1,2}\\\\.\\\\d{3}\\\\.\\\\d{3}-[\\\\dkK]$/;
    const rutCells   = Array.from(allTds).filter(td => rutPattern.test(td.innerText.trim()));

    const results = [];
    const seen    = new Set();

    rutCells.forEach(rutCell => {
      const rut = rutCell.innerText.trim();
      if (seen.has(rut)) return;
      seen.add(rut);

      const row = rutCell.closest('tr');
      if (!row) return;

      // Estructura de fila: [vacio, RUT, RUT, Nombre, Nombre, mes1..mes12, Total]
      const cells     = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      const rutIdx    = cells.indexOf(rut);
      if (rutIdx < 0) return;

      const nombre     = cells[rutIdx + 2] || cells[rutIdx + 1] || '';
      const monthStart = rutIdx + 4;

      const meses = {};
      for (let i = 0; i < MESES.length; i++) {
        const val = (cells[monthStart + i] || '').trim();
        if (val) {
          const num = parseInt(val.replace(/\\\\./g, ''), 10);
          if (!isNaN(num) && num > 0) meses[MESES[i]] = num * 1000; // miles de pesos a pesos
        }
      }

      const totalStr = (cells[cells.length - 1] || '').trim();
      const total    = totalStr ? parseInt(totalStr.replace(/\\\\./g, ''), 10) * 1000 : 0;

      results.push({ rut, nombre, meses, total });
    });

    return { clientes: results, MESES };
  });

  return { data: resultado, type: 'application/json' };
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

      const result = await resp.json();

      if (result.error) throw new Error('Browser error: ' + result.error);
      if (!Array.isArray(result.clientes)) {
        throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0, 200));
      }

      console.log(`[scraper] OK — ${result.clientes.length} clientes, meses: ${result.MESES ? result.MESES.join(', ') : 'N/A'}`);
      return { clientes: result.clientes, meses: result.MESES || [] };

    } catch (err) {
      console.warn(`[scraper] ${host} fallo: ${err.message}`);
      lastErr = err;
    }
  }

  throw new Error('Todos los endpoints de Browserless fallaron. Ultimo error: ' + (lastErr ? lastErr.message : 'desconocido'));
}

module.exports = { scrapeNuboxResumen };
