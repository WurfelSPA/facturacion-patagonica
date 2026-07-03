/**
 * render-service/nubox-scraper.js
 *
 * Fix v8: diagnóstico definitivo — captura el estado real del radio por defecto,
 * todos los 46 td texts, iframes, hidden inputs, y prueba clicar EL OTRO radio.
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

  await new Promise(r => setTimeout(r, 6000));

  // ── Captura estado inicial ─────────────────────────────────────────────────
  const initial = await page.evaluate(() => {
    const fOpt = document.getElementById('f-option');
    const sOpt = document.getElementById('s-option');

    // Todos los td texts
    const allTdTexts = Array.from(document.querySelectorAll('td'))
      .map(td => td.innerText.trim())
      .filter(t => t.length > 0);

    // Iframes
    const iframes = Array.from(document.querySelectorAll('iframe'))
      .map(f => ({ id: f.id, src: f.src.slice(0, 200), name: f.name }));

    // Hidden inputs del form (SSRS params)
    const hiddenInputs = Array.from(document.querySelectorAll('input[type="hidden"]'))
      .map(i => ({ name: i.name, id: i.id, value: i.value.slice(0, 80) }))
      .filter(i => i.name || i.id);

    // Estado de radios
    const radioState = {
      fOption: { id: fOpt?.id, checked: fOpt?.checked, value: fOpt?.value },
      sOption: { id: sOpt?.id, checked: sOpt?.checked, value: sOpt?.value },
    };

    // Buscar inputs tipo hidden del ReportViewer (parámetros SSRS)
    const ssrsParams = Array.from(document.querySelectorAll('[id*="ReportViewer"]'))
      .map(el => ({ tag: el.tagName, id: el.id, type: el.type, value: (el.value||'').slice(0,80) }))
      .filter(el => el.value || el.type === 'hidden');

    // Scripts buscando "selector" o "periodo"  
    const scriptMatch = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent)
      .join('\\n')
      .split('\\n')
      .filter(l => /selector|ulRB|s.option|f.option|periodo|Period|cargarReporte|loadReport|toggleView/i.test(l))
      .join('\\n')
      .slice(0, 2000);

    return { allTdTexts, iframes, hiddenInputs, radioState, ssrsParams, scriptMatch };
  });

  // ── Decidir qué radio clicar ───────────────────────────────────────────────
  // Si #s-option ya está checked por defecto, clicar #f-option (el opuesto)
  const defaultIsS = initial.radioState.sOption.checked;
  const targetSelector = defaultIsS ? '#f-option' : '#s-option';
  const targetLabel    = defaultIsS ? 'label[for="f-option"]' : 'label[for="s-option"]';

  // Monitorear requests después del click
  const requestsAfterClick = [];
  page.on('request', req => {
    const url = req.url().replace(/utn=[^&]+/, 'utn=***');
    requestsAfterClick.push({ url: url.slice(0, 200), method: req.method(), type: req.resourceType() });
  });

  // Clicar el radio OPUESTO al default (para forzar un cambio de estado)
  let clickErr = null;
  try {
    await page.click(targetSelector);
  } catch(e) {
    clickErr = 'radio: ' + e.message;
    try { await page.click(targetLabel); } catch(e2) { clickErr += ' | label: ' + e2.message; }
  }

  await new Promise(r => setTimeout(r, 20000));

  const afterClick = await page.evaluate(() => {
    const fOpt = document.getElementById('f-option');
    const sOpt = document.getElementById('s-option');
    const allTdTexts = Array.from(document.querySelectorAll('td'))
      .map(td => td.innerText.trim())
      .filter(t => t.length > 0);
    const bodySnip = document.body.innerText.slice(0, 1200);
    return {
      tdCount: document.querySelectorAll('td').length,
      allTdTexts,
      bodySnip,
      fOptionChecked: fOpt?.checked,
      sOptionChecked: sOpt?.checked,
    };
  });

  return {
    error: 'DIAG_v8',
    initial,
    defaultIsS,
    targetSelector,
    clickErr,
    afterClick,
    requestsAfterClick: requestsAfterClick.filter(r => r.type !== 'image' && r.type !== 'stylesheet' && r.type !== 'font').slice(0, 20),
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

      if (result.error === 'DIAG_v8') {
        const { initial, defaultIsS, targetSelector, clickErr, afterClick, requestsAfterClick } = result;
        // Log en UNA SOLA LÍNEA para evitar contaminación del log viewer
        console.warn('[v8-RADIO-DEFAULT]', JSON.stringify(initial.radioState));
        console.warn('[v8-TDS-BEFORE]', JSON.stringify(initial.allTdTexts));
        console.warn('[v8-IFRAMES]', JSON.stringify(initial.iframes));
        console.warn('[v8-SSRS-PARAMS]', JSON.stringify(initial.ssrsParams));
        console.warn('[v8-SCRIPT-MATCH]', initial.scriptMatch.slice(0, 500) || '(ninguno)');
        console.warn('[v8-CLICKED]', targetSelector, '| err:', clickErr);
        console.warn('[v8-AFTER-tdCount]', afterClick.tdCount, '| fChecked:', afterClick.fOptionChecked, '| sChecked:', afterClick.sOptionChecked);
        console.warn('[v8-AFTER-TDS]', JSON.stringify(afterClick.allTdTexts));
        console.warn('[v8-REQUESTS]', JSON.stringify(requestsAfterClick));
        console.warn('[v8-BODY-AFTER]', afterClick.bodySnip.replace(/\n+/g, ' ').slice(0, 500));
        throw new Error('DIAG_v8');
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
