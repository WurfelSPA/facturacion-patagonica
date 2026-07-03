export default async function({ page }) {
  // networkidle2: espera a que SSRS cargue todos sus XHR (vista "Ultimos 12 meses")
  // No necesitamos el postback — networkidle2 garantiza que los datos estan en el DOM
  await page.goto('__NUBOX_URL__', { waitUntil: 'networkidle2', timeout: 55000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // Extraer datos directamente del DOM ya renderizado
  const jsonStr = await page.evaluate(
    '(function(){' +
    '  var allTds=Array.from(document.querySelectorAll("td"));' +
    '  if(allTds.length<20)return JSON.stringify({error:"SSRS_NO_DATA",tds:allTds.length});' +
    '  var headerCell=null;' +
    '  for(var i=0;i<allTds.length;i++){' +
    '    if(/[A-Z][a-z]{2}-\\d{2}/.test(allTds[i].innerText||"")){' +
    '      headerCell=allTds[i];break;' +
    '    }' +
    '  }' +
    '  if(!headerCell){' +
    '    var sample=allTds.slice(0,8).map(function(t){return t.innerText.trim().slice(0,30);});' +
    '    return JSON.stringify({error:"Sin header de meses",tdCount:allTds.length,sample:sample});' +
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
    '      if(val){' +
    '        var n=parseInt(val.replace(/\\./g,""),10);' +
    '        if(!isNaN(n)&&n>0)meses[MESES[j]]=n*1000;' +
    '      }' +
    '    }' +
    '    var total=parseInt((cells[cells.length-1]||"").replace(/\\./g,""),10)*1000||0;' +
    '    results.push({rut:rut,nombre:nombre,meses:meses,total:total});' +
    '  });' +
    '  return JSON.stringify({clientes:results,MESES:MESES});' +
    '})()'
  );

  const data = JSON.parse(jsonStr);
  if (data.error) return { error: 'EXTRACT_FAIL: ' + data.error, details: data };
  return data;
}
