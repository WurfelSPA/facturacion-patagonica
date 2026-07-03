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

  // Esperar 8s para que el JS del ReportViewer envie el keepalive con ControlID
  await new Promise(function(resolve) { setTimeout(resolve, 8000); });

  if (!controlId) {
    return { error: 'NO_CONTROL_ID: keepalive no llego en 8s' };
  }

  var cookies = await page.cookies();
  return { phase1: true, controlId: controlId, cookies: cookies };
}
