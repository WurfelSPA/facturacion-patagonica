/**
 * /api/planilla
 * GET        → descarga la planilla xlsx desde Google Drive (Service Account)
 * GET ?diag  → diagnóstico SA
 * POST       → escribe "Enviado" en columna HC sin tocar formato
 *              Body: { sheetRow: number } | { sheetRows: number[] }
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

  // ── POST ──────────────────────────────────────────────────────────────────
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
