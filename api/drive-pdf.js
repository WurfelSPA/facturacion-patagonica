/**
 * /api/drive-pdf
 *
 * GET ?folio=14670&periodo=2026-04
 *   → Descarga ZIP del período desde Drive (ej: 2026-04.zip)
 *   → Extrae F-14670 *.pdf del interior (busca en todas las subcarpetas del ZIP)
 *   → Devuelve el PDF como application/pdf
 *
 * GET ?folio=14670 (sin periodo)
 *   → Fallback: busca PDF suelto en Drive por nombre
 */

import JSZip from "jszip";

export const config = { api: { bodyParser: false, responseLimit: "15mb" } };

const FACT_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NUM = {
  Enero:"01", Febrero:"02", Marzo:"03", Abril:"04", Mayo:"05", Junio:"06",
  Julio:"07", Agosto:"08", Septiembre:"09", Octubre:"10", Noviembre:"11", Diciembre:"12",
};

// Convierte "Abril 2026" → "2026-04"
function parsePeriodo(str) {
  if (!str) return null;
  // Ya en formato YYYY-MM
  if (/^\d{4}-\d{2}$/.test(str)) return str;
  // "Abril 2026" → "2026-04"
  const m = str.match(/^(\w+)\s+(\d{4})$/);
  if (!m) return null;
  const mes = MES_NUM[m[1]];
  return mes ? `${m[2]}-${mes}` : null;
}

// ── JWT / SA ──────────────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${input}.${sigB64}`;
}

async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: " + JSON.stringify(d));
  return d.access_token;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function driveGet(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { const t = await r.text(); throw new Error(`Drive ${r.status}: ${t}`); }
  return r.json();
}

async function findFileInFolder(token, folderId, name) {
  const q = encodeURIComponent(`'${folderId}' in parents and name='${name}' and trashed=false`);
  const d = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size)&pageSize=5`
    + `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return d.files?.[0] || null;
}

async function downloadFileBuffer(token, fileId) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Fallback: busca PDF suelto en Drive global
async function findPdfGlobal(token, folio) {
  const q = encodeURIComponent(`name contains 'F-${folio}' and mimeType='application/pdf' and trashed=false`);
  const d = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`
    + `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const files = d.files || [];
  if (!files.length) return null;
  return files.find(f => f.name.startsWith(`F-${folio} `) || f.name.startsWith(`F-${folio}.`)) || files[0];
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const { folio, periodo: periodoRaw } = req.query;

  if (!folio || !/^\d+$/.test(folio)) {
    return res.status(400).json({ error: "Parámetro folio inválido. Ejemplo: ?folio=14670&periodo=2026-04" });
  }

  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saRaw) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });

  let sa;
  try { sa = JSON.parse(saRaw); } catch {
    return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT formato inválido" });
  }

  let token;
  try { token = await getToken(sa); } catch (e) {
    return res.status(500).json({ error: "Error de autenticación: " + e.message });
  }

  const periodo = parsePeriodo(periodoRaw);

  // ── Ruta 1: Extraer del ZIP del período ──────────────────────────────────────
  if (periodo) {
    try {
      const zipName = `${periodo}.zip`;
      const zipFile = await findFileInFolder(token, FACT_FOLDER_ID, zipName);

      if (zipFile) {
        const zipBuf = await downloadFileBuffer(token, zipFile.id);
        const zip = await JSZip.loadAsync(zipBuf);

        // Buscar F-{folio}*.pdf en cualquier subcarpeta del ZIP
        let pdfEntry = null;
        zip.forEach((relativePath, file) => {
          if (file.dir) return;
          const fname = relativePath.split("/").pop();
          if (fname.startsWith(`F-${folio} `) || fname.startsWith(`F-${folio}.`) || fname === `F-${folio}.pdf`) {
            pdfEntry = file;
          }
        });

        if (pdfEntry) {
          const pdfBuf = await pdfEntry.async("nodebuffer");
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `inline; filename="F-${folio}.pdf"`);
          res.setHeader("Cache-Control", "public, max-age=86400");
          return res.send(pdfBuf);
        }
        // ZIP encontrado pero folio no está dentro → continuar al fallback
      }
    } catch (e) {
      // Log pero no falla — intenta fallback
      console.error("ZIP extraction error:", e.message);
    }
  }

  // ── Ruta 2: Fallback — buscar PDF suelto en Drive ────────────────────────────
  try {
    const file = await findPdfGlobal(token, folio);
    if (file) {
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.redirect(302, `https://drive.google.com/file/d/${file.id}/view`);
    }
  } catch (e) {
    return res.status(500).json({ error: "Error buscando en Drive: " + e.message });
  }

  return res.status(404).json({
    error: `PDF para folio ${folio} no encontrado`,
    periodo: periodo || "no especificado",
    hint: "Verifica que el ZIP del período esté en Drive y el SA tenga acceso a la carpeta.",
  });
}
