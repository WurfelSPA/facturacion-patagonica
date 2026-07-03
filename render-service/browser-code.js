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

  // Capturar info de la pagina
  const pageInfo = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent || '').join(' ');

    // cargaCustomRadioButtons completa (2000 chars)
    const fnIdx = scripts.indexOf('cargaCustomRadioButtons');
    const fnCtx = fnIdx >= 0 ? scripts.slice(Math.max(0, fnIdx - 50), fnIdx + 2000) : 'NOT FOUND';

    // Todos los __doPostBack targets
    const pbMatches = [];
    const re = /__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/g;
    let m;
    while ((m = re.exec(scripts)) !== null) {
      pbMatches.push({ target: m[1], arg: m[2] });
    }

    // hdnMesesMostrar
    const hdnEl = document.getElementById('hdnMesesMostrar');

    // Elementos con onclick
    const clickables = Array.from(document.querySelectorAll('[onclick]'))
      .map(el => ({
        tag: el.tagName, id: el.id || '',
        onclick: (el.getAttribute('onclick') || '').slice(0, 120),
      })).slice(0, 20);

    // Formularios
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, action: (f.action || '').slice(0, 80),
    }));

    // ASP.NET hiddens
    const evtTarget = document.getElementById('__EVENTTARGET');
    const evtArg    = document.getElementById('__EVENTARGUMENT');

    return {
      fnCtx: fnCtx,
      pbTargets: pbMatches.slice(0, 30),
      hdnMesesMostrar: hdnEl ? { value: hdnEl.value, type: hdnEl.type } : null,
      clickables: clickables,
      forms: forms,
      aspNet: {
        eventTarget: evtTarget ? evtTarget.value : 'NOT FOUND',
        eventArg: evtArg ? evtArg.value : 'NOT FOUND',
      },
    };
  });

  // Monitor de requests
  const reqLog = [];
  page.on('request', req => {
    const rt = req.resourceType();
    if (rt !== 'image' && rt !== 'stylesheet' && rt !== 'font' && rt !== 'other') {
      reqLog.push({
        method: req.method(), type: rt,
        url: req.url().replace(/utn=[^&]+/, 'utn=***').slice(0, 180),
        body: (req.postData() || '').slice(0, 200),
      });
    }
  });

  // Llamar onclick de s-option directamente
  const onclickResult = await page.evaluate(() => {
    const el = document.getElementById('s-option');
    if (!el) return { err: 'no s-option' };
    const hadOnclick = typeof el.onclick === 'function';
    if (hadOnclick) el.onclick.call(el);
    const hdnEl = document.getElementById('hdnMesesMostrar');
    return {
      hadOnclick: hadOnclick,
      hdnMesesMostrar: hdnEl ? hdnEl.value : 'NOT FOUND',
    };
  });

  await new Promise(r => setTimeout(r, 1000));

  // Intentar cada __doPostBack target encontrado
  const triedTargets = [];
  for (const pb of pageInfo.pbTargets.slice(0, 10)) {
    const before = reqLog.length;
    try {
      await page.evaluate(function(t, a) {
        if (typeof __doPostBack === 'function') __doPostBack(t, a);
      }, pb.target, pb.arg);
      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {}
    triedTargets.push({ target: pb.target, arg: pb.arg, newReqs: reqLog.length - before });
    if (reqLog.length - before > 0) break;
  }

  // Si ninguno funcionó, probar targets SSRS estandar
  if (reqLog.length === 0) {
    const ssrsTargets = ['ReportViewer1$ctl09$ctl00', 'ReportViewer1$ctl06', 'ReportViewer1$ctl05$ctl00'];
    for (const t of ssrsTargets) {
      const before = reqLog.length;
      try {
        await page.evaluate(function(tgt) {
          if (typeof __doPostBack === 'function') __doPostBack(tgt, '');
        }, t);
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {}
      triedTargets.push({ target: t, arg: '', newReqs: reqLog.length - before });
      if (reqLog.length - before > 0) break;
    }
  }

  await new Promise(r => setTimeout(r, 8000));

  const state2 = await page.evaluate(() => {
    const tds = document.querySelectorAll('td');
    const hdnEl = document.getElementById('hdnMesesMostrar');
    const fEl   = document.getElementById('f-option');
    const sEl   = document.getElementById('s-option');
    return {
      tdCount: tds.length,
      hdnMesesMostrar: hdnEl ? hdnEl.value : 'NOT FOUND',
      fChecked: fEl ? fEl.checked : null,
      sChecked: sEl ? sEl.checked : null,
      first5Tds: Array.from(tds).slice(0, 5).map(td => td.innerText.trim().slice(0, 40)),
      bodySnip: document.body.innerText.replace(/\s+/g, ' ').slice(0, 700),
    };
  });

  return {
    error: 'DIAG_v10',
    ssrsLoaded: ssrsLoaded,
    pageInfo: pageInfo,
    onclickResult: onclickResult,
    triedTargets: triedTargets,
    state2: state2,
    reqLog: reqLog.slice(0, 20),
  };
}
