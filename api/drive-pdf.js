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

export const config = { api: { bodyParser: false } };

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
  // Intento 1: con ordenamiento por fecha (obtiene el más reciente si hay duplicados)
  try {
    const d = await driveGet(token,
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size)&pageSize=5`
      + `&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    if (d.files?.length) return d.files[0];
  } catch (_) { /* Drive rechazó los parámetros extra — intentar query básica */ }
  // Intento 2: query mínima sin ordenamiento (siempre compatibe)
  const d2 = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size)&pageSize=5`);
  return d2.files?.[0] || null;
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
  // Guard global: cualquier excepción no capturada devuelve JSON en lugar de crashear
  try {
    return await handleRequest(req, res);
  } catch (err) {
    const msg = (err && err.stack) || (err && err.message) || String(err);
    console.error("drive-pdf UNCAUGHT:", msg);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Error interno inesperado", detail: String(err && err.message || err) });
    }
  }
}

async function handleRequest(req, res) {
  const { folio, periodo: periodoRaw } = req.query;

  // folio puede ser string o array si la URL tiene ?folio=x&folio=y
  const folioStr = Array.isArray(folio) ? folio[0] : folio;
  if (!folioStr || !/^\d+$/.test(String(folioStr))) {
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
    return res.status(500).json({ error: "Error de autenticación: " + (e && e.message) });
  }

  const periodo = parsePeriodo(Array.isArray(periodoRaw) ? periodoRaw[0] : periodoRaw);

  // ── Ruta 0: buscar PDF individual en Drive ───────────────────────────────────
  try {
    const qInd = encodeURIComponent(
      `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false` +
      ` and (name contains 'F-${folioStr} ' or name contains 'F-${folioStr}.' or name='F-${folioStr}.pdf'` +
      ` or name contains 'FEE-${folioStr} ' or name contains 'FEE-${folioStr}.')`
    );
    const dInd = await driveGet(token,
      `https://www.googleapis.com/drive/v3/files?q=${qInd}&fields=files(id,name,modifiedTime)&pageSize=10`
      + `&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const indFiles = (dInd && dInd.files) || [];
    if (indFiles.length && indFiles[0].id) {
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, `https://drive.google.com/file/d/${indFiles[0].id}/view`);
    }
  } catch (e0) {
    // Drive rechazó orderBy con AllDrives → reintento sin orderBy
    try {
      const qInd2 = encodeURIComponent(
        `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false` +
        ` and (name contains 'F-${folioStr} ' or name contains 'F-${folioStr}.' or name='F-${folioStr}.pdf'` +
        ` or name contains 'FEE-${folioStr} ' or name contains 'FEE-${folioStr}.')`
      );
      const dInd2 = await driveGet(token,
        `https://www.googleapis.com/drive/v3/files?q=${qInd2}&fields=files(id,name)&pageSize=10`);
      const indFiles2 = (dInd2 && dInd2.files) || [];
      if (indFiles2.length && indFiles2[0].id) {
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, `https://drive.google.com/file/d/${indFiles2[0].id}/view`);
      }
    } catch (_) { /* continuar */ }
  }

  // ── Ruta 1: PDF general del período (Facturas_PISA_YYYY-MM.pdf) ─────────────
  if (periodo) {
    try {
      const parts = periodo.split("-");
      const anio = parts[0] || "";
      const mesNum = parts[1] || "";
      const q = encodeURIComponent(
        `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`
        + ` and name contains 'PISA'`
      );
      const dGen = await driveGet(token,
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=20`
        + `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      const allPdfs = (dGen && dGen.files) || [];
      // Matching simple sin normalize (evita posibles problemas con ICU en runtime)
      const pdfGen = allPdfs.find(f => {
        if (!f || !f.name || !f.id) return false;
        const n = f.name.toLowerCase();
        return n.endsWith(".pdf") && n.includes("pisa") && (
          n.includes(`${anio}-${mesNum}`) ||
          n.includes(`${mesNum}-${anio}`) ||
          n.includes(`_${mesNum}_`) ||
          n.includes(` ${mesNum} `) ||
          n.includes(`-${mesNum}.pdf`)
        );
      });
      if (pdfGen && pdfGen.id) {
        console.log(`drive-pdf Ruta 1 → PDF general: ${pdfGen.name}`);
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, `https://drive.google.com/file/d/${pdfGen.id}/preview`);
      }
    } catch (e1) {
      console.error("drive-pdf Ruta 1 error:", (e1 && e1.message) || String(e1));
    }
  }

  // ── Ruta 2: Fallback — buscar PDF suelto en Drive ───────────────────────