export default async function({ page }) {
  // Carga inicial rapida (solo DOM, no esperar SSRS)
  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 25000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar que el elemento hdnMesesMostrar exista en el DOM
  await page.waitForSelector('#hdnMesesMostrar', { timeout: 15000 });

  // Cambiar a "Ano actual": set hdnMesesMostrar = "1" + llamar onclick
  await page.evaluate(() => {
    const hdnEl = document.getElementById('hdnMesesMostrar');
    if (hdnEl) hdnEl.value = '1';
    const sOpt = document.getElementById('s-option');
    if (sOpt && typeof sOpt.onclick === 'function') sOpt.onclick.call(sOpt);
  });

  // Disparar el postback que recarga la pagina con "Ano actual"
  // ReportViewer1$ctl09$ReportControl$ctl00 es el unico target que respeta hdnMesesMostrar
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.evaluate(() => {
      if (typeof __doPostBack === 'function') {
        __doPostBack('ReportViewer1$ctl09$ReportControl$ctl00', '');
      }
    }),
  ]);

  // Esperar que SSRS renderice la vista mensual (Ano actual tiene mas de 60 tds y sin Loading)
  await page.waitForFunction(
    () => {
      const tds = document.querySelectorAll('td');
      if (tds.length < 60) return false;
      return !Array.from(tds).some(td => td.innerText.trim() === 'Loading...');
    },
    { timeout: 35000 }
  );

  // Extraer datos de la vista mensual
  const resultado = await page.evaluate(() => {
    const allTds = Array.from(document.querySelectorAll('td'));

    // Buscar celda header con columnas de meses (Ene-26, Feb-26, ...)
    const headerCell = allTds.find(td => /[A-Z][a-z]{2}-\d{2}/.test(td.innerText || ''));
    if (!headerCell) {
      return {
        error: 'Sin header de meses',
        tdCount: allTds.length,
        first10Tds: allTds.slice(0, 10).map(td => td.innerText.trim().slice(0, 40)),
      };
    }

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
      for (var i = 0; i < MESES.length; i++) {
        var val = (cells[monthStart + i] || '').trim();
        if (val) {
          var n = parseInt(val.replace(/\./g, ''), 10);
          if (!isNaN(n) && n > 0) meses[MESES[i]] = n * 1000;
        }
      }
      var total = parseInt((cells[cells.length - 1] || '').replace(/\./g, ''), 10) * 1000 || 0;
      results.push({ rut: rut, nombre: nombre, meses: meses, total: total });
    });

    return { clientes: results, MESES: MESES };
  });

  if (resultado.error) {
    return { error: 'EXTRACT_FAIL: ' + resultado.error, details: resultado };
  }

  return resultado;
}
