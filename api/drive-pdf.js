/**
 * /api/drive-pdf
 *
 * GET ?folio=14670
 *   → Busca el PDF "F-{folio} *.pdf" en Drive y redirige a él.
 *   → 302 redirect a https://drive.google.com/file/d/{id}/view
 *   → 404 si no se encuentra
 */

export const config = { api: { bodyParser: false } };

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

// ── Drive search ──────────────────────────────────────────────────────────────
async function findPdfByFolio(token, folio) {
  // Busca en todo Drive del SA archivos cuyo nombre empiece con F-{folio}
  // Incluye Shared Drives para cubrir carpetas compartidas
  const q = encodeURIComponent(`name contains 'F-${folio}' and mimeType='application/pdf' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`
    + `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Drive search ${r.status}: ${txt}`);
  }
  const d = await r.json();
  if (!d.files || d.files.length === 0) return null;

  // Preferir el que empieza exactamente con "F-{folio} " o "F-{folio}."
  const exact = d.files.find(f => /^F-\d+[\s.]/.test(f.name) && f.name.startsWith(`F-${folio}`));
  return exact || d.files[0];
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const { folio } = req.query;

  if (!folio || !/^\d+$/.test(folio)) {
    return res.status(400).json({ error: "Parámetro folio inválido. Ejemplo: ?folio=14670" });
  }

  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saRaw) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });

  let sa;
  try { sa = JSON.parse(saRaw); } catch {
    return res.status(500).json({ error: "GOOGLE_SA_KEY formato inválido" });
  }

  let token;
  try { token = await getToken(sa); } catch (e) {
    return res.status(500).json({ error: "Error de autenticación: " + e.message });
  }

  let file;
  try { file = await findPdfByFolio(token, folio); } catch (e) {
    return res.status(500).json({ error: "Error buscando en Drive: " + e.message });
  }

  if (!file) {
    return res.status(404).json({ error: `PDF para folio ${folio} no encontrado en Drive` });
  }

  // Redirect al PDF en Drive
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.redirect(302, `https://drive.google.com/file/d/${file.id}/view`);
}
