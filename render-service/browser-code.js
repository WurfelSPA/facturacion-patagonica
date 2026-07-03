export default async function({ page }) {
  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 25000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar 4s para que los scripts Nubox se inicialicen
  await new Promise(r => setTimeout(r, 4000));

  // Cambiar a "Ano actual"
  await page.evaluate(() => {
    const h = document.getElementById('hdnMesesMostrar');
    if (h) h.value = '1';
    const s = document.getElementById('s-option');
    if (s && typeof s.onclick === 'function') s.onclick.call(s);
  });

  // Disparar postback que causa recarga completa de pagina
  await page.evaluate(() => {
    if (typeof __doPostBack === 'function') {
      __doPostBack('ReportViewer1$ctl09$ReportControl$ctl00', '');
    }
  });

  // Esperar 8s para que la recarga de pagina se complete
  await new Promise(r => setTimeout(r, 8000));

  // Esperar que SSRS renderice la vista mensual en la nueva pagina
  // hdnMesesMostrar="1" + tds>60 + sin Loading = exito
  await page.waitForFunction(
    () => {
      const hdn = document.getElementById('hdnMesesMostrar');
      if (!hdn || hdn.value !== '1') return false;
      const tds = document.querySelectorAll('td');
      if (tds.length < 60) return false;
      return !Array.from(tds).some(td => td.innerText.trim() === 'Loading...');
    },
    { timeout: 35000, polling: 2000 }
  );

  // Extraer datos de la vista mensual
  const resultado = await page.evaluate(() => {
    const allTds = Array.from(document.querySelectorAll('td'));

    const headerCell = allTds.find(td => /[A-Z][a-z]{2}-\d{2}/.test(td.innerText || ''));
    if (!headerCell) {
      return {
        error: 'Sin header de meses',
        tdCount: allTds.length,
        first10: allTds.slice(0, 10).map(td => td.innerText.trim().slice(0, 40)),
        hdnVal: (document.getElementById('hdnMesesMostrar') || {}).value,
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

    return { clientes: results, MESES };
  });

  if (resultado.error) {
    return { error: 'EXTRACT_FAIL: ' + resultado.error, details: resultado };
  }

  return resultado;
}
