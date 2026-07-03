export default async function({ page }) {
  var controlId = null;

  // Capturar ControlID del request de SessionKeepAlive del ReportViewer
  page.on('request', function(req) {
    var url = req.url();
    var m = url.match(/ControlID=([a-f0-9]{32})/i);
    if (m && !controlId) controlId = m[1];
  });

  // Cargar la página (domcontentloaded = rápido, solo necesitamos el ControlID)
  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 30000 });

  var currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar 8s para que el JS del ReportViewer se inicialice y envíe keepalive
  await new Promise(function(resolve) { setTimeout(resolve, 8000); });

  if (!controlId) {
    return { error: 'NO_CONTROL_ID: ReportViewer no envió keepalive en 8s', pageUrl: page.url() };
  }

  // Exportar CSV via endpoint SSRS axd (polling cada 5s, hasta 9 intentos = 45s)
  var exportUrl = 'https://app.nubox.com/ServiFactura/Reserved.ReportViewerWebControl.axd' +
    '?OpType=Export&ControlID=' + controlId + '&Format=CSV&ContentDisposition=AlwaysInline';

  var resultStr = await page.evaluate(
    '(async function(){' +
    '  var url = "' + exportUrl + '";' +
    '  for(var i = 0; i < 9; i++) {' +
    '    await new Promise(function(r){ setTimeout(r, 5000); });' +
    '    try {' +
    '      var resp = await fetch(url);' +
    '      var text = await resp.text();' +
    '      var isCSV = resp.status === 200 && text.length > 50 && text.charCodeAt(0) !== 60;' +
    '      if(isCSV) {' +
    '        return JSON.stringify({ok:true, csv:text, attempt:i, status:200});' +
    '      }' +
    '      if(i === 8) {' +
    '        return JSON.stringify({ok:false, status:resp.status, body:text.slice(0,500), attempt:i});' +
    '      }' +
    '    } catch(e) {' +
    '      if(i === 8) return JSON.stringify({ok:false, error:e.message, attempt:i});' +
    '    }' +
    '  }' +
    '  return JSON.stringify({error:"EXPORT_TIMEOUT_45s"});' +
    '})()'
  );

  var result = JSON.parse(resultStr);

  if (!result.ok) {
    return { error: 'EXPORT_FAILED', controlId: controlId, details: result };
  }

  // Parsear CSV de SSRS
  var lines = result.csv.split('\n').map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });
  if (lines.length < 2) {
    return { error: 'CSV_VACIO', controlId: controlId, lineas: lines.length, preview: result.csv.slice(0,300) };
  }

  // Devolver las primeras líneas para ver el formato
  return {
    ok: true,
    controlId: controlId,
    attempt: result.attempt,
    totalLineas: lines.length,
    preview: lines.slice(0, 5).join('\n'),
    rawCsvLength: result.csv.length
  };
}
