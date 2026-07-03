/**
 * render-service/nubox-scraper.js
 *
 * Browserless free tier: hard timeout = 60s per /function call.
 * waitForFunction must use ≤45s so the error return completes before kill.
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
  // 1. Navegar con domcontentloaded (más rápido; waitForFunction espera la tabla)
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Verificar que no redirigió a login
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Helper: buscar TDs en main frame + iframes (Nubox ReportViewer vive en iframe)
  // NOTA: debe definirse inline porque waitForFunction no cierra sobre variables externas.
  const ALL_TDS_FN = () => {
    function getAllTds() {
      const tds = Array.from(document.querySelectorAll('td'));
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (iDoc) tds.push(...Array.from(iDoc.querySelectorAll('td')));
        } catch(e) {}
      }
      return tds;
    }
    return getAllTds().some(td =>
      /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/.test((td.innerText || '').trim())
    );
  };

  // 3. Esperar tabla. MÁXIMO 45s para retornar ANTES del kill de Browserless (60s).
  let timedOut = false;
  try {
    await page.waitForFunction(ALL_TDS_FN, { timeout: 45000 });
  } catch(e) {
    timedOut = true;
  }

  if (timedOut) {
    // Capturar diagnóstico para saber qué hay en la página
    const diag = await page.evaluate(() => {
      function getAllTds() {
        const tds = Array.from(document.querySelectorAll('td'));
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          try {
            const iDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (iDoc) tds.push(...Array.from(iDoc.querySelectorAll('td')));
          } catch(e) {}
        }
        return tds;
      }
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return {
        title:       document.title,
        url:         location.href,
        mainTds:     document.querySelectorAll('td').length,
        allTds:      getAllTds().length,
        iframes:     iframes.length,
        iframeSrcs:  iframes.map(f => (f.src || f.name || '').slice(0, 80)).slice(0, 5),
        bodySnip:    (document.body ? document.body.innerText : '').slice(0, 300),
      };
    });
    return { error: 'TIMEOUT_45s', diag };
  }

  // 4. Extraer datos del DOM (main frame + iframes)
  const resultado = await page.evaluate(() => {
    function getAllTds() {
      const tds = Array.from(document.querySelectorAll('td'));
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (iDoc) tds.push(...Array.from(iDoc.querySelectorAll('td')));
        } catch(e) {}
      }
      return tds;
    }
    const allTds = getAllTds();

    // Detectar encabezado de meses (ej: "Ene-26", "Feb-26", ...)
    const headerCell = allTds.find(td => {
      const text = td.innerText || '';
      return text.includes('Cliente') && text.includes('Total') &&
             /[A-Z][a-z]{2}-\\d{2}/.test(text);
    });

    if (!headerCell) return { error: 'Encabezado no encontrado', clientes: [], MESES: [] };

    const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\d{2})/g)].map(m => m[1]);
    if (!MESES.length) return { error: 'Sin columnas de meses', clientes: [], MESES: [] };

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

      // Browserless puede entregar {data,type} o el objeto directo; normalizamos.
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error) {
        // Loguear diagnóstico si viene (TIMEOUT_45s)
        if (result.diag) {
          console.warn('[scraper] DIAG:', JSON.stringify(result.diag));
        }
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
