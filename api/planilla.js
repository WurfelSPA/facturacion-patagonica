/**
 * /api/planilla
 * GET              → descarga la planilla xlsx desde Google Drive (Service Account)
 * GET ?diag=1      → diagnóstico SA
 * GET ?addMonth=1  → agrega 5 columnas del mes siguiente (mes-año/GC/Comentarios/Correo Enviado/Pagado)
 * GET ?addMonth=1&dry=1 → dry-run: muestra qué haría sin modificar nada
 * POST             → escribe "Enviado" en columna HC sin tocar formato
 *                   Body: { sheetRow: number } | { sheetRows: number[] }
 *
 * Estrategia de escritura: abre el .xlsx como ZIP, modifica sólo el XML de la
 * celda HC (sin re-parsear ni re-generar el libro completo), y re-sube.
 * Así se preservan 100 % los estilos, colores y formatos originales.
 */

import JSZip from 'jszip';

export const config = { api: { bodyParser: true } };

const SPREADSHEET_ID = process.env.DRIVE_PLANILLA_ID || "1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml";
const SHEET_NAME     = "Flujo";
const HC_COL_DEFAULT = "HC";   // fallback estático (nunca debería usarse — el frontend siempre envía sentCol dinámico)

const FILL_FILE_ID = process.env.DRIVE_PLANILLA_FILL_ID;

async function downloadFillData(token) {
  if (!FILL_FILE_ID) return {};
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${FILL_FILE_ID}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return {};
  try { return await r.json(); } catch { return {}; }
}

async function uploadFillData(token, data) {
  if (!FILL_FILE_ID) throw new Error('DRIVE_PLANILLA_FILL_ID no configurado');
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${FILL_FILE_ID}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data, null, 2)
  });
  if (!r.ok) throw new Error(`Drive fill upload ${r.status}: ${(await r.text()).slice(0,200)}`);
}

// ── JWT / SA ──────────────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = privateKey.replace(/-----[^-]+-----/g,"").replace(/\s/g,"");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c=>c.charCodeAt(0)).buffer,
    { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${input}.${sigB64}`;
}
async function getAccessToken(sa, scope) {
  const now = Math.floor(Date.now()/1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope: scope || "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now+3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: " + JSON.stringify(d));
  return d.access_token;
}

// ── Drive ─────────────────────────────────────────────────────────────────────
async function downloadFile(token) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Drive download ${r.status}: ${(await r.text()).slice(0,200)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function uploadFile(token, buf) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${SPREADSHEET_ID}?uploadType=media`,
    { method:"PATCH", headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": String(buf.length),
      }, body: buf }
  );
  if (!r.ok) throw new Error(`Drive upload ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

// ── XML cell helpers ──────────────────────────────────────────────────────────
function escXml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/**
 * Devuelve la ruta dentro del ZIP para la hoja llamada SHEET_NAME.
 */
async function getSheetPath(zip) {
  const wb = await zip.file("xl/workbook.xml").async("string");
  // Busca r:id para la hoja — los atributos pueden venir en distinto orden
  let rId = null;
  for (const re of [
    new RegExp(`name="${SHEET_NAME}"[^>]+r:id="([^"]+)"`),
    new RegExp(`r:id="([^"]+)"[^>]+name="${SHEET_NAME}"`),
  ]) {
    const m = wb.match(re); if (m) { rId = m[1]; break; }
  }
  if (!rId) throw new Error(`Hoja "${SHEET_NAME}" no encontrada en workbook.xml`);

  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rm = rels.match(new RegExp(`Id="${rId}"[^>]+Target="([^"]+)"`));
  if (!rm) throw new Error(`Relación ${rId} no encontrada`);
  let t = rm[1];
  if (t.startsWith("/")) t = t.slice(1);          // /xl/worksheets/... → xl/worksheets/...
  if (!t.startsWith("xl/")) t = `xl/${t}`;         // worksheets/... → xl/worksheets/...
  return t;
}

/**
 * Modifica el XML de la hoja para escribir `value` en la celda HC{rowNum}.
 * Solo toca el nodo <c> concreto — el resto del XML queda idéntico.
 */
function patchCellXml(xml, rowNum, value, col) {
  const cellRef  = `${col}${rowNum}`;
  const newCell  = `<c r="${cellRef}" t="inlineStr"><is><t>${escXml(value)}</t></is></c>`;

  // ── 1. Reemplazar celda existente ─────────────────────────────────────────
  const refStr = `r="${cellRef}"`;
  const refIdx = xml.indexOf(refStr);
  if (refIdx !== -1) {
    // Localizar inicio del tag <c
    const cStart = xml.lastIndexOf("<c", refIdx);
    if (cStart !== -1 && refIdx - cStart < 120) {
      const gtIdx = xml.indexOf(">", cStart);
      if (gtIdx !== -1) {
        if (xml[gtIdx - 1] === "/") {
          // Celda vacía auto-cerrada:  <c r="HC5" ... />
          return xml.slice(0, cStart) + newCell + xml.slice(gtIdx + 1);
        } else {
          // Celda con contenido:  <c ...>...</c>
          const closeIdx = xml.indexOf("</c>", cStart);
          if (closeIdx !== -1)
            return xml.slice(0, cStart) + newCell + xml.slice(closeIdx + 4);
        }
      }
    }
  }

  // ── 2. Celda no existe — insertar en la fila existente ────────────────────
  for (const rowTag of [`<row r="${rowNum}" `, `<row r="${rowNum}">`]) {
    const rowIdx = xml.indexOf(rowTag);
    if (rowIdx !== -1) {
      const rowEnd = xml.indexOf("</row>", rowIdx);
      if (rowEnd !== -1)
        return xml.slice(0, rowEnd) + newCell + xml.slice(rowEnd);
    }
  }

  // ── 3. Fila no existe — insertar fila antes de </sheetData> ───────────────
  const sdEnd = xml.lastIndexOf("</sheetData>");
  if (sdEnd !== -1) {
    const newRow = `<row r="${rowNum}">${newCell}</row>`;
    return xml.slice(0, sdEnd) + newRow + xml.slice(sdEnd);
  }

  return xml; // no se pudo — devuelve sin cambio
}

/**
 * Abre el .xlsx como ZIP, modifica celdas HC y devuelve el ZIP corregido.
 * El resto de archivos del ZIP (estilos, imágenes, etc.) se preservan intactos.
 */
async function patchXlsx(buffer, rows, value, col) {
  col = col || HC_COL_DEFAULT;
  const zip = await JSZip.loadAsync(buffer);
  const sheetPath = await getSheetPath(zip);
  let sheetXml = await zip.file(sheetPath).async("string");

  for (const row of rows) {
    sheetXml = patchCellXml(sheetXml, row, value, col);
  }

  zip.file(sheetPath, sheetXml);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// ── Agregar mes siguiente ─────────────────────────────────────────────────────

function colToNum(col) { let n=0; for(const c of col) n=n*26+(c.charCodeAt(0)-64); return n; }
function numToCol(n)   { let s=""; while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);} return s; }
function excelSerial(y,m,d){ return Math.round((Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000); }

/**
 * Agrega a styles.xml:
 *   - un fill blanco sólido
 *   - una fuente negrita negra
 *   - dos xf: {blanco+negrita+negro} y {blanco+normal+negro}
 * Devuelve los índices de estilo resultantes.
 */
async function buildWhiteStyles(zip) {
  let sx = await zip.file("xl/styles.xml").async("string");

  // ── 1. Fill blanco sólido ────────────────────────────────────────────────
  const fillsM = sx.match(/<fills count="(\d+)">/);
  const fillN   = fillsM ? parseInt(fillsM[1]) : 2;
  const whiteFill = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>';
  sx = sx.replace('</fills>', whiteFill + '</fills>');
  if (fillsM) sx = sx.replace(`<fills count="${fillN}">`, `<fills count="${fillN+1}">`);
  const whiteFillId = fillN; // índice del nuevo fill

  // ── 2. Fuente negrita negra (basada en font[0]) ──────────────────────────
  const fontsM = sx.match(/<fonts count="(\d+)">/);
  const fontN   = fontsM ? parseInt(fontsM[1]) : 1;
  // Extraer font[0] y hacerle negrita (sin duplicar <b/> si ya existe)
  const font0M  = sx.match(/<fonts[^>]*>\s*(<font[\s\S]*?<\/font>)/);
  let boldFont;
  if (font0M) {
    boldFont = font0M[1].includes("<b/>") ? font0M[1] : font0M[1].replace("<font>","<font><b/>");
  } else {
    boldFont = '<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>';
  }
  sx = sx.replace('</fonts>', boldFont + '</fonts>');
  if (fontsM) sx = sx.replace(`<fonts count="${fontN}">`, `<fonts count="${fontN+1}">`);
  const boldFontId = fontN; // índice de la nueva fuente negrita

  // ── 3. Borde fino en todos los lados ────────────────────────────────────
  const bordersM  = sx.match(/<borders count="(\d+)">/);
  const borderN   = bordersM ? parseInt(bordersM[1]) : 1;
  const thinBorder = '<border>'
    + '<left style="thin"><color rgb="FF000000"/></left>'
    + '<right style="thin"><color rgb="FF000000"/></right>'
    + '<top style="thin"><color rgb="FF000000"/></top>'
    + '<bottom style="thin"><color rgb="FF000000"/></bottom>'
    + '<diagonal/>'
    + '</border>';
  sx = sx.replace('</borders>', thinBorder + '</borders>');
  if (bordersM) sx = sx.replace(`<borders count="${borderN}">`, `<borders count="${borderN+1}">`);
  const thinBorderId = borderN; // índice del nuevo borde fino

  // ── 4. Tres xf nuevos en cellXfs ────────────────────────────────────────
  const xfsM  = sx.match(/<cellXfs count="(\d+)">/);
  const xfN   = xfsM ? parseInt(xfsM[1]) : 1;

  const align    = `<alignment horizontal="center" vertical="center" wrapText="1"/>`;
  // xfBold   → encabezados col 1+2: blanco + negrita + centrado + borde
  // xfNormal → encabezados col 3-5: blanco + normal + centrado + borde
  // xfData   → celdas de datos rows 5+: blanco + normal + borde (sin alignment forzado)
  const xfBold   = `<xf numFmtId="0" fontId="${boldFontId}" fillId="${whiteFillId}" borderId="${thinBorderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`;
  const xfNormal = `<xf numFmtId="0" fontId="0" fillId="${whiteFillId}" borderId="${thinBorderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`;
  const xfData   = `<xf numFmtId="0" fontId="0" fillId="${whiteFillId}" borderId="${thinBorderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>`;
  sx = sx.replace('</cellXfs>', xfBold + xfNormal + xfData + '</cellXfs>');
  if (xfsM) sx = sx.replace(`<cellXfs count="${xfN}">`, `<cellXfs count="${xfN+3}">`);

  zip.file("xl/styles.xml", sx);
  return {
    boldIdx: xfN, normalIdx: xfN + 1, dataIdx: xfN + 2,
    debug: { whiteFillId, boldFontId, originalFillN: fillN, originalFontN: fontN, originalXfN: xfN,
             foundFills: !!fillsM, foundFonts: !!fontsM, foundCellXfs: !!xfsM,
             hasClosingFills: sx.includes("</fills>"),
             hasClosingFonts: sx.includes("</fonts>"),
             hasClosingCellXfs: sx.includes("</cellXfs>") }
  };
}

function extractCell(rowInner, ref) {
  const idx=rowInner.indexOf(`r="${ref}"`); if(idx===-1) return null;
  const cs=rowInner.lastIndexOf("<c",idx); if(cs===-1||idx-cs>150) return null;
  const sc=rowInner.indexOf("/>",cs), fc=rowInner.indexOf("</c>",cs);
  if(sc!==-1&&(fc===-1||sc<fc)) return rowInner.slice(cs,sc+2);
  if(fc!==-1) return rowInner.slice(cs,fc+4);
  return null;
}
function cStyle(x)   { const m=(x||"").match(/\bs="(\d+)"/);   return m?m[1]:null; }
function cValue(x)   { const m=(x||"").match(/<v>([^<]*)<\/v>/); return m?m[1]:null; }
function cFormula(x) { const m=(x||"").match(/<f[^>]*>([^<]*)<\/f>/); return m?m[1]:null; }

function insertInRow(xml, rowNum, cells) {
  const re=new RegExp(`(<row r="${rowNum}"(?:\\s[^>]*)?>)([\\s\\S]*?)(</row>)`);
  const m=xml.match(re);
  if(m) return xml.replace(re, m[1]+m[2]+cells+m[3]);
  return xml.replace("</sheetData>",`<row r="${rowNum}">${cells}</row></sheetData>`);
}

const MES_ES=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

async function addNextMonth(buffer, dryRun) {
  const zip=await JSZip.loadAsync(Buffer.from(buffer));
  const sheetPath=await getSheetPath(zip);
  let xml=await zip.file(sheetPath).async("string");

  // Obtener última columna y fila: desde <dimension> o escaneando celdas
  let lastCol=0, lastRow=0;
  const dimM=xml.match(/<dimension ref="[^:]+:([A-Z]+)(\d+)"/);
  if(dimM){ lastCol=colToNum(dimM[1]); lastRow=parseInt(dimM[2]); }
  else {
    // Escanear todos los r="XX999" para encontrar máximos
    for(const m of xml.matchAll(/\br="([A-Z]+)(\d+)"/g)){
      const c=colToNum(m[1]), r=parseInt(m[2]);
      if(c>lastCol) lastCol=c;
      if(r>lastRow) lastRow=r;
    }
  }
  if(!lastCol||!lastRow) throw new Error("No se pudo determinar el rango de la planilla");

  // Columnas del último mes (las 5 finales)
  const pMes=numToCol(lastCol-4), pGc=numToCol(lastCol-3), pCom=numToCol(lastCol-2),
        pCorr=numToCol(lastCol-1), pPag=numToCol(lastCol);
  // Nuevas columnas
  const nMes=numToCol(lastCol+1), nGc=numToCol(lastCol+2), nCom=numToCol(lastCol+3),
        nCorr=numToCol(lastCol+4), nPag=numToCol(lastCol+5);

  // Fila 3: fecha del mes anterior y estilos
  const r3M=xml.match(new RegExp(`<row r="3"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/row>`));
  if(!r3M) throw new Error("Fila 3 no encontrada");
  const r3=r3M[1];

  if(r3.includes(`r="${nMes}3"`)) {
    const s=parseFloat(cValue(extractCell(r3,`${nMes}3`))||"0");
    const d=new Date(Date.UTC(1899,11,30)+s*86400000);
    return {ok:false,alreadyExists:true,message:`Columnas de ${MES_ES[d.getUTCMonth()]} ${d.getUTCFullYear()} ya existen.`};
  }

  const prevXml=extractCell(r3,`${pMes}3`);
  const prevSerial=parseFloat(cValue(prevXml)||"0");
  if(!prevSerial) throw new Error(`No se pudo leer fecha de ${pMes}3`);

  const prevDate=new Date(Date.UTC(1899,11,30)+prevSerial*86400000);
  const nextDate=new Date(Date.UTC(prevDate.getUTCFullYear(),prevDate.getUTCMonth()+1,1));
  const nextSerial=excelSerial(nextDate.getUTCFullYear(),nextDate.getUTCMonth()+1,1);
  const nextName=MES_ES[nextDate.getUTCMonth()], nextYear=nextDate.getUTCFullYear();

  const a=s=>s?` s="${s}"`:"";
  // Estilo original del mes anterior (verde) — se mantiene para la celda de fecha
  const sM=cStyle(prevXml);

  if(dryRun) return {ok:true,dryRun:true,
    nextMonth:{name:nextName,year:nextYear,date:nextDate.toISOString().slice(0,10),serial:nextSerial},
    newCols:[nMes,nGc,nCom,nCorr,nPag]};

  // ── Crear estilos para celdas nuevas (blanco + negrita/normal + texto negro) ──
  const { boldIdx, normalIdx, dataIdx, debug: styleDebug } = await buildWhiteStyles(zip);
  // Re-leer el XML del sheet (el ZIP no cambió pero por si acaso)
  xml = await zip.file(sheetPath).async("string");

  // Fila 3:
  //   nMes3  → verde del mes anterior (sM)   + valor numérico de fecha
  //   nGc3   → blanco + negrita + negro
  //   nCom3, nCorr3, nPag3 → blanco + normal + negro
  xml=insertInRow(xml,3,[
    `<c r="${nMes}3"${a(sM)}><v>${nextSerial}</v></c>`,
    `<c r="${nGc}3" s="${boldIdx}" t="inlineStr"><is><t>GC</t></is></c>`,
    `<c r="${nCom}3" s="${boldIdx}" t="inlineStr"><is><t>Comentarios</t></is></c>`,
    `<c r="${nCorr}3" s="${boldIdx}" t="inlineStr"><is><t>Correo Enviado</t></is></c>`,
    `<c r="${nPag}3" s="${boldIdx}" t="inlineStr"><is><t>Pagado</t></is></c>`,
  ].join(""));
  // Fila 4: ambas U.F. con negrita+blanco (las 2 primeras columnas)
  xml=insertInRow(xml,4,[
    `<c r="${nMes}4" s="${boldIdx}" t="inlineStr"><is><t>U.F.</t></is></c>`,
    `<c r="${nGc}4" s="${boldIdx}" t="inlineStr"><is><t>U.F.</t></is></c>`,
  ].join(""));

  // Filas de datos
  let rowsMod=0, fCount=0, vCount=0;
  xml=xml.replace(
    new RegExp(`(<row r="(\\d+)"(?:\\s[^>]*)?>)([\\s\\S]*?)(</row>)`,"g"),
    (match,open,rn,inner,close)=>{
      const n=parseInt(rn); if(n<5) return match;
      let cells="";
      const mXml=extractCell(inner,`${pMes}${n}`);
      if(mXml){const v=cValue(mXml);if(v){cells+=`<c r="${nMes}${n}" s="${dataIdx}"><v>${escXml(v)}</v></c>`;vCount++;}}
      const gXml=extractCell(inner,`${pGc}${n}`);
      if(gXml){
        const f=cFormula(gXml), v=cValue(gXml);
        if(f){
          const nf=f.replace(new RegExp(`(\\$?)${pMes}(\\$?\\d+)`,"g"),`$1${nMes}$2`);
          cells+=`<c r="${nGc}${n}" s="${dataIdx}"><f>${escXml(nf)}</f>${v?`<v>${escXml(v)}</v>`:""}</c>`;fCount++;
        } else if(v){cells+=`<c r="${nGc}${n}" s="${dataIdx}"><v>${escXml(v)}</v></c>`;vCount++;}
      }
      if(!cells) return match;
      rowsMod++; return open+inner+cells+close;
    }
  );

  xml=xml.replace(/<dimension ref="[^"]+"/,`<dimension ref="A1:${nPag}${lastRow}"`);
  zip.file(sheetPath,xml);
  const buf=await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}});
  return {ok:true,nextMonth:{name:nextName,year:nextYear},newCols:[nMes,nGc,nCom,nCorr,nPag],
    stats:{rowsModified:rowsMod,formulasCopied:fCount,valuesCopied:vCount},
    styleIndices:{boldIdx,normalIdx,dataIdx,...styleDebug},buffer:buf};
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
  const sa = JSON.parse(saJson);

  // ── GET ?diag ─────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.query.diag === "1")
    return res.status(200).json({ client_email: sa.client_email, project_id: sa.project_id });

  // ── GET ?stylesdiag=1 ────────────────────────────────────────────────────
  // Diagnóstico: muestra estructura de xl/styles.xml sin modificar nada
  if (req.method === "GET" && req.query.stylesdiag === "1") {
    try {
      const token = await getAccessToken(sa);
      const buf   = await downloadFile(token);
      const zip   = await JSZip.loadAsync(Buffer.from(buf));
      const sf    = zip.file("xl/styles.xml");
      if (!sf) return res.status(200).json({ error: "styles.xml no encontrado en el ZIP" });
      const sx = await sf.async("string");
      // Contar elementos clave
      const fillsM    = sx.match(/<fills[^>]*count="(\d+)"/);
      const fontsM    = sx.match(/<fonts[^>]*count="(\d+)"/);
      const cellXfsM  = sx.match(/<cellXfs[^>]*count="(\d+)"/);
      const hasFills  = sx.includes("</fills>");
      const hasFonts  = sx.includes("</fonts>");
      const hasCellXfs= sx.includes("</cellXfs>");
      // Últimas 3 entradas de cellXfs
      const allXf = [...sx.matchAll(/<xf [^>]+\/>/g)].map(m=>m[0]);
      const lastXfs = allXf.slice(-3);
      // Primeros 200 chars de styles.xml para ver el namespace
      const header = sx.slice(0, 300);
      // También verificar estilos de celdas clave en el sheet
      const sheetPath2 = await getSheetPath(zip);
      const sheetXml2  = await zip.file(sheetPath2).async("string");
      const checkRefs  = ["HB3","HC3","HD3","HE3","HF3","HG3","HH3","HI3","HJ3","HK3","HG4","HH4"];
      const cellStyles = {};
      for (const ref of checkRefs) {
        const rowN = parseInt(ref.match(/\d+/)[0]);
        const rowM = sheetXml2.match(new RegExp(`<row r="${rowN}"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/row>`));
        if (rowM) {
          const cellRx = new RegExp(`<c r="${ref}"([^>]*)>`);
          const cm = rowM[1].match(cellRx);
          cellStyles[ref] = cm ? (cm[1].match(/s="(\d+)"/) || [,null])[1] : "NOT_FOUND";
        } else {
          cellStyles[ref] = "ROW_NOT_FOUND";
        }
      }
      return res.status(200).json({
        fillsCount: fillsM ? fillsM[1] : null,
        fontsCount: fontsM ? fontsM[1] : null,
        cellXfsCount: cellXfsM ? cellXfsM[1] : null,
        hasClosingFills: hasFills,
        hasClosingFonts: hasFonts,
        hasClosingCellXfs: hasCellXfs,
        lastXfs,
        header,
        cellStyles,
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ?addMonth=1 ───────────────────────────────────────────────────────
  if (req.method === "GET" && req.query.addMonth === "1") {
    const cronSecret = process.env.CRON_SECRET || "";
    if (cronSecret) {
      const bearer = (req.headers.authorization || "").replace("Bearer ", "");
      const query  = req.query.secret || "";
      if (bearer !== cronSecret && query !== cronSecret)
        return res.status(401).json({ error: "Unauthorized" });
    }
    const dryRun = req.query.dry === "1";
    try {
      const token  = await getAccessToken(sa);
      const buf    = await downloadFile(token);
      const result = await addNextMonth(buf, dryRun);
      if (!result.ok) return res.status(200).json(result);
      if (!dryRun && result.buffer) await uploadFile(token, result.buffer);
      return res.status(200).json({
        ok: true, dryRun,
        message: dryRun
          ? `[DRY RUN] Se agregarían columnas para ${result.nextMonth.name} ${result.nextMonth.year}`
          : `✅ Columnas de ${result.nextMonth.name} ${result.nextMonth.year} agregadas`,
        nextMonth:    result.nextMonth,
        newCols:      result.newCols,
        stats:        result.stats,
        styleIndices: result.styleIndices,
      });
    } catch(e) {
      console.error("[addMonth]", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────

  // GET ?action=load-fill
  if (req.method === "GET" && req.query.action === "load-fill") {
    const { periodo } = req.query;
    if (!periodo) return res.status(400).json({ error: "Se requiere periodo" });
    try {
      const token = await getAccessToken(sa);
      const allData = await downloadFillData(token);
      return res.status(200).json({ values: allData[periodo]?.values || {} });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST ?action=save-fill
  if (req.method === "POST" && req.query.action === "save-fill") {
    const { periodo, values } = req.body || {};
    if (!periodo || !values) return res.status(400).json({ error: "Se requiere periodo y values" });
    try {
      const token = await getAccessToken(sa);
      const allData = await downloadFillData(token);
      allData[periodo] = { savedAt: new Date().toISOString(), values };
      await uploadFillData(token, allData);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};
    let rows = [];
    if (Array.isArray(body.sheetRows))            rows = body.sheetRows.filter(n=>typeof n==="number"&&n>0);
    else if (typeof body.sheetRow==="number"&&body.sheetRow>0) rows = [body.sheetRow];
    if (!rows.length) return res.status(400).json({ error: "Se requiere sheetRow o sheetRows" });
    const sentCol = (typeof body.sentCol==="string"&&/^[A-Z]{1,3}$/.test(body.sentCol))
      ? body.sentCol : HC_COL_DEFAULT;
    const writeValue = typeof body.value==="string" ? body.value : "Enviado";

    try {
      const token  = await getAccessToken(sa);
      const buf    = await downloadFile(token);
      const patched = await patchXlsx(buf, rows, writeValue, sentCol);
      await uploadFile(token, patched);
      return res.status(200).json({ ok: true, updated: rows.length, rows, sentCol });
    } catch (e) {
      console.error("planilla POST:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET: descargar planilla ───────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = await getAccessToken(sa);
    const buf   = await downloadFile(token);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Content-Length", String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
