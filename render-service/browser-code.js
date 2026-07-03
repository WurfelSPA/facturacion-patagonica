export default async function({ page }) {
  await page.goto('__NUBOX_URL__', { waitUntil: 'domcontentloaded', timeout: 25000 });

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('account')) {
    return { error: 'UTN_EXPIRED: ' + currentUrl };
  }

  // 2s para que los scripts Nubox se inicialicen
  await new Promise(r => setTimeout(r, 2000));

  // Cambiar a "Ano actual" — strings (no arrow fn: strict mode ES module)
  await page.evaluate(
    'var h=document.getElementById("hdnMesesMostrar");' +
    'if(h)h.value="1";' +
    'var s=document.getElementById("s-option");' +
    'if(s&&typeof s.onclick==="function")s.onclick.call(s);'
  );

  // Disparar postback — causa recarga completa de pagina
  await page.evaluate(
    'if(typeof __doPostBack==="function")' +
    '__doPostBack("ReportViewer1$ctl09$ReportControl$ctl00","");'
  );

  // 3s para que arranque la navegacion (el try/catch del poll maneja el resto)
  await new Promise(r => setTimeout(r, 3000));

  // Polling: 22x2s = 44s maximos. Los primeros ciclos pueden fallar
  // mientras la pagina recarga (execution context destroyed) — el catch lo maneja.
  // SSRS tarda ~25-35s en renderizar desde el postback.
  let ssrsReady = false;
  for (let i = 0; i < 22; i++) {
    try {
      const ok = await page.evaluate(
        'document.getElementById("hdnMesesMostrar") &&' +
        'document.getElementById("hdnMesesMostrar").value === "1" &&' +
        'document.querySelectorAll("td").length >= 60 &&' +
        '!Array.from(document.querySelectorAll("td")).some(function(td) {' +
        '  return td.innerText.trim() === "Loading...";' +
        '})'
      );
      if (ok) { ssrsReady = true; break; }
    } catch(e) { /* pagina aun navegando, ignorar */ }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!ssrsReady) return { error: 'SSRS_TIMEOUT: no cargo en 47s' };

  // Extraer datos (IIFE en string — sin funciones flecha)
  const jsonStr = await page.evaluate(
    '(function(){' +
    '  var allTds=Array.from(document.querySelectorAll("td"));' +
    '  var headerCell=null;' +
    '  for(var i=0;i<allTds.length;i++){' +
    '    if(/[A-Z][a-z]{2}-\\d{2}/.test(allTds[i].innerText||"")){' +
    '      headerCell=allTds[i];break;' +
    '    }' +
    '  }' +
    '  if(!headerCell)return JSON.stringify({error:"Sin header de meses",tdCount:allTds.length});' +
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
  if (data.error) return { error: 'EXTRACT_FAIL: ' + data.error };
  return data;
}
