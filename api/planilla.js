/**
 * /api/planilla
 * GET        → descarga la planilla xlsx desde Google Drive (Service Account)
 * GET ?diag  → diagnóstico SA
 * POST       → escribe "Enviado" en columna HC del XLSX y re-sube a Drive
 *              Body: { sheetRow: number } | { sheetRows: number[] }
 */

import XLSX from 'xlsx';

export const config = { api: { bodyParser: true } };

const SPREADSHEET_ID = process.env.DRIVE_PLANILLA_ID || "1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml";
const SHEET_NAME     = "Flujo";
const HC_COL         = 210; // columna HC (0-indexed): (8-1)*26+3 = 185... recalculado abajo

// HC en Google Sheets: H=8, C=3
// Fórmula para columnas de 2 letras: (letra1_num * 26) + letra2_num - 1 (0-indexed)
// H=8, C=3 → (8*26)+3 - 1 = 210   ← 0-indexed correcto

// ── JWT / SA helpers ──────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey.buffer, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${signingInput}.${sigB64}`;
}

async function getAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email,
    scope: scope || "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }, sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("SA token error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function downloadXlsx(token) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Drive download ${r.status}: ${txt.slice(0, 200)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

async function uploadXlsx(token, buffer) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${SPREADSHEET_ID}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": String(buffer.length),
      },
      body: buffer,
    }
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Drive upload ${r.status}: ${txt.slice(0, 200)}`);
  }
  return await r.json();
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

  // ── GET ?diag ──────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.query.diag === "1") {
    return res.status(200).json({ client_email: sa.client_email, project_id: sa.project_id });
  }

  // ── POST: escribe "Enviado" en columna HC ──────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};

    // Acepta { sheetRow: number } o { sheetRows: number[] }
    let rows = [];
    if (Array.isArray(body.sheetRows)) rows = body.sheetRows.filter(n => typeof n === "number" && n > 0);
    else if (typeof body.sheetRow === "number" && body.sheetRow > 0) rows = [body.sheetRow];
    if (!rows.length) return res.status(400).json({ error: "Se requiere sheetRow o sheetRows" });

    try {
      const token = await getAccessToken(sa, "https://www.googleapis.com/auth/drive");

      // 1. Descargar XLSX
      const buffer = await downloadXlsx(token);

      // 2. Parsear
      const wb = XLSX.read(buffer, { type: "buffer", cellStyles: true });
      const ws = wb.Sheets[SHEET_NAME];
      if (!ws) throw new Error(`Hoja "${SHEET_NAME}" no encontrada en el archivo`);

      // 3. Modificar celda HC{sheetRow} = "Enviado" para cada fila
      const ref = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s:{r:0,c:0}, e:{r:0,c:0} };
      for (const sheetRow of rows) {
        const cellAddr = XLSX.utils.encode_cell({ r: sheetRow - 1, c: HC_COL });
        ws[cellAddr] = { v: "Enviado", t: "s" };
        if (sheetRow - 1 > ref.e.r) ref.e.r = sheetRow - 1;
        if (HC_COL > ref.e.c) ref.e.c = HC_COL;
      }
      ws["!ref"] = XLSX.utils.encode_range(ref);

      // 4. Re-generar XLSX
      const outBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      // 5. Re-subir a Drive (mismo fileId, mismo nombre)
      await uploadXlsx(token, outBuffer);

      return res.status(200).json({ ok: true, updated: rows.length, rows });
    } catch (e) {
      console.error("planilla POST error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET: descargar planilla xlsx ───────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = await getAccessToken(sa);
    const buffer = await downloadXlsx(token);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(buffer.length));
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
