/**
 * render-service/nubox-scraper.js
 *
 * Fix v9: basado en diagnóstico v8.
 *
 * HALLAZGOS:
 * 1. El radio button (#s-option) está CSS-hidden; el elemento visible es div.check
 *    → page.click('#s-option') no cambia el estado (0 dimensiones)
 * 2. El primer td muestra "Loading..." → SSRS sigue cargando a los 6s
 * 3. Hay un hidden input 'hdnPeriodo' que controla el período del reporte
 * 4. Variables JS: rbUltimos, rbAnioActual → hay event listeners en ellas
 *
 * ESTRATEGIA:
 * A. Esperar que "Loading..." desaparezca (SSRS termina de cargar el reporte default)
 * B. Clicar div.check dentro del <li> de "Año actual" (el elemento VISIBLE)
 * C. Si eso falla, capturar el script completo con hdnPeriodo para llamar la función
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
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // ── A. Esperar que "Loading..." desaparezca (SSRS carga el reporte) ──────
  // Máx 25s para que el reporte default (Últimos 12 meses) esté listo
  let ssrsLoaded = false;
  try {
    await page.waitForFunction(
      () => {
        // "Loading..." es el texto del primer <td> mientras SSRS carga
        const firstTd = document.querySelector('td');
        return firstTd && firstTd.innerText !== 'Loading...' && firstTd.innerText.trim() !== '';
      },
      { timeout: 25000 }
    );
    ssrsLoaded = true;
  } catch(e) { ssrsLoaded = false; }

  const tdBeforeClick = await page.evaluate(() => document.querySelectorAll('td').length);
  const hdnBefore     = await page.evaluate(() => document.getElementById('hdnPeriodo')?.value || 'NOT_FOUND');
  const radiosBefore  = await page.evaluate(() => ({
    f: document.getElementById('f-option')?.checked,
    s: document.getElementById('s-option')?.checked,
  }));

  // ── B. Capturar script completo con hdnPeriodo (para diagnóstico) ─────────
  const scriptContext = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent || '')
      .join('\\n');

    // Encontrar el contexto de 800 chars alrededor de hdnPeriodo
    const idx = scripts.indexOf('hdnPeriodo');
    const ctx = idx >= 0 ? scripts.slice(Math.max(0, idx - 400), idx + 400) : '(no encontrado)';

    // También buscar la función que los radios llaman
    const rbIdx = scripts.indexOf('rbAnioActual');
    const rbCtx = rbIdx >= 0 ? scripts.slice(Math.max(0, rbIdx - 300), rbIdx + 300) : '(no encontrado)';

    return { hdnPeriodoCtx: ctx, rbCtx };
  });

  // ── C. Clicar el div.check visible de "Año actual" ────────────────────────
  // Estructura: <ul.ulRB> > <li> × 2, el 2do es #s-option
  const requestsAfter = [];
  page.on('request', req => {
    if (req.resourceType() !== 'image' && req.resourceType() !== 'stylesheet' && req.resourceType() !== 'font') {
      requestsAfter.push({ url: req.url().replace(/utn=[^&]+/, 'utn=***').slice(0,200), method: req.method(), type: req.resourceType() });
    }
  });

  let checkClickErr = null;
  // Intentar clicar el div.check del segundo <li> (Año actual)
  try {
    await page.click('ul.ulRB li:last-child div.check');
  } catch(e) {
    checkClickErr = 'div.check: ' + e.message;
    try { await page.click('label[for="s-option"]'); }
    catch(e2) { checkClickErr += ' | label: ' + e2.message; }
  }

  await new Promise(r => setTimeout(r, 15000));

  const state2 = await page.evaluate(() => {
    return {
      tdCount: document.querySelectorAll('td').length,
      hdnPeriodo: document.getElementById('hdnPeriodo')?.value || 'NOT_FOUND',
      fChecked: document.getElementById('f-option')?.checked,
      sChecked: document.getElementById('s-option')?.checked,
      bodySnip: document.body.innerText.replace(/\\n+/g, ' ').slice(0, 600),
      firstTdText: (document.querySelector('td')?.innerText || '').trim().slice(0, 50),
    };
  });

  // ── D. Si tdCount cambió, intentar extraer datos ───────────────────────────
  if (state2.tdCount > tdBeforeClick + 10) {
    const resultado = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td'));
      const headerCell = allTds.find(td => {
        const text = td.innerText || '';
        return /[A-Z][a-z]{2}-\\d{2}/.test(text);
      });
      if (!headerCell) {
        const rutPattern = /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;
        const rutCount = allTds.filter(td => rutPattern.test((td.innerText||'').trim())).length;
        return { ok: false, reason: 'Sin header de meses', rutCount, first10: allTds.slice(0,10).map(td=>td.innerText.trim()) };
      }
      const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\d{2})/g)].map(m => m[1]);
      const rutPattern = /^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;
      const rutCells = allTds.filter(td => rutPattern.test((td.innerText||'').trim()));
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
    if (resultado.ok && resultado.clientes.length > 0) return resultado;
  }

  // Retornar diagnóstico
  return {
    error: 'DIAG_v9',
    ssrsLoaded,
    tdBeforeClick,
    hdnBefore,
    radiosBefore,
    scriptContext,
    checkClickErr,
    state2,
    requestsAfter: requestsAfter.slice(0, 15),
  };
}
`;
}

async function scrapeNuboxResumen() {
  const utn   = process.env.NUBOX_UTN;
  const token = process.env.BROWSERLESS_TOKEN;
  if (!utn)   throw new Error('Falta NUBOX_UTN');
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN');

  const targetUrl   = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;
  const browserCode = buildBrowserCode(targetUrl);
  let lastErr = null;

  for (const host of BROWSERLESS_HOSTS) {
    try {
      console.log(`[scraper] POST ${host}/function ...`);
      const resp = await fetch(`${host}/function?token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/javascript' },
        body: browserCode, timeout: 90000,
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error(`HTTP ${resp.status}: ${t.slice(0,200)}`); }
      const raw    = await resp.json();
      const result = (raw && raw.data !== undefined) ? raw.data : raw;

      if (result.error === 'DIAG_v9') {
        console.warn('[v9-ssrsLoaded]', result.ssrsLoaded, '| tdBefore:', result.tdBeforeClick, '| hdnBefore:', result.hdnBefore);
        console.warn('[v9-radiosBefore]', JSON.stringify(result.radiosBefore));
        console.warn('[v9-hdnPeriodoCtx]', result.scriptContext?.hdnPeriodoCtx?.replace(/\n/g,' ').slice(0,800));
        console.warn('[v9-rbCtx]', result.scriptContext?.rbCtx?.replace(/\n/g,' ').slice(0,800));
        console.warn('[v9-checkClickErr]', result.checkClickErr);
        console.warn('[v9-state2]', JSON.stringify(result.state2));
        console.warn('[v9-requests]', JSON.stringify(result.requestsAfter));
        throw new Error('DIAG_v9');
      }

      if (result.error) throw new Error('Browser error: ' + result.error);
      if (!Array.isArray(result.clientes)) throw new Error('Respuesta inesperada: ' + JSON.stringify(result).slice(0,200));

      console.log(`[scraper] OK — ${result.clientes.length} clientes, meses: ${result.MESES?.join(', ')}`);
      return { clientes: result.clientes, meses: result.MESES || [] };
    } catch(err) {
      console.warn(`[scraper] ${host} falló: ${err.message.slice(0,80)}`);
      lastErr = err;
    }
  }
  throw new Error('Todos los endpoints fallaron. Último: ' + lastErr?.message);
}

module.exports = { scrapeNuboxResumen };
