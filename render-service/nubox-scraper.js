/**
 * render-service/nubox-scraper.js  — diag v10
 *
 * HALLAZGOS v9:
 * - hdnPeriodo NO existe (código comentado)
 * - hdnMesesMostrar es el control real: "0"=Últimos12, "1"=AñoActual
 * - onclick de s-option SOLO asigna hdnMesesMostrar (no hay __doPostBack en ese handler)
 * - snippet corta en "if (documen..." → necesitamos el resto de cargaCustomRadioButtons
 * - page.click y div.check no cambian el radio state
 *
 * ESTRATEGIA v10:
 * 1. networkidle2 para esperar SSRS
 * 2. Capturar cargaCustomRadioButtons COMPLETA (2000 chars) + TODOS los __doPostBack targets
 * 3. Llamar s-option.onclick() via evaluate (directo, sin Puppeteer click)
 * 4. Intentar cada __doPostBack target encontrado en el script
 * 5. Intentar target estándar SSRS ReportViewer1$ctl09$ctl00
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
  await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle2', timeout: 45000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar SSRS: > 20 tds y sin "Loading..."
  let ssrsLoaded = false;
  try {
    await page.waitForFunction(
      () => {
        const tds = document.querySelectorAll('td');
        if (tds.length < 20) return false;
        return !Array.from(tds).some(td => td.innerText.trim() === 'Loading...');
      },
      { timeout: 30000 }
    );
    ssrsLoaded = true;
  } catch(e) { ssrsLoaded = false; }

  // Capturar scripts + DOM info
  const pageInfo = await page.evaluate(() => {
    const allScripts = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent || '').join('\n');

    // Función completa cargaCustomRadioButtons (2000 chars desde el inicio)
    const fnIdx = allScripts.indexOf('cargaCustomRadioButtons');
    const fnCtx = fnIdx >= 0
      ? allScripts.slice(Math.max(0, fnIdx - 50), fnIdx + 2000)
      : 'NOT FOUND';

    // TODOS los __doPostBack targets en el script
    const pbMatches = [...allScripts.matchAll(/__doPostBack\\s*\\(\\s*['"]([^'"]+)['"]\\s*,\\s*['"]([^'"]*)['"]\\s*\\)/g)]
      .map(m => ({ target: m[1], arg: m[2] }));

    // hdnMesesMostrar
    const hdnEl = document.getElementById('hdnMesesMostrar');

    // Todos los buttons y inputs con onclick
    const clickables = Array.from(document.querySelectorAll('[onclick],[type=submit],[type=button],button'))
      .filter(el => el.id || el.getAttribute('onclick'))
      .map(el => ({
        tag: el.tagName, id: el.id, name: el.name,
        value: (el.value || '').slice(0, 40),
        onclick: (el.getAttribute('onclick') || '').slice(0, 120),
      })).slice(0, 20);

    // Formularios
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, action: (f.action || '').slice(0, 80),
    }));

    // __EVENTTARGET y __EVENTARGUMENT (ASP.NET postback)
    const evtTarget = document.getElementById('__EVENTTARGET');
    const evtArg    = document.getElementById('__EVENTARGUMENT');

    return {
      fnCtx,
      pbTargets: pbMatches.slice(0, 30),
      hdnMesesMostrar: hdnEl ? { value: hdnEl.value, type: hdnEl.type } : null,
      clickables,
      forms,
      aspNetHiddens: {
        eventTarget: evtTarget ? evtTarget.value : 'NOT FOUND',
        eventArg: evtArg ? evtArg.value : 'NOT FOUND',
      },
    };
  });

  // Monitor de requests
  const reqLog = [];
  page.on('request', req => {
    if (!['image','stylesheet','font','other'].includes(req.resourceType())) {
      const body = req.postData() || '';
      reqLog.push({
        method: req.method(), type: req.resourceType(),
        url: req.url().replace(/utn=[^&]+/, 'utn=***').slice(0, 180),
        bodySnip: body.slice(0, 200),
      });
    }
  });

  // ── FIX INTENTO: llamar onclick de s-option via evaluate ──────────────────
  const onclickResult = await page.evaluate(() => {
    const el = document.getElementById('s-option');
    if (!el) return { err: 'no s-option' };
    const hadOnclick = typeof el.onclick === 'function';
    if (hadOnclick) {
      el.onclick.call(el);
    }
    const hdnEl = document.getElementById('hdnMesesMostrar');
    return {
      hadOnclick,
      hdnMesesMostrar: hdnEl ? hdnEl.value : 'NOT FOUND',
    };
  });

  await new Promise(r => setTimeout(r, 1000));

  // ── Intentar cada __doPostBack target encontrado ───────────────────────────
  const triedTargets = [];
  for (const pb of pageInfo.pbTargets.slice(0, 10)) {
    const before = reqLog.length;
    try {
      await page.evaluate((t, a) => {
        if (typeof __doPostBack === 'function') __doPostBack(t, a);
      }, pb.target, pb.arg);
      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {}
    triedTargets.push({ target: pb.target, arg: pb.arg, newReqs: reqLog.length - before });
    if (reqLog.length - before > 0) break;  // funcionó → parar
  }

  // Si ninguno funcionó, probar target estándar SSRS
  if (reqLog.length === 0) {
    for (const t of ['ReportViewer1$ctl09$ctl00', 'ReportViewer1$ctl06', 'ReportViewer1$ctl05$ctl00']) {
      const before = reqLog.length;
      try {
        await page.evaluate(tgt => {
          if (typeof __doPostBack === 'function') __doPostBack(tgt, '');
        }, t);
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {}
      triedTargets.push({ target: t, arg: '', newReqs: reqLog.length - before });
      if (reqLog.length - before > 0) break;
    }
  }

  await new Promise(r => setTimeout(r, 8000));

  const state2 = await page.evaluate(() => ({
    tdCount: document.querySelectorAll('td').length,
    hdnMesesMostrar: document.getElementById('hdnMesesMostrar')?.value,
    fChecked: document.getElementById('f-option')?.checked,
    sChecked: document.getElementById('s-option')?.checked,
    first5Tds: Array.from(document.querySelectorAll('td')).slice(0, 5).map(td => td.innerText.trim().slice(0, 40)),
    bodySnip: document.body.innerText.replace(/\\n+/g,' ').slice(0, 700),
  }));

  // Si el tdCount cambió significativamente → intentar extraer datos
  const initialTdCount = ssrsLoaded ? state2.tdCount : 46;
  if (state2.tdCount > initialTdCount + 20) {
    const resultado = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td'));
      const headerCell = allTds.find(td => /[A-Z][a-z]{2}-\\d{2}/.test(td.innerText || ''));
      if (!headerCell) return { ok: false, reason: 'Sin header de meses' };
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

  return {
    error: 'DIAG_v10',
    ssrsLoaded,
    pageInfo,
    onclickResult,
    triedTargets,
    state2,
    reqLog: reqLog.slice(0, 20),
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

      if (result.error === 'DIAG_v10') {
        console.warn('[v10-ssrsLoaded]', result.ssrsLoaded);
        console.warn('[v10-hdnMesesMostrar-el]', JSON.stringify(result.pageInfo?.hdnMesesMostrar));
        console.warn('[v10-fnCtx]', (result.pageInfo?.fnCtx||'').replace(/\n/g,' ').slice(0, 1500));
        console.warn('[v10-pbTargets]', JSON.stringify(result.pageInfo?.pbTargets));
        console.warn('[v10-clickables]', JSON.stringify(result.pageInfo?.clickables));
        console.warn('[v10-forms]', JSON.stringify(result.pageInfo?.forms));
        console.warn('[v10-aspNet]', JSON.stringify(result.pageInfo?.aspNetHiddens));
        console.warn('[v10-onclickResult]', JSON.stringify(result.onclickResult));
        console.warn('[v10-triedTargets]', JSON.stringify(result.triedTargets));
        console.warn('[v10-state2]', JSON.stringify(result.state2));
        console.warn('[v10-reqLog]', JSON.stringify(result.reqLog));
        throw new Error('DIAG_v10');
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
