/**
 * /api/drive-plano  GET ?sitio=5-A&edificio=Edif.+77&numeracion=77
 *
 * Busca el plano ("Edificio N.pdf") del sitio dentro de la carpeta de Drive
 * "Planos" (organizada en subcarpetas "Lote {sitio}" / "Torre 2680"), y lo
 * sirve directo. Si no encuentra una subcarpeta que matchee el sitio, busca
 * en TODAS las subcarpetas (algunos sitios no tienen carpeta propia).
 */

export const config = { api: { bodyParser: false, responseLimit: "20mb" } };

const PLANOS_ROOT_FOLDER_ID = "1yfX42VjjnUENS_OWdUEsZIkErEdLmoj_";

async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${input}.${sigB64}`;
}
async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: " + JSON.stringify(d));
  return d.access_token;
}
async function driveGet(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { const t = await r.text(); throw new Error(`Drive ${r.status}: ${t.slice(0, 200)}`); }
  return r.json();
}
async function driveDownload(token, fileId) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function listChildren(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const d = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=200` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return (d && d.files) || [];
}

function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

// Extrae el código final (dígitos + sufijo de letras opcional) de un string ya
// normalizado, ignorando la palabra descriptiva que lo antecede — "Edificio",
// "Oficina", "Bodega", "P.C.L", etc. según la carpeta/convención de nombres.
// Así "edificio61"→"61", "oficina23"→"23", "pcl4a"→"4a", sin necesidad de
// conocer de antemano qué prefijo usa cada carpeta.
function extractCode(normalizedStr) {
  const m = (normalizedStr || "").match(/(\d+[a-z]*)$/);
  return m ? m[1] : (normalizedStr || "");
}

// Cache en memoria del árbol completo (carpeta Planos + subcarpetas) — TTL 1h.
let _cache = null, _cacheTs = 0;
const TTL = 3600 * 1000;
async function loadTree(token) {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < TTL) return _cache;
  const root = await listChildren(token, PLANOS_ROOT_FOLDER_ID);
  const subfolders = root.filter(f => f.mimeType === "application/vnd.google-apps.folder");
  const rootFiles = root.filter(f => f.mimeType === "application/pdf").map(f => ({ ...f, folder: "" }));
  const nested = [];
  for (const sf of subfolders) {
    const children = await listChildren(token, sf.id);
    for (const c of children) {
      if (c.mimeType === "application/pdf") nested.push({ ...c, folder: sf.name });
    }
  }
  _cache = { subfolders, files: [...rootFiles, ...nested] };
  _cacheTs = now;
  return _cache;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const sitio = String(req.query.sitio || "").trim();
    const edificio = String(req.query.edificio || "").trim();
    const numeracion = String(req.query.numeracion || "").trim();
    if (!edificio && !numeracion) return res.status(400).json({ error: "Falta edificio o numeracion" });

    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saRaw) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
    const sa = JSON.parse(saRaw);
    const token = await getToken(sa);

    const { subfolders, files } = await loadTree(token);

    // Preferir archivos dentro de la carpeta "Lote {sitio}" (o "Lota", typo real
    // que existe en Drive) si existe una que matchee el sitio.
    const sitioNorm = norm(sitio);
    const folderMatch = subfolders.find(f => {
      const n = norm(f.name);
      return sitioNorm && (n.includes("lote" + sitioNorm) || n.includes("lota" + sitioNorm) || n === "lote" + sitioNorm);
    });
    const numNorm = norm(numeracion || edificio);

    const queryCode = extractCode((numeracion || "").replace(/[^0-9a-z]/gi, "").toLowerCase() || numNorm);

    function scoreFile(f) {
      const n = norm(f.name.replace(/\.pdf$/i, ""));
      if (!n) return 0;
      // El match del código es OBLIGATORIO — sin él no hay puntaje, aunque
      // la carpeta sea la correcta. Si no, para códigos cortos (ej. "H")
      // cualquier PDF de la carpeta terminaba "ganando" solo por el bonus
      // de carpeta, sirviendo el plano de OTRO edificio.
      if (!queryCode) return 0;
      const fileCode = extractCode(n);
      if (!fileCode) return 0;
      // Comparar solo el código final (dígitos+letras), no el nombre completo:
      // cada carpeta usa una palabra distinta ("Edificio", "Oficina", "P.C.L")
      // que no tiene por qué coincidir con la de la consulta.
      const exact = fileCode === queryCode;
      // El match por substring solo es seguro para códigos de ≥3 caracteres
      // (con 1-2 caracteres, "h" o "9" aparecen dentro de casi cualquier
      // código y producen falsos positivos).
      const substr = queryCode.length >= 3 && fileCode.includes(queryCode);
      // Caso "Edif. B/C/D..." (Sitio B): la Planilla solo registra la letra,
      // pero el archivo real lleva el rol completo ("Edificio 2758-C.pdf").
      // Si la consulta es puramente alfabética y corta, comparar solo el
      // sufijo de letras del código del archivo (sin los dígitos que lo
      // anteceden) — "c" (consulta) vs "2758c"→"c" (archivo).
      const queryIsLetterOnly = /^[a-z]+$/.test(queryCode);
      const letterMatch = queryIsLetterOnly && queryCode.length <= 2 && fileCode.replace(/^\d+/, "") === queryCode;
      if (!exact && !substr && !letterMatch) return 0;
      let s = exact ? 10 : (letterMatch ? 6 : 3);
      if (folderMatch && f.folder === folderMatch.name) s += 5;
      // preferir nombres cortos (plano general del edificio, no "Piso 2" suelto)
      s -= n.length * 0.01;
      return s;
    }

    let best = null, bestScore = 0;
    for (const f of files) {
      const s = scoreFile(f);
      if (s > bestScore) { bestScore = s; best = f; }
    }

    if (!best || bestScore < 2) {
      return res.status(404).json({
        error: `No se encontró un plano para el sitio ${sitio} ${edificio} en Drive → Planos.`,
      });
    }

    const buf = await driveDownload(token, best.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${best.name.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).send(buf);
  } catch (err) {
    console.error("drive-plano error:", err && err.message);
    return res.status(500).json({ error: err.message || "Error interno" });
  }
}
