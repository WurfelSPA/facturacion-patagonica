export default async function({ page }) {
  var capturedRequests = [];

  // Interceptar todas las requests/responses para encontrar URLs SSRS
  page.on('request', function(req) {
    var u = req.url();
    if (/Report|Viewer|Export|aspx|reporte|resumen/i.test(u) && !/\.js$|\.css$|\.png$|\.gif$/.test(u)) {
      capturedRequests.push({ url: u, method: req.method() });
    }
  });

  // Cargar la página (solo DOMContentLoaded para ser rápidos)
  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 30000 });

  var currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Esperar 8s para capturar XHR iniciales de SSRS
  await new Promise(function(resolve) { setTimeout(resolve, 8000); });

  // Inspeccionar el DOM: iframes, formularios, inputs ocultos
  var domStr = await page.evaluate(
    '(function(){' +
    '  var iframes = Array.from(document.querySelectorAll("iframe")).map(function(f){return f.src||"(sin src)";});' +
    '  var hidden = Array.from(document.querySelectorAll("input[type=hidden]"))' +
    '    .filter(function(i){return /report|viewer|path|id/i.test(i.name||"");})' +
    '    .map(function(i){return {name:i.name,value:(i.value||"").slice(0,100)};});' +
    '  var forms = Array.from(document.querySelectorAll("form")).map(function(f){return {id:f.id,action:f.action};});' +
    '  var frameUrls = [];' +
    '  try { for(var i=0;i<window.frames.length;i++) { try { frameUrls.push(window.frames[i].location.href); } catch(e) { frameUrls.push("(cross-origin: "+e.message+")"); } } } catch(e) {}' +
    '  return JSON.stringify({iframes:iframes, hidden:hidden, forms:forms, frameUrls:frameUrls, pageUrl:location.href});' +
    '})()'
  );

  var dom = JSON.parse(domStr);

  // Verificar también los frames detectados por Puppeteer
  var puppeteerFrames = [];
  var frames = page.frames();
  for (var i = 0; i < frames.length; i++) {
    puppeteerFrames.push(frames[i].url());
  }

  return {
    diagnostic: true,
    capturedRequests: capturedRequests.slice(0, 30),
    puppeteerFrames: puppeteerFrames,
    dom: dom
  };
}
