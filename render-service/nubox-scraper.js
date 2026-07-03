/**
 * render-service/nubox-scraper.js
 *
 * Fix: el Resumen de Ventas por default muestra vista resumen (Cliente, Total).
 * Hay que hacer clic en "Año actual" para cargar la vista mensual (Ene-26 … Jul-26).
 * El clic dispara AJAX de ASP.NET UpdatePanel → la tabla se recarga con columnas de meses.
 *
 * Browserless free tier: hard timeout 60s → waitForFunction máx 40s.
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
  // 1. Navegar al Dashboard con UTN
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Verificar que no redirigió a login
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // 3. Esperar 3s para que el página inicial cargue controles
  await new Promise(r => setTimeout(r, 3000));

  // 4. Hacer clic en "Año actual" para cargar vista mensual (Ene-26 … mes-actual)
  //    El clic dispara el UpdatePanel de ASP.NET que recarga la tabla con columnas de meses.
  const clickResult = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, span, input, label, li, td'));
    const el = all.find(e => {
      const text = (e.innerText || e.textContent || e.value || '').trim();
      return text === 'Año actual';
    });
    if (el) {
      el.click();
      return { clicked: true, tag: el.tagName, text: el.innerText };
    }
    // Fallback: buscar por href o data-*
    const link = document.querySelector('a[href*="actual"], [data-value="actual"]');
    if (link) {
      link.click();
      return { clicked: true, tag: link.tagName, via: 'href/data' };
    }
    // Retornar todos los textos de links para debug
    const linkTexts = Array.from(document.querySelectorAll('a')).map(a => a.innerText.trim()).filter(Boolean).slice(0, 20);
    return { clicked: false, linkTexts };
  });
  console.log('[browser] clickResult:', JSON.stringify(clickResult));

  // 5. Esperar a que la tabla se recargue con columnas de meses (patrón RUT en celdas)
  //    Máximo 40s (Browserless free tier mata la conexión a los 60s)
  let timedOut = false;
  try {
    await page.waitForFunction(
      () => {
        const tds = Array.from(document.querySelectorAll('td'));
        return tds.some(td => /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/.test((td.innerText || '').trim()));
      },
      { timeout: 40000 }
    );
  } catch(e) {
    timedOut = true;
  }

  if (timedOut) {
    // Diagnóstico: capturar estado actual
    const diag = await page.evaluate(() => {
      const tds = Array.from(document.querySelectorAll('td'));
      const headerCell = tds.find(td => {
        const text = td.innerText || '';
        return text.includes('Cliente') && text.includes('Total');
      });
      return {
        tdCount:    tds.length,
        headerText: headerCell ? (headerCell.innerText || '').slice(0, 200) : null,
        bodySnip:   (document.body ? document.body.innerText : '').slice(0, 500),
        url:        location.href,
      };
    });
    return { error: 'TIMEOUT_40s_post_click', diag };
  }

  // 6. Extraer datos
  const resultado = await page.evaluate(() => {
    const allTds = Array.from(document.querySelectorAll('td'));

    // Encabezado con columnas de meses
    const headerCell = allTds.find(td => {
      const text = td.innerText || '';
      return text.includes('Cliente') && text.includes('Total') &&
             /[A-Z][a-z]{2}-\\d{2}/.test(text);
    });

    if (!headerCell) {
      // Intentar encabezado distribuido (th elements)
      const ths = Array.from(document.querySelectorAll('th'));
      const mesRE = /^[A-Z][a-z]{2}-\\d{2}$/;
      const mesHeaders = ths.filter(th => mesRE.test((th.innerText || '').trim())).map(th => (th.innerText || '').trim());
      if (mesHeaders.length === 0) {
        return { error: 'Encabezado de meses no encontrado', tdCount: allTds.length, clientes: [], MESES: [] };
      }
      // Usar th-based approach
      const MESES = mesHeaders;
      const rutPattern = /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;
      const rutCells   = allTds.filter(td => rutPattern.test((td.innerText || '').trim()));
      // ... (continuación abajo)
    }

    const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\d{2})/g)].map(m => m[1]);
    if (!MESES.length) return { error: 'Sin columnas de meses en encabezado', clientes: [], MESES: [] };

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

      const cells     = Array.from(row.querySelectorAll('td')).map(c => (c.innerText || '').trim());
      const rutIdx    = cells.indexOf(rut);
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

      const raw = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error) {
        if (result.diag) console.warn('[scraper] DIAG:', JSON.stringify(result.diag));
        throw new Error('Browser error: ' + result.error);
      }
      if (!Array.isArray(result.clientes)) {
        throw new Error('Respuesta inesperada: ' + JSON.stringify(raw).slice(0, 300));
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
