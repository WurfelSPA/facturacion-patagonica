/**
 * render-service/nubox-scraper.js
 *
 * Fix v4: diagnóstico completo pre/post clic + eval() para __doPostBack ASP.NET
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

  // 3. Esperar 4s para que la página cargue controles
  await new Promise(r => setTimeout(r, 4000));

  // 4. Pre-click: capturar estado DOM y link "Año actual"
  const preDiag = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const anioLink = links.find(a => (a.innerText || a.textContent || '').trim() === 'Año actual');
    return {
      tdCount: document.querySelectorAll('td').length,
      anioFound: !!anioLink,
      anioHref: anioLink ? (anioLink.getAttribute('href') || '').slice(0, 200) : null,
      anioId:   anioLink ? anioLink.id : null,
      allLinks: links.map(a => ({
        t: (a.innerText || '').trim().slice(0, 40),
        h: (a.getAttribute('href') || '').slice(0, 120)
      })).filter(l => l.t).slice(0, 35)
    };
  });

  // 5. Hacer clic en "Año actual" — usar eval() si href es javascript:
  const clickResult = await page.evaluate(() => {
    // Primero buscar entre <a> tags
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(a => (a.innerText || a.textContent || '').trim() === 'Año actual');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (href.toLowerCase().startsWith('javascript:')) {
        try {
          eval(href.slice('javascript:'.length));
          return { ok: true, method: 'eval', href: href.slice(0, 150) };
        } catch(e) {
          link.click();
          return { ok: true, method: 'click_fallback', err: e.message, href: href.slice(0, 80) };
        }
      }
      link.click();
      return { ok: true, method: 'click', href: href.slice(0, 80) };
    }
    // Fallback: cualquier elemento con ese texto
    const all = Array.from(document.querySelectorAll('a, button, span, input, li'));
    const el = all.find(e => (e.innerText || e.textContent || e.value || '').trim() === 'Año actual');
    if (el) {
      el.click();
      return { ok: true, method: 'generic', tag: el.tagName };
    }
    return { ok: false };
  });

  // 6. Esperar que la tabla cargue mensualmente (35s máx para quedar en ≤55s total)
  let timedOut = false;
  const initCount = preDiag.tdCount || 46;
  try {
    await page.waitForFunction(
      (ic) => {
        // Opción A: celdas con patrón RUT
        const tds = Array.from(document.querySelectorAll('td'));
        if (tds.some(td => /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/.test((td.innerText || '').trim()))) return true;
        // Opción B: columnas de meses en texto
        if (/Ene-\\d{2}|Feb-\\d{2}|Mar-\\d{2}/.test(document.body.innerText)) return true;
        // Opción C: tdCount aumentó mucho (se cargaron filas)
        if (document.querySelectorAll('td').length > ic + 15) return true;
        return false;
      },
      { timeout: 35000 },
      initCount
    );
  } catch(e) {
    timedOut = true;
  }

  if (timedOut) {
    const postDiag = await page.evaluate(() => ({
      tdCount:  document.querySelectorAll('td').length,
      bodySnip: document.body.innerText.slice(0, 800),
      url:      location.href,
    }));
    return { error: 'TIMEOUT_35s', preDiag, clickResult, postDiag };
  }

  // 7. Extraer datos del DOM
  const resultado = await page.evaluate(() => {
    const allTds = Array.from(document.querySelectorAll('td'));

    // Buscar encabezado con columnas de meses
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
        // Loguear diagnóstico detallado
        if (result.preDiag)    console.warn('[scraper] PRE-DIAG:',   JSON.stringify(result.preDiag));
        if (result.clickResult) console.warn('[scraper] CLICK:',     JSON.stringify(result.clickResult));
        if (result.postDiag)   console.warn('[scraper] POST-DIAG:',  JSON.stringify(result.postDiag));
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
