export default async function({ page }) {
  var controlId = null;

  page.on('request', function(req) {
    var url = req.url();
    var m = url.match(/ControlID=([a-f0-9]{32})/i);
    if (m && !controlId) controlId = m[1];
  });

  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 20000 });

  var currentUrl = page.url();
  if (/login|account/i.test(currentUrl)) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Poll hasta 90s para que el reporte aparezca en el DOM (SSRS tarda 46-103s)
  var reportFound = false;
  var lastTdCount = 0;
  var deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise(function(resolve) { setTimeout(resolve, 3000); });
    var checkStr = await page.evaluate(
      '(function(){' +
      '  var tds=document.querySelectorAll("td");' +
      '  var hasHeader=false;' +
      '  for(var i=0;i<tds.length;i++){if(/[A-Za-z]{3}-\\d{2}/.test(tds[i].innerText||"")){hasHeader=true;break;}}' +
      '  return JSON.stringify({h:hasHeader,n:tds.length});' +
      '})()'
    );
    var chk = JSON.parse(checkStr);
    lastTdCount = chk.n;
    if (chk.h) { reportFound = true; break; }
  }

  if (!reportFound) {
    return { error: 'TIMEOUT_90S: reporte no aparecio en 90s', controlId: controlId, lastTdCount: lastTdCount };
  }

  var jsonStr = await page.evaluate(
    '(function(){' +
    '  var allTds=Array.from(document.querySelectorAll("td"));' +
    '  var headerCell=null;' +
    '  for(var i=0;i<allTds.length;i++){' +
    '    if(/[A-Za-z]{3}-\\d{2}/.test(allTds[i].innerText||"")){headerCell=allTds[i];break;}' +
    '  }' +
    '  if(!headerCell)return JSON.stringify({error:"no header cell"});' +
    '  var MESES=[];' +
    '  var txt=headerCell.innerText||"";' +
    '  var re=/([A-Za-z]{3}-\\d{2})/g;var mm;' +
    '  while((mm=re.exec(txt))!==null){MESES.push(mm[1]);}' +
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
  if (data.error) return { error: 'EXTRACT_FAIL: ' + data.error };
  return data;
}
