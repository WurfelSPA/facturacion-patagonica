/**
 * mark-mayo-enviado.mjs
 * Cruza las facturas enviadas por correo con las filas de Mayo 2026 en la planilla
 * y escribe "Enviado" en la columna GZ para cada fila que corresponda.
 *
 * Lógica de matching:
 *   1. Parsea la planilla XLSX → obtiene {sheetRow, sitio, cliente} por cada fila de Mayo
 *   2. Parsea el ZIP de Mayo → extrae {sitio (carpeta), invoiceNum, clienteKeyword} por PDF
 *   3. Cruza por sitio + similaridad de nombre de cliente
 *   4. Una fila se marca si AL MENOS UNA de sus facturas está en la lista de enviados
 *   5. Llama a POST /api/planilla con todos los sheetRows a marcar
 */

import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const BASE = 'https://facturacion-patagonica.vercel.app';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Facturas enviadas (únicas, del listado de Outlook) ────────────────────────
const ENVIADAS = new Set([
  'F-14544','F-14548','F-14549','F-14551','F-14552','F-14554','F-14555',
  'F-14556','F-14558','F-14559','F-14561','F-14562','F-14563','F-14564',
  'F-14565','F-14567','F-14569','F-14572','F-14573','F-14574','F-14576',
  'F-14581','F-14583','F-14584','F-14586','F-14589','F-14590','F-14591',
  'F-14592','F-14593','F-14595','F-14596','F-14599','F-14601','F-14603',
  'F-14604','F-14607','F-14608','F-14609','F-14610','F-14612','F-14614',
  'F-14615','F-14616','F-14617','F-14618','F-14623','F-14624','F-14625',
  'F-14626','F-14628','F-14629','F-14631','F-14632','F-14633','F-14634',
  'F-14635','F-14638','F-14640','F-14641','F-14642','F-14643','F-14644',
  'F-14645','F-14648','F-14649','F-14650','F-14651','F-14652','F-14654',
  'F-14655','F-14658','F-14659',
  'FEE-36','FEE-38','FEE-39','FEE-40',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function colIndexToLetter(idx) {
  let r='',n=idx+1;
  while(n>0){const rem=(n-1)%26;r=String.fromCharCode(65+rem)+r;n=Math.floor((n-1)/26);}
  return r;
}
const MES_NUM={Enero:1,Febrero:2,Marzo:3,Abril:4,Mayo:5,Junio:6,Julio:7,Agosto:8,Septiembre:9,Octubre:10,Noviembre:11,Diciembre:12};
function esTargetMes(val,anio,mesNum){
  if(val===null||val===undefined)return false;
  if(typeof val==='number'&&val>40000&&val<60000){
    const d=new Date(new Date(Date.UTC(1899,11,30)).getTime()+Math.round(val)*86400000);
    return d.getUTCFullYear()===anio&&(d.getUTCMonth()+1)===mesNum;
  }
  if(typeof val==='string'){try{const d=new Date(val);if(!isNaN(d))return d.getFullYear()===anio&&(d.getMonth()+1)===mesNum;}catch(e){}}
  return false;
}

// Normaliza nombre: minúsculas, sin tildes, sin puntuación → palabras clave
function normName(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ').trim();
}
const STOP=['de','del','la','el','los','las','y','en','s','a','spa','sa','sas','ltda','limitada','chile','sociedad','comercial','industria','servicios','corp','corporation','agencia'];
function keyWords(s){return normName(s).split(' ').filter(w=>w.length>2&&!STOP.includes(w));}

// Normaliza código de sitio del ZIP (carpeta) → código de planilla
const SITIO_NORM={'4A':'4-A','5A':'5-A','A1':'A-1','A2':'A-2','B':'B','D2':'D-2','D3':'D-3','J':'J'};

// Porcentaje de palabras de a que aparecen en b
function matchScore(zipClient, planClient){
  const zipW=keyWords(zipClient);
  const planN=normName(planClient);
  if(!zipW.length)return 0;
  const hits=zipW.filter(w=>planN.includes(w)).length;
  return hits/zipW.length;
}

// ── 1. Descargar y parsear planilla ──────────────────────────────────────────
console.log('Descargando planilla...');
const pr=await fetch(`${BASE}/api/planilla`);
if(!pr.ok)throw new Error(`Planilla HTTP ${pr.status}`);
const xlsxBuf=Buffer.from(await pr.arrayBuffer());

const wb=XLSX.read(xlsxBuf,{type:'buffer',raw:true});
const ws=wb.Sheets['Flujo'];
if(!ws)throw new Error('Hoja Flujo no encontrada');
const dataRaw=XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});

const anio=2026,mesNum=MES_NUM['Mayo'];
const fila3=dataRaw[2]||[];
let colGS=-1,colGT=-1,colEnviado=-1;
for(let i=64;i<fila3.length;i++){
  if(esTargetMes(fila3[i],anio,mesNum)){colGS=i;colGT=i+1;colEnviado=i+3;break;}
}
if(colGS===-1)throw new Error('Columna Mayo 2026 no encontrada');
const sentColLetter=colIndexToLetter(colEnviado);
console.log(`Columna Enviado Mayo: ${sentColLetter} (idx ${colEnviado})\n`);

const EXCL=['','VACANTE','Nombre Cliente','Areas Comunes Edificio','Areas comunes Edificio (Subterraneos)','Area Comun'];
const planillaRows=[];
for(let i=4;i<dataRaw.length;i++){
  const row=dataRaw[i];if(!row)continue;
  const cliente=row[11];if(!cliente||EXCL.includes(String(cliente).trim()))continue;
  const ufGS=row[colGS],ufGT=row[colGT];
  if((typeof ufGS==='number'&&ufGS>0)||(typeof ufGT==='number'&&ufGT>0&&ufGT<=999999)){
    const sitioRaw=row[7]?String(row[7]).trim():'';
    const yaEnviado=row[colEnviado]&&String(row[colEnviado]).trim().toLowerCase()==='enviado';
    planillaRows.push({sheetRow:i+1,sitio:sitioRaw,cliente:String(cliente).trim(),ufArr:ufGS||0,ufAdm:ufGT||0,yaEnviado});
  }
}
console.log(`Filas Mayo en planilla: ${planillaRows.length}`);

// ── 2. Descargar ZIP y parsear nombres de PDFs ────────────────────────────────
console.log('Descargando ZIP Mayo 2026...');
const zr=await fetch(`${BASE}/api/zip?periodo=Mayo+2026`);
if(!zr.ok)throw new Error(`ZIP HTTP ${zr.status}`);
const zbuf=Buffer.from(await zr.arrayBuffer());
const zip=await JSZip.loadAsync(zbuf);

// Extrae: {invoiceNum, sitio (código plano), clienteKeyword, path}
const zipPDFs=[];
for(const path of Object.keys(zip.files)){
  if(zip.files[path].dir||!path.endsWith('.pdf'))continue;
  const parts=path.split('/'); // ['05-2026','4A','F-14548 Congo Films.pdf']
  if(parts.length<3)continue;
  const sitioRaw=parts[1]; // '4A','5A','A2',etc.
  const filename=parts[parts.length-1].replace(/\.pdf$/i,'');
  // invoice puede ser "F-14548" o "FEE-36" o "F-14668 + F-14669"
  const m=filename.match(/^((?:F-\d+|FEE-\d+)(?:\s*\+\s*(?:F-\d+|FEE-\d+))*)\s+(.*)/);
  if(!m)continue;
  const invoicePart=m[1];
  const clienteKeyword=m[2];
  // Puede ser multi-invoice (e.g. "F-14668 + F-14669")
  const invoices=invoicePart.split(/\s*\+\s*/).map(s=>s.trim());
  const enviado=invoices.some(inv=>ENVIADAS.has(inv));
  zipPDFs.push({path,sitioRaw,sitio:SITIO_NORM[sitioRaw]||sitioRaw,invoices,clienteKeyword,enviado});
}
const enviados=zipPDFs.filter(p=>p.enviado);
console.log(`PDFs en ZIP: ${zipPDFs.length}  |  Marcados como enviados: ${enviados.length}\n`);

// ── 3. Matching ZIP → planilla ────────────────────────────────────────────────
// Para cada PDF enviado, encontrar la fila de planilla que corresponde (sitio + nombre)
const rowsToMark=new Map(); // sheetRow → {cliente, sitio, invoices[]}

for(const pdf of enviados){
  // Candidatos: filas con el mismo sitio
  const candidates=planillaRows.filter(r=>r.sitio===pdf.sitio||r.sitio.replace('-','')===pdf.sitioRaw);
  if(!candidates.length){
    console.warn(`⚠ Sin filas en planilla para sitio ${pdf.sitio}: ${pdf.path}`);
    continue;
  }
  // Mejor match por score de palabras clave
  let best=null,bestScore=0;
  for(const c of candidates){
    const sc=matchScore(pdf.clienteKeyword,c.cliente);
    if(sc>bestScore){bestScore=sc;best=c;}
  }
  if(!best||bestScore<0.3){
    console.warn(`⚠ Sin match (score ${bestScore.toFixed(2)}) para "${pdf.clienteKeyword}" sitio ${pdf.sitio}`);
    continue;
  }
  if(!rowsToMark.has(best.sheetRow)){
    rowsToMark.set(best.sheetRow,{sheetRow:best.sheetRow,cliente:best.cliente,sitio:best.sitio,invoices:[],yaEnviado:best.yaEnviado});
  }
  rowsToMark.get(best.sheetRow).invoices.push(...pdf.invoices);
}

// ── 4. Mostrar resumen ────────────────────────────────────────────────────────
const sorted=[...rowsToMark.values()].sort((a,b)=>a.sheetRow-b.sheetRow);
const yaEnviados=sorted.filter(r=>r.yaEnviado);
const nuevos=sorted.filter(r=>!r.yaEnviado);

console.log(`\n${'─'.repeat(70)}`);
console.log(`FILAS A MARCAR: ${sorted.length}  (${yaEnviados.length} ya marcadas, ${nuevos.length} nuevas)`);
console.log('─'.repeat(70));
for(const r of sorted){
  const tag=r.yaEnviado?' [ya marcada]':'';
  console.log(`  Fila ${String(r.sheetRow).padEnd(4)} ${r.sitio.padEnd(5)} ${r.cliente.substring(0,40).padEnd(40)} ${r.invoices.join(', ')}${tag}`);
}

// Filas en planilla que NO tienen match (posiblemente no se enviaron)
const noMatch=planillaRows.filter(r=>!rowsToMark.has(r.sheetRow));
if(noMatch.length){
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`FILAS SIN ENVÍO DETECTADO (${noMatch.length}):`);
  for(const r of noMatch){
    console.log(`  Fila ${String(r.sheetRow).padEnd(4)} ${r.sitio.padEnd(5)} ${r.cliente}${r.yaEnviado?' [ya marcada]':''}`);
  }
}

// ── 5. Marcar en planilla (sólo las no marcadas) ──────────────────────────────
const sheetRowsNuevos=nuevos.map(r=>r.sheetRow);
if(!sheetRowsNuevos.length){
  console.log('\n✅ Todas las filas ya estaban marcadas. Nada que hacer.');
  process.exit(0);
}

if(DRY_RUN){
  console.log(`\n[DRY RUN] Se marcarían ${sheetRowsNuevos.length} filas: ${sheetRowsNuevos.join(', ')}`);
  process.exit(0);
}

console.log(`\nMarcando ${sheetRowsNuevos.length} filas como "Enviado" en columna ${sentColLetter}...`);
const markResp=await fetch(`${BASE}/api/planilla`,{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({sheetRows:sheetRowsNuevos,sentCol:sentColLetter,value:'Enviado'}),
});
const markBody=await markResp.json().catch(()=>({}));
if(!markResp.ok){
  console.error('❌ Error al marcar:', markBody);
  process.exit(1);
}
console.log(`✅ Marcadas ${markBody.updated} filas en columna ${sentColLetter}`);
console.log('   Filas:', sheetRowsNuevos.join(', '));
