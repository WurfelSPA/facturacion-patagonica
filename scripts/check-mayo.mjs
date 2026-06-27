/**
 * check-mayo.mjs
 * 1. Descarga la planilla XLSX desde Vercel y lista las filas de Mayo 2026
 * 2. Descarga el ZIP de Mayo y lista los PDFs (para ver el patrón de nombres)
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const BASE = 'https://facturacion-patagonica.vercel.app';

// ── Facturas enviadas (extraídas del listado de Outlook) ──────────────────────
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

function colIndexToLetter(idx) {
  let r = '', n = idx + 1;
  while (n > 0) { const rem = (n-1)%26; r = String.fromCharCode(65+rem)+r; n = Math.floor((n-1)/26); }
  return r;
}

const MES_NUM = { Enero:1,Febrero:2,Marzo:3,Abril:4,Mayo:5,Junio:6,Julio:7,Agosto:8,Septiembre:9,Octubre:10,Noviembre:11,Diciembre:12 };

function esTargetMes(val, anio, mesNum) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'number' && val > 40000 && val < 60000) {
    const d = new Date(new Date(Date.UTC(1899,11,30)).getTime() + Math.round(val)*86400000);
    return d.getUTCFullYear() === anio && (d.getUTCMonth()+1) === mesNum;
  }
  if (typeof val === 'string') {
    try { const d = new Date(val); if (!isNaN(d)) return d.getFullYear()===anio&&(d.getMonth()+1)===mesNum; } catch(e){}
  }
  return false;
}

// ── 1. Descargar planilla ─────────────────────────────────────────────────────
console.log('\n=== PLANILLA ===');
const pr = await fetch(`${BASE}/api/planilla`);
if (!pr.ok) throw new Error(`Planilla HTTP ${pr.status}: ${await pr.text()}`);
const xlsxBuf = Buffer.from(await pr.arrayBuffer());
console.log(`Descargada: ${xlsxBuf.length} bytes`);

const wb = XLSX.read(xlsxBuf, { type:'buffer', raw:true });
const ws = wb.Sheets['Flujo'];
if (!ws) throw new Error('Hoja Flujo no encontrada');
const dataRaw = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:true });

const anio = 2026, mesNum = MES_NUM['Mayo'];
const fila3 = dataRaw[2] || [];
let colGS=-1, colGT=-1, colEnviado=-1, colPagado=-1;
for (let i = 64; i < fila3.length; i++) {
  if (esTargetMes(fila3[i], anio, mesNum)) { colGS=i; colGT=i+1; colEnviado=i+3; colPagado=i+4; break; }
}
if (colGS === -1) throw new Error('Columna de Mayo 2026 no encontrada en la planilla');
console.log(`Columnas Mayo 2026 → GS=${colIndexToLetter(colGS)} GT=${colIndexToLetter(colGT)} Enviado=${colIndexToLetter(colEnviado)} Pagado=${colIndexToLetter(colPagado)}`);

const excl = ['','VACANTE','Nombre Cliente','Areas Comunes Edificio','Areas comunes Edificio (Subterraneos)','Area Comun'];
const filasMayo = [];
for (let i = 4; i < dataRaw.length; i++) {
  const row = dataRaw[i]; if (!row) continue;
  const cliente = row[11]; if (!cliente || excl.includes(String(cliente).trim())) continue;
  const ufGS = row[colGS], ufGT = row[colGT];
  if ((typeof ufGS === 'number' && ufGS > 0) || (typeof ufGT === 'number' && ufGT > 0 && ufGT <= 999999)) {
    const yaEnviado = row[colEnviado] && String(row[colEnviado]).trim().toLowerCase() === 'enviado';
    filasMayo.push({ sheetRow: i+1, cliente: String(cliente).trim(), ufArr: ufGS||0, ufAdm: ufGT||0, yaEnviado });
  }
}
console.log(`\nFilas de Mayo 2026 en la planilla: ${filasMayo.length}`);
filasMayo.forEach(f => console.log(`  Fila ${f.sheetRow}: ${f.cliente}${f.yaEnviado?' [YA ENVIADO]':''}`));

// ── 2. Descargar ZIP de Mayo ──────────────────────────────────────────────────
console.log('\n=== ZIP MAYO 2026 ===');
const zr = await fetch(`${BASE}/api/zip?periodo=Mayo+2026`);
console.log(`Status: ${zr.status}  Content-Type: ${zr.headers.get('content-type')}`);
if (zr.ok) {
  const zbuf = Buffer.from(await zr.arrayBuffer());
  console.log(`Tamaño: ${zbuf.length} bytes`);
  const ct = zr.headers.get('content-type') || '';
  if (ct.includes('zip') || ct.includes('octet-stream')) {
    const zip = await JSZip.loadAsync(zbuf);
    const files = Object.keys(zip.files).filter(f => !zip.files[f].dir).sort();
    console.log(`\n${files.length} PDFs en el ZIP:`);
    files.forEach(f => {
      const enLista = [...ENVIADAS].some(inv => f.includes(inv));
      console.log(`  ${enLista ? '✓' : '?'} ${f}`);
    });
  } else {
    console.log('(respuesta no es ZIP — posiblemente PDF maestro)');
  }
}

console.log(`\nTotal facturas únicas en lista de correos: ${ENVIADAS.size}`);
