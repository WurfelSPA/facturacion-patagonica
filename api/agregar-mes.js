/**
 * /api/agregar-mes
 *
 * GET ?secret=KEY        → agrega 5 columnas del mes siguiente a la Planilla Facturación
 * GET ?secret=KEY&dry=1  → muestra qué haría sin modificar nada (prueba segura)
 *
 * Ejecutado automáticamente el día 25 de cada mes vía Vercel Cron (vercel.json).
 * Detecta el último mes en la planilla, calcula el siguiente y agrega:
 *   mes-año | GC | Comentarios | Correo Enviado | Pagado
 *
 * Estrategia: manipulación directa del XML dentro del .xlsx (ZIP), preservando
 * 100 % de estilos, formato condicional y estructura — igual que planilla.js.
 */

import JSZip from "jszip";

export const config = { api: { bodyParser: false, maxDuration: 60 } };

const SPREADSHEET_ID = process.env.DRIVE_PLANILLA_ID || "1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml";
const SHEET_NAME     = "Flujo";

// ── JWT / SA (idéntico a planilla.js) ────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem   = privateKey.replace(/-----[^-]+-----/g,"").replace(/\s/g,"");
  const key   = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c=>c.charCodeAt(0)).buffer,
    { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]);
  const sig   = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64= btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${input}.${sigB64}`;
}
async function getAccessToken(sa) {
  const now = Math.floor(Date.now()/1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive",
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

// ── Drive (idéntico a planilla.js) ───────────────────────────────────────────
async function downloadFile(token) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive download ${r.status}: ${(await r.text()).slice(0,150)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function uploadFile(token, buf) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${SPREADSHEET_ID}?uploadType=media`,
    { method:"PATCH", headers:{
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": String(buf.length),
      }, body: buf });
  if (!r.ok) throw new Error(`Drive upload ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

// ── Helpers de columna ────────────────────────────────────────────────────────
function colToNum(col) {
  let n = 0;
  for (const c of col) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}
function numToCol(n) {
  let s = "";
  while (n > 0) { const r = (n-1) % 26; s = String.fromCharCode(65+r) + s; n = Math.floor((n-1)/26); }
  return s;
}
/** Serial de fecha Excel (días desde 30-dic-1899, con bug año bisiesto 1900) */
function excelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month-1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}
function escXml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Helpers XML ───────────────────────────────────────────────────────────────

/** Ruta de la hoja dentro del ZIP */
async function getSheetPath(zip) {
  const wb = await zip.file("xl/workbook.xml").async("string");
  let rId = null;
  for (const re of [
    new RegExp(`name="${SHEET_NAME}"[^>]+r:id="([^"]+)"`),
    new RegExp(`r:id="([^"]+)"[^>]+name="${SHEET_NAME}"`),
  ]) { const m = wb.match(re); if (m) { rId = m[1]; break; } }
  if (!rId) throw new Error(`Hoja "${SHEET_NAME}" no encontrada`);
  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rm = rels.match(new RegExp(`Id="${rId}"[^>]+Target="([^"]+)"`));
  if (!rm) throw new Error(`Relación ${rId} no encontrada`);
  let t = rm[1];
  if (t.startsWith("/")) t = t.slice(1);
  if (!t.startsWith("xl/")) t = `xl/${t}`;
  return t;
}

/** Extrae el XML completo de una celda dado su ref (ej: "HB3") dentro del contenido de una fila */
function extractCell(rowInner, ref) {
  const idx = rowInner.indexOf(`r="${ref}"`);
  if (idx === -1) return null;
  const cStart = rowInner.lastIndexOf("<c", idx);
  if (cStart === -1 || idx - cStart > 150) return null;
  const sc = rowInner.indexOf("/>", cStart);
  const fc = rowInner.indexOf("</c>", cStart);
  if (sc !== -1 && (fc === -1 || sc < fc)) return rowInner.slice(cStart, sc + 2);
  if (fc !== -1) return rowInner.slice(cStart, fc + 4);
  return null;
}

/** Extrae atributo s= (style index) del XML de una celda */
function cellStyle(cellXml) { const m = (cellXml||"").match(/\bs="(\d+)"/); return m ? m[1] : null; }

/** Extrae <v>...</v> del XML de una celda */
function cellValue(cellXml) { const m = (cellXml||"").match(/<v>([^<]*)<\/v>/); return m ? m[1] : null; }

/** Extrae <f>...</f> del XML de una celda */
function cellFormula(cellXml) { const m = (cellXml||"").match(/<f[^>]*>([^<]*)<\/f>/); return m ? m[1] : null; }

/** Inserta celdas antes de </row> para la fila indicada */
function insertInRow(xml, rowNum, cells) {
  const re = new RegExp(`(<row r="${rowNum}"(?:\\s[^>]*)?>)([\\s\\S]*?)(</row>)`);
  const m = xml.match(re);
  if (m) return xml.replace(re, m[1] + m[2] + cells + m[3]);
  // Fila no existe: crear nueva
  return xml.replace("</sheetData>", `<row r="${rowNum}">${cells}</row></sheetData>`);
}

// ── Lógica principal ──────────────────────────────────────────────────────────
const MES_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

async function addNextMonth(buffer, dryRun) {
  const zip = await JSZip.loadAsync(Buffer.from(buffer));
  const sheetPath = await getSheetPath(zip);
  let xml = await zip.file(sheetPath).async("string");

  // 1. Dimensión actual → última columna y última fila
  const dimM = xml.match(/<dimension ref="[^:]+:([A-Z]+)(\d+)"/);
  if (!dimM) throw new Error("Tag <dimension> no encontrado");
  const lastColLetter = dimM[1];          // "HF"
  const lastRow       = parseInt(dimM[2]); // 1067
  const lastColNum    = colToNum(lastColLetter); // 214

  // 2. Columnas del último mes (las 5 finales: HB-HF)
  const pMes  = numToCol(lastColNum - 4); // HB
  const pGc   = numToCol(lastColNum - 3); // HC
  const pCom  = numToCol(lastColNum - 2); // HD
  const pCorr = numToCol(lastColNum - 1); // HE
  const pPag  = numToCol(lastColNum);     // HF

  // 3. Nuevas columnas (HG-HK)
  const nMes  = numToCol(lastColNum + 1); // HG
  const nGc   = numToCol(lastColNum + 2); // HH
  const nCom  = numToCol(lastColNum + 3); // HI
  const nCorr = numToCol(lastColNum + 4); // HJ
  const nPag  = numToCol(lastColNum + 5); // HK

  // 4. Leer fila 3 para obtener fecha del mes anterior y estilos
  const r3M = xml.match(new RegExp(`<row r="3"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/row>`));
  if (!r3M) throw new Error("Fila 3 no encontrada");
  const r3 = r3M[1];

  // Verificar que no existan ya las columnas del mes siguiente
  if (r3.includes(`r="${nMes}3"`)) {
    const existSerial = parseFloat(cellValue(extractCell(r3, `${nMes}3`) || "") || "0");
    const existDate = new Date(Date.UTC(1899, 11, 30) + existSerial * 86400000);
    return { ok: false, alreadyExists: true,
      message: `Las columnas de ${MES_ES[existDate.getUTCMonth()]} ${existDate.getUTCFullYear()} ya existen.` };
  }

  // Serial del mes anterior → calcular mes siguiente
  const prevMesXml   = extractCell(r3, `${pMes}3`);
  const prevSerial   = parseFloat(cellValue(prevMesXml) || "0");
  if (!prevSerial) throw new Error(`No se pudo leer el serial de fecha de ${pMes}3`);

  const prevDate = new Date(Date.UTC(1899, 11, 30) + prevSerial * 86400000);
  const nextDate = new Date(Date.UTC(prevDate.getUTCFullYear(), prevDate.getUTCMonth() + 1, 1));
  const nextSerial   = excelSerial(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, 1);
  const nextMonthName= MES_ES[nextDate.getUTCMonth()];
  const nextYear     = nextDate.getUTCFullYear();

  // Estilos de encabezados (fila 3)
  const sMes  = cellStyle(prevMesXml);
  const sGc   = cellStyle(extractCell(r3, `${pGc}3`));
  const sCom  = cellStyle(extractCell(r3, `${pCom}3`));
  const sCorr = cellStyle(extractCell(r3, `${pCorr}3`));
  const sPag  = cellStyle(extractCell(r3, `${pPag}3`));

  // Estilos fila 4
  const r4M  = xml.match(new RegExp(`<row r="4"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/row>`));
  const r4   = r4M ? r4M[1] : "";
  const sMes4= cellStyle(extractCell(r4, `${pMes}4`));
  const sGc4 = cellStyle(extractCell(r4, `${pGc}4`));

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      prevMonth: { col: pMes, date: prevDate.toISOString().slice(0,10) },
      nextMonth: { name: nextMonthName, year: nextYear, date: nextDate.toISOString().slice(0,10), serial: nextSerial },
      newCols: [nMes, nGc, nCom, nCorr, nPag],
      styles: { sMes, sGc, sCom, sCorr, sPag, sMes4, sGc4 },
    };
  }

  // 5. Construir celdas para fila 3
  const a = (s) => s ? ` s="${s}"` : "";
  const row3Cells = [
    `<c r="${nMes}3"${a(sMes)}><v>${nextSerial}</v></c>`,
    `<c r="${nGc}3"${a(sGc)} t="inlineStr"><is><t>GC</t></is></c>`,
    `<c r="${nCom}3"${a(sCom)} t="inlineStr"><is><t>Comentarios</t></is></c>`,
    `<c r="${nCorr}3"${a(sCorr)} t="inlineStr"><is><t>Correo Enviado</t></is></c>`,
    `<c r="${nPag}3"${a(sPag)} t="inlineStr"><is><t>Pagado</t></is></c>`,
  ].join("");

  // 6. Celdas para fila 4
  const row4Cells = [
    `<c r="${nMes}4"${a(sMes4)} t="inlineStr"><is><t>U.F.</t></is></c>`,
    `<c r="${nGc}4"${a(sGc4)} t="inlineStr"><is><t>U.F.</t></is></c>`,
  ].join("");

  // 7. Insertar encabezados
  xml = insertInRow(xml, 3, row3Cells);
  xml = insertInRow(xml, 4, row4Cells);

  // 8. Procesar filas de datos (5 → lastRow)
  let rowsMod = 0, formulas = 0, values = 0;

  xml = xml.replace(
    new RegExp(`(<row r="(\\d+)"(?:\\s[^>]*)?>)([\\s\\S]*?)(</row>)`, "g"),
    (match, open, rowNum, inner, close) => {
      const n = parseInt(rowNum);
      if (n < 5) return match;

      let cells = "";

      // Copiar celda de UF: HBn → HGn
      const mesCellXml = extractCell(inner, `${pMes}${n}`);
      if (mesCellXml) {
        const v = cellValue(mesCellXml);
        if (v !== null && v !== "") {
          cells += `<c r="${nMes}${n}"${a(cellStyle(mesCellXml))}><v>${escXml(v)}</v></c>`;
          values++;
        }
      }

      // Copiar celda GC: HCn → HHn (fórmula adaptada o valor)
      const gcCellXml = extractCell(inner, `${pGc}${n}`);
      if (gcCellXml) {
        const formula = cellFormula(gcCellXml);
        const v       = cellValue(gcCellXml);
        const sAttr   = a(cellStyle(gcCellXml));
        if (formula) {
          // Adaptar referencias: HBn → HGn (con soporte para $HB$n)
          const newFormula = formula.replace(
            new RegExp(`(\\$?)${pMes}(\\$?\\d+)`, "g"),
            `$1${nMes}$2`
          );
          const cached = v ? `<v>${escXml(v)}</v>` : "";
          cells += `<c r="${nGc}${n}"${sAttr}><f>${escXml(newFormula)}</f>${cached}</c>`;
          formulas++;
        } else if (v !== null && v !== "") {
          cells += `<c r="${nGc}${n}"${sAttr}><v>${escXml(v)}</v></c>`;
          values++;
        }
      }

      if (!cells) return match;
      rowsMod++;
      return open + inner + cells + close;
    }
  );

  // 9. Actualizar <dimension>
  xml = xml.replace(
    /<dimension ref="[^"]+"/,
    `<dimension ref="A1:${nPag}${lastRow}"`
  );

  // 10. Recomprimir ZIP
  zip.file(sheetPath, xml);
  const newBuf = await zip.generateAsync({
    type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 },
  });

  return {
    ok: true,
    nextMonth: { name: nextMonthName, year: nextYear, date: nextDate.toISOString().slice(0,10) },
    newCols: [nMes, nGc, nCom, nCorr, nPag],
    stats: { rowsModified: rowsMod, formulasCopied: formulas, valuesCopied: values },
    buffer: newBuf,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "GET only" });

  // Autenticación: Bearer header (Vercel Cron) o ?secret= (prueba manual)
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    const query  = req.query.secret || "";
    if (bearer !== cronSecret && query !== cronSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const dryRun = req.query.dry === "1";

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });

  try {
    const sa     = JSON.parse(saJson);
    const token  = await getAccessToken(sa);
    const buffer = await downloadFile(token);
    const result = await addNextMonth(buffer, dryRun);

    if (!result.ok) return res.status(200).json(result);

    if (!dryRun && result.buffer) {
      await uploadFile(token, result.buffer);
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      message: dryRun
        ? `[DRY RUN] Se agregarían columnas para ${result.nextMonth.name} ${result.nextMonth.year}`
        : `✅ Columnas de ${result.nextMonth.name} ${result.nextMonth.year} agregadas correctamente`,
      nextMonth: result.nextMonth,
      newCols:   result.newCols,
      stats:     result.stats,
    });

  } catch (e) {
    console.error("[agregar-mes]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
