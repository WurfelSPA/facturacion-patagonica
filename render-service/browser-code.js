export default async function({ page }) {
  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 25000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar que hdnMesesMostrar exista
  await page.waitForSelector('#hdnMesesMostrar', { timeout: 15000 });

  // Set hdnMesesMostrar="1" y llamar onclick (usando string para evitar strict-mode issue)
  await page.evaluate(
    'var h=document.getElementById("hdnMesesMostrar");if(h)h.value="1";' +
    'var s=document.getElementById("s-option");if(s&&s.onclick)s.onclick.call(s);'
  );

  // Preparar listener de navegacion ANTES de disparar el postback
  const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

  // Disparar postback que recarga la pagina con "Ano actual"
  await page.evaluate(
    'if(typeof __doPostBack==="function")__doPostBack("ReportViewer1$ctl09$ReportControl$ctl00","")'
  );

  // Esperar recarga completa
  await navPromise;

  // Esperar que SSRS renderice la vista mensual (>60 tds, sin Loading)
  await page.waitForFunction(
    'var tds=document.querySelectorAll("td");' +
    'if(tds.length<60)return false;' +
    'return !Array.from(tds).some(function(td){return td.innerText.trim()==="Loading...";});',
    { timeout: 35000 }
  );

  // Extraer datos
  const resultado = await page.evaluate(function() {
    var allTds = Array.from(document.querySelectorAll('td'));

    var headerCell = null;
    for (var i = 0; i < allTds.length; i++) {
      if (/[A-Z][a-z]{2}-\d{2}/.test(allTds[i].innerText || '')) {
        headerCell = allTds[i];
        break;
      }
    }
    if (!headerCell) {
      return {
        error: 'Sin header de meses',
        tdCount: allTds.length,
        first10: allTds.slice(0, 10).map(function(td) { return td.innerText.trim().slice(0, 40); }),
      };
    }

    var MESES = [];
    var mm = headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\d{2})/g);
    var match = mm.next();
    while (!match.done) { MESES.push(match.value[1]); match = mm.next(); }

    var rutPattern = /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/;
    var results = [];
    var seen = {};

    allTds.forEach(function(rutCell) {
      var rut = (rutCell.innerText || '').trim();
      if (!rutPattern.test(rut) || seen[rut]) return;
      seen[rut] = true;
      var row = rutCell.closest('tr');
      if (!row) return;
      var cells = Array.from(row.querySelectorAll('td')).map(function(c) { return c.innerText.trim(); });
      var rutIdx = cells.indexOf(rut);
      if (rutIdx < 0) return;
      var nombre = cells[rutIdx + 2] || cells[rutIdx + 1] || '';
      var monthStart = rutIdx + 4;
      var meses = {};
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
