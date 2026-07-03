export default async function({ page }) {
  await page.goto('__NUBOX_URL__', { waitUntil: 'networkidle2', timeout: 45000 });

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

  // Monitor de requests desde el inicio
  const reqLog = [];
  page.on('request', req => {
    const rt = req.resourceType();
    if (rt !== 'image' && rt !== 'stylesheet' && rt !== 'font' && rt !== 'other') {
      reqLog.push({
        method: req.method(), type: rt,
        url: req.url().replace(/utn=[^&]+/, 'utn=***').slice(0, 120),
        bodySnip: (req.postData() || '').slice(0, 300),
      });
    }
  });

  const tdsBefore = (await page.evaluate(() => document.querySelectorAll('td').length));

  // Paso 1: set hdnMesesMostrar = "1" y llamar onclick
  const step1 = await page.evaluate(() => {
    const hdnEl = document.getElementById('hdnMesesMostrar');
    if (hdnEl) hdnEl.value = '1';
    const sOpt = document.getElementById('s-option');
    const hadOnclick = sOpt && typeof sOpt.onclick === 'function';
    if (hadOnclick) sOpt.onclick.call(sOpt);

    // Intentar trigger jQuery change si jQuery existe
    let jqTriggered = false;
    try {
      if (typeof jQuery !== 'undefined') {
        jQuery('#s-option').trigger('change');
        jqTriggered = true;
      }
    } catch(e) {}

    return {
      hdnAfter: hdnEl ? hdnEl.value : 'NOT FOUND',
      hadOnclick: hadOnclick,
      jqTriggered: jqTriggered,
    };
  });

  await new Promise(r => setTimeout(r, 500));

  const results = [];

  // Paso 2: intentar cada target en orden; parar si hdnMesesMostrar se mantiene en "1"
  const targets = [
    'ReportViewer1$ctl09$ReportControl$ctl00',
    'ReportViewer1$ctl09$ReportControl',
    'ReportViewer1$ctl03',
  ];

  let successTarget = null;

  for (const target of targets) {
    const reqsBefore = reqLog.length;

    // Asegurar hdnMesesMostrar = "1" antes de cada postback
    await page.evaluate(() => {
      const hdnEl = document.getElementById('hdnMesesMostrar');
      if (hdnEl) hdnEl.value = '1';
    });

    try {
      await page.evaluate(function(t) {
        if (typeof __doPostBack === 'function') __doPostBack(t, '');
      }, target);
    } catch(e) {}

    // Esperar más que antes: 20 segundos para que SSRS cargue
    await new Promise(r => setTimeout(r, 20000));

    const stateAfter = await page.evaluate(() => {
      const tds = document.querySelectorAll('td');
      const hdnEl = document.getElementById('hdnMesesMostrar');
      return {
        tdCount: tds.length,
        hdnMesesMostrar: hdnEl ? hdnEl.value : 'NOT FOUND',
        fChecked: document.getElementById('f-option') ? document.getElementById('f-option').checked : null,
        sChecked: document.getElementById('s-option') ? document.getElementById('s-option').checked : null,
        first5Tds: Array.from(tds).slice(0, 5).map(td => td.innerText.trim().slice(0, 40)),
        bodySnip: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
        newReqs: 0,
      };
    });
    stateAfter.newReqs = reqLog.length - reqsBefore;

    results.push({ target: target, state: stateAfter });

    // Si hdnMesesMostrar se mantiene en "1" Y tdCount aumentó → probable éxito
    if (stateAfter.hdnMesesMostrar === '1' && stateAfter.tdCount > tdsBefore + 20) {
      successTarget = target;
      break;
    }

    // Si tdCount cambió mucho aunque hdnMesesMostrar volvió a "0", seguir buscando
    if (stateAfter.hdnMesesMostrar === '1') {
      successTarget = target;
      break;
    }
  }

  // Si encontramos un target exitoso, intentar extraer datos
  if (successTarget) {
    const resultado = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td'));
      const headerCell = allTds.find(td => /[A-Z][a-z]{2}-\d{2}/.test(td.innerText || ''));
      if (!headerCell) return { ok: false, reason: 'Sin header de meses' };
      const MESES = [...headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\d{2})/g)].map(m => m[1]);
      const rutPattern = /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/;
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
          if (val) {
            const n = parseInt(val.replace(/\./g, ''), 10);
            if (!isNaN(n) && n > 0) meses[MESES[i]] = n * 1000;
          }
        }
        const total = parseInt((cells[cells.length - 1] || '').replace(/\./g, ''), 10) * 1000 || 0;
        results.push({ rut, nombre, meses, total });
      });
      return { ok: true, clientes: results, MESES };
    });
    if (resultado.ok && resultado.clientes.length > 0) {
      return resultado;
    }
  }

  return {
    error: 'DIAG_v11',
    ssrsLoaded: ssrsLoaded,
    tdsBefore: tdsBefore,
    step1: step1,
    results: results,
    reqLog: reqLog.slice(0, 20),
  };
}
