/**
 * /api/historial
 *
 * GET  ?anio=2026          → devuelve historial-facturas.json del año
 * GET  ?ls=FOLDER_ID       → lista archivos en carpeta Drive (SA)
 * GET  ?fileId=FILE_ID     → proxy descarga de archivo Drive (SA)
 * POST                     → guarda/fusiona datos de un período en el JSON
 *   Body: { anio, periodo, data: { "CLIENTE": { arriendo:"12345", servAdm:"12346" } } }
 *
 * El archivo historial-facturas.json vive en DRIVE_PDF_FACTURAS_ID.
 */

export const config = { api: { bodyParser: true } };

const PDF_FOLDER = process.env.DRIVE_PDF_FACTURAS_ID || "";
const HIST_NAME  = "historial-facturas.json";

// ── JWT / SA ──────────────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg:"RS256", typ:"JWT" };
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
async function getToken(sa) {
  const now = Math.floor(Date.now()/1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope:"https://www.googleapis.com/auth/drive",
    aud:"https://oauth2.googleapis.com/token", iat:now, exp:now+3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: "+JSON.stringify(d));
  return d.access_token;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function findFile(token, name, folderId) {
  const q = encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers:{ Authorization:`Bearer ${token}` } });
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

async function createJsonFile(token, name, folderId, content) {
  // Multipart: metadata + content
  const boundary = "PAT_HIST_" + Date.now();
  const meta = JSON.stringify({ name, parents:[folderId], mimeType:"application/json" });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":`multipart/related; boundary="${boundary}"` }, body }
  );
  const d = await r.json();
  if (!d.id) throw new Error("Create file error: "+JSON.stringify(d));
  return d.id;
}

async function updateJsonFile(token, fileId, content) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    { method:"PATCH", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body:content }
  );
  if (!r.ok) throw new Error(`Update file ${r.status}`);
}

async function downloadFile(token, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers:{ Authorization:`Bearer ${token}` } });
  if (!r.ok) return null;
  return r.text();
}

async function listFolder(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=name`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`List folder ${r.status}`);
  return r.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error:"GOOGLE_SERVICE_ACCOUNT no configurada" });
  const sa = JSON.parse(saJson);

  try {
    const token = await getToken(sa);

    // ── GET ?ls=FOLDER_ID ── lista carpeta Drive ───────────────────────────
    if (req.method === "GET" && req.query.ls) {
      const folderId = req.query.ls;
      if (!/^[\w-]+$/.test(folderId)) return res.status(400).json({ error:"ID inválido" });
      const data = await listFolder(token, folderId);
      return res.status(200).json(data);
    }

    // ── GET ?fileId=FILE_ID ── proxy descarga ──────────────────────────────
    if (req.method === "GET" && req.query.fileId) {
      const fileId = req.query.fileId;
      if (!/^[\w-]+$/.test(fileId)) return res.status(400).json({ error:"ID inválido" });
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers:{ Authorization:`Bearer ${token}` } });
      if (!r.ok) return res.status(r.status).json({ error:`Drive ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control","private, max-age=300");
      return res.status(200).send(buf);
    }

    // ── GET ?anio=YYYY ── devuelve historial JSON ─────────────────────────
    if (req.method === "GET") {
      if (!PDF_FOLDER) return res.status(200).json({});
      const fileId = await findFile(token, HIST_NAME, PDF_FOLDER);
      if (!fileId) return res.status(200).json({});
      const text = await downloadFile(token, fileId);
      const data = text ? JSON.parse(text) : {};
      const anio = req.query.anio;
      return res.status(200).json(anio ? (data[anio] || {}) : data);
    }

    // ── POST ── guarda/fusiona período ─────────────────────────────────────
    if (req.method === "POST") {
      const { anio, periodo, data: periodoData } = req.body || {};
      if (!anio || !periodo || !periodoData)
        return res.status(400).json({ error:"Se requiere anio, periodo y data" });
      if (!PDF_FOLDER)
        return res.status(500).json({ error:"DRIVE_PDF_FACTURAS_ID no configurada" });

      // Leer JSON existente
      let historial = {};
      const fileId = await findFile(token, HIST_NAME, PDF_FOLDER);
      if (fileId) {
        const text = await downloadFile(token, fileId);
        if (text) historial = JSON.parse(text);
      }

      // Fusionar datos del período
      if (!historial[anio]) historial[anio] = {};
      historial[anio][periodo] = { ...(historial[anio][periodo] || {}), ...periodoData };

      const content = JSON.stringify(historial, null, 2);
      if (fileId) await updateJsonFile(token, fileId, content);
      else await createJsonFile(token, HIST_NAME, PDF_FOLDER, content);

      return res.status(200).json({ ok:true, anio, periodo, clientes: Object.keys(periodoData).length });
    }

    return res.status(405).json({ error:"Method not allowed" });
  } catch (e) {
    console.error("historial:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
