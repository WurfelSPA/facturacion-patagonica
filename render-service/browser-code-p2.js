export default async function({ page }) {
  var cookies = __COOKIES_JSON__;
  for (var i = 0; i < cookies.length; i++) {
    await page.setCookie(cookies[i]);
  }

  await page.goto(__TARGET_URL__, { waitUntil: 'networkidle2', timeout: 30000 });

  var currentUrl = page.url();
  if (/login|account/i.test(currentUrl)) {
    return { error: 'SESSION_EXPIRED: ' + currentUrl };
  }

  // El reporte deberia estar cacheado en el servidor — poll hasta 50s
  var headerFound = false;
  var deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    var found = await page.evaluate(
      '(function(){var tds=document.querySelectorAll("td");for(var i=0;i<tds.length;i++){if(/[A-Z][a-z]{2}-\\d{2}/.test(tds[i].innerText||""))return true;}return false;})()'
    );
    if (found) { headerFound = true; break; }
  }

  if (!headerFound) {
    var dStr = await page.evaluate(
      '(function(){var tds=Array.from(document.querySelectorAll("td"));return JSON.stringify({tdCount:tds.length,sample:tds.slice(0,8).map(function(t){return t.innerText.trim().slice(0,40);});});  })()'
    );
    var d = JSON.parse(dStr);
    return { error: 'REPORT_NOT_CACHED', tdCount: d.tdCount, sample: d.sample };
  }

  var jsonStr = await page.evaluate(
    '(function(){' +
    '  var allTds=Array.from(document.querySelectorAll("td"));' +
    '  var headerCell=null;' +
    '  for(var i=0;i<allTds.length;i++){' +
    '    if(/[A-Z][a-z]{2}-\\d{2}/.test(allTds[i].innerText||"")){headerCell=allTds[i];break;}' +
    '  }' +
    '  var MESES=[];' +
    '  var mm=headerCell.innerText.matchAll(/([A-Z][a-z]{2}-\\d{2})/g);' +
    '  var match=mm.next();while(!match.done){MESES.push(match.value[1]);match=mm.next();}' +
    '  var rutPattern=/^\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dkK]$/;' +
    '  var results=[];var seen={};' +
    '  allTds.forEach(function(rutCell){' +
    '    var rut=(rutCell.innerText||"").trim();' +
    '    if(!rutPattern.test(rut)||seen[rut])return;' +
    '    seen[rut]=true;' +
    '    var row=rutCell.closest("tr");if(!row)return;' +
    '    var cells=Array.from(row.querySelectorAll("td")).map(function(c){return c.innerText.trim();});' +
    '    var rutIdx=cells.indexOf(rut);if(rutIdx<0)return;' +
    '    var nombre=cells[rutIdx+2]||cells[rutIdx+1]||"";' +
    '    var monthStart=rutIdx+4;' +
    '    var meses={};' +
    '    for(var j=0;j<MESES.length;j++){' +
    '      var val=(cells[monthStart+j]||"").trim();' +
    '      if(val){var n=parseInt(val.replace(/\\./g,""),10);if(!isNaN(n)&&n>0)meses[MESES[j]]=n*1000;}' +
    '    }' +
    '    var total=parseInt((cells[cells.length-1]||"").replace(/\\./g,""),10)*1000||0;' +
    '    results.push({rut:rut,nombre:nombre,meses:meses,total:total});' +
    '  });' +
    '  return JSON.stringify({clientes:results,MESES:MESES});' +
    '})()'
  );

  var data = JSON.parse(jsonStr);
  if (data.error) return { error: 'EXTRACT_FAIL: ' + data.error, details: data };
  return data;
}
