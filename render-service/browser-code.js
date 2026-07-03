export default async function({ page }) {
  var controlId = null;

  page.on('request', function(req) {
    var url = req.url();
    var m = url.match(/ControlID=([a-f0-9]{32})/i);
    if (m && !controlId) controlId = m[1];
  });

  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 25000 });

  var currentUrl = page.url();
  if (/login|account/i.test(currentUrl)) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar 10s para que el JS del ReportViewer se inicialice
  await new Promise(function(resolve) { setTimeout(resolve, 10000); });

  if (!controlId) {
    return { error: 'NO_CONTROL_ID: keepalive no llego en 10s' };
  }

  // Buscar URL de exportacion CSV en el DOM (scripts inline, onclick, etc.)
  var exportUrlStr = await page.evaluate(
    '(function(){' +
    '  var scripts = Array.from(document.querySelectorAll("script"));' +
    '  for(var i=0;i<scripts.length;i++){' +
    '    var txt = scripts[i].textContent || "";' +
    '    var m = txt.match(/Reserved\\.ReportViewerWebControl\\.axd[^"\'\\s]*Export[^"\'\\s]*/);' +
    '    if(m) return m[0];' +
    '  }' +
    '  var links = Array.from(document.querySelectorAll("a[id*=Export],a[title*=xport],a[href*=Export]"));' +
    '  for(var i=0;i<links.length;i++){' +
    '    var h = links[i].href || links[i].getAttribute("onclick") || "";' +
    '    if(h.includes("Export")) return h.slice(0,500);' +
    '  }' +
    '  var onclicks = Array.from(document.querySelectorAll("[onclick*=Export]"));' +
    '  if(onclicks.length>0) return onclicks[0].getAttribute("onclick")||"";' +
    '  return null;' +
    '})()'
  );

  var cookies = await page.cookies();
  return {
    phase1:    true,
    controlId: controlId,
    cookies:   cookies,
    exportUrl: exportUrlStr
  };
}
