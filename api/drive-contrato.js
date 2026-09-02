/**
 * /api/drive-contrato  GET ?nombre=2R+Spa&sitio=5-A&edificio=Edif.+77
 *
 * Busca dentro de la carpeta "Contratos por Cliente" (organizada como una
 * carpeta plana, una por cliente/sitio, ej. "A2 T.Of.44 CFMedica") la que
 * mejor matchea el nombre del cliente (+ sitio/edificio como desempate si
 * hay varias carpetas candidatas), y sirve el PDF más relevante que
 * encuentre adentro (prioriza uno cuyo nombre contenga "contrato").
 *
 * No hay forma confiable de mapear cliente→carpeta por RUT (los nombres de
 * carpeta no lo traen), así que el match es por nombre + fallback de alias
 * para casos con sigla (ej. SLEP). Si no encuentra nada, devuelve 404 con
 * un mensaje explicando qué buscó, para que el usuario pueda ubicarlo a mano.
 */

export const config = { api: { bodyParser: false, responseLimit: "20mb" } };

const CONTRATOS_CLIENTE_FOLDER_ID = "1IwlUWBMmc4GGPtteQnRubofHYpvgJuMP";

// Alias para clientes cuyo nombre en la Planilla no comparte palabras con el
// nombre/sigla usado en la carpeta de Drive.
const ALIAS = {
  "servicio local de educacion publica de los libertadores": ["slep"],
};

const GENERIC = new Set([
  "comercial","sociedad","empresa","empresas","servicios","industria","industrial",
  "distribuidora","corporacion","consultora","inversiones","laboratorio",
  "importadora","exportadora","agencia","compania","limitada","chile","spa","ltda","sa",
  // códigos de zona (ya se usan aparte como bonus vía sitio/edificio, no sirven
  // para identificar al cliente y son demasiado comunes entre carpetas)
  "a1","a2","b","d2","d3","5a","4a","24","j",
]);

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " ")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function sigWords(s) {
  return norm(s).split(" ").filter(w => w.length >= 2 && !GENERIC.has(w));
}
// Igualdad exacta, o prefijo compartido de ≥4 chars (tolera abreviaturas tipo
// "Consult."/"Consultores" y variantes de ortografía tipo "Outsorcing"/"Outsourcing").
function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4)) return true;
  return false;
}

// Puntaje de qué tan bien matchea una carpeta contra el cliente buscado.
function scoreFolder(folderName, nombre, sitio, edificio) {
  const fWords = sigWords(folderName);
  if (!fWords.length) return 0;
  let words = sigWords(nombre);
  const aliasKey = norm(nombre);
  if (ALIAS[aliasKey]) words = [...words, ...ALIAS[aliasKey]];
  if (!words.length) return 0;
  let common = words.filter(w => fWords.some(fw => wordsMatch(w, fw))).length;
  if (common === 0) return 0;
  let score = common / words.length;
  // Bonus si el sitio/edificio también aparece en el nombre de la carpeta
  const fNorm = norm(folderName).replace(/\s+/g, "");
  const hintTokens = [sitio, edificio].filter(Boolean).map(t => norm(t).replace(/\s+/g, ""));
  for (const t of hintTokens) {
    if (t && t.length >= 2 && fNorm.includes(t)) score += 0.5;
  }
  return score;
}

// ── JWT / SA token (mismo patrón que api/drive-pdf.js) ────────────────────────
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

// Cache en memoria de las subcarpetas (cambian poco) — evita listar ~100+
// carpetas en cada clic. TTL 1 hora.
let _folderCache = null, _folderCacheTs = 0;
const FOLDER_CACHE_TTL = 3600 * 1000;
async function listSubfolders(token) {
  const now = Date.now();
  if (_folderCache && (now - _folderCacheTs) < FOLDER_CACHE_TTL) return _folderCache;
  const files = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${CONTRATOS_CLIENTE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const d = await driveGet(token,
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=200` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true` + (pageToken ? `&pageToken=${pageToken}` : ""));
    files.push(...((d && d.files) || []));
    pageToken = d && d.nextPageToken;
  } while (pageToken);
  _folderCache = files;
  _folderCacheTs = now;
  return files;
}

// Elige el mejor PDF dentro de la carpeta del cliente.
function pickBestPdf(files) {
  const pdfs = files.filter(f => f.mimeType === "application/pdf");
  if (!pdfs.length) return null;
  const byDate = (a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0);
  const esContrato = f => /contrato/i.test(f.name);
  const esTerminoOModif = f => /(t[eé]rmino|modificaci[oó]n)/i.test(f.name);
  const limpios = pdfs.filter(f => esContrato(f) && !esTerminoOModif(f)).sort(byDate);
  if (limpios.length) return limpios[0];
  const contratos = pdfs.filter(esContrato).sort(byDate);
  if (contratos.length) return contratos[0];
  return pdfs.sort(byDate)[0];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const nombre = String(req.query.nombre || "").trim();
    const sitio = String(req.query.sitio || "").trim();
    const edificio = String(req.query.edificio || "").trim();
    if (!nombre) return res.status(400).json({ error: "Falta nombre" });

    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saRaw) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
    const sa = JSON.parse(saRaw);
    const token = await getToken(sa);

    const folders = await listSubfolders(token);
    let best = null, bestScore = 0;
    for (const f of folders) {
      const s = scoreFolder(f.name, nombre, sitio, edificio);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    if (!best || bestScore < 0.3) {
      return res.status(404).json({
        error: `No se encontró una carpeta de contrato para "${nombre}"` + (sitio ? ` (sitio ${sitio}${edificio ? " " + edificio : ""})` : "") +
          " en Drive → Contratos por Cliente. Puede que la carpeta tenga otro nombre.",
      });
    }

    const q = encodeURIComponent(`'${best.id}' in parents and trashed=false`);
    const listado = await driveGet(token,
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=50` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const pdf = pickBestPdf((listado && listado.files) || []);
    if (!pdf) {
      return res.status(404).json({
        error: `Se encontró la carpeta "${best.name}" pero no tiene ningún PDF adentro (puede que solo tenga Word/otros formatos).`,
      });
    }

    const buf = await driveDownload(token, pdf.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pdf.name.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).send(buf);
  } catch (err) {
    console.error("drive-contrato error:", err && err.message);
    return res.status(500).json({ error: err.message || "Error interno" });
  }
}
