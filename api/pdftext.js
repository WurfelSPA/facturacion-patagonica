export const config = { api: { bodyParser: false, responseLimit: '60mb' } };

const FACTURACION_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";
const MES_NUM = {
  "Enero":"01","Febrero":"02","Marzo":"03","Abril":"04",
  "Mayo":"05","Junio":"06","Julio":"07","Agosto":"08",
  "Septiembre":"09","Octubre":"10","Noviembre":"11","Diciembre":"12"
};

async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const pemContents = privateKey.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey.buffer, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${signingInput}.${sigB64}`;
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const jwt = await signJWT(payload, serviceAccount.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token error: " + JSON.stringify(data));
  return data.access_token;
}

async function driveList(token, folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error("Drive list error: " + JSON.stringify(data));
  return data.files || [];
}

function extractTextFromPDFBuffer(buffer) {
  const str = buffer.toString("latin1");
  const texts = [];
  const tjRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
  const tjArrRegex = /\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = tjRegex.exec(str)) !== null) {
    const t = m[1].replace(/\\n/g," ").replace(/\\r/g," ").replace(/\\\(/g,"(").replace(/\\\)/g,")").replace(/\\\\/g,"\\");
    if (t.trim()) texts.push(t);
  }
  while ((m = tjArrRegex.exec(str)) !== null) {
    const inner = m[1].replace(/\(([^)]*)\)/g, (_,s) => s);
    if (inner.trim()) texts.push(inner);
  }
  return texts.join(" ").replace(/\s+/g," ").trim();
}

/* Normalizar RUT: "96.955.880-7" → "96955880-7" para comparación */
function normalizeRUT(rut) {
  return rut.replace(/\./g,"").replace(/\s/g,"").toLowerCase();
}

function extractFromText(text, tipo) {
  /* RUT: patrón XX.XXX.XXX-X o XX.XXX.XXX-K */
  const rutMatch = text.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dkK])/);
  const rut = rutMatch ? normalizeRUT(rutMatch[1]) : null;

  /* UF según tipo */
  let uf = null;
  if (tipo === "arriendo") {
    const m = text.match(/UF\s+([\d]+[,.]\d+)\s+x\s+[\d]/);
    if (m) uf = parseFloat(m[1].replace(",","."));
  } else {
    const m = text.match(/([\d]+[,.]\d+)\s*UF/i);
    if (m) uf = parseFloat(m[1].replace(",","."));
  }

  return { rut, uf: uf ? Math.round(uf*10000)/10000 : null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const periodo = req.query.periodo;
  if (!periodo) return res.status(400).json({ error: "Falta periodo" });

  const [mesNombre, anio] = periodo.split(" ");
  const mesNum = MES_NUM[mesNombre];
  if (!mesNum) return res.status(400).json({ error: "Periodo invalido" });

  const zipName = `${anio}-${mesNum}.zip`;
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "Sin credenciales" });

  try {
    const serviceAccount = JSON.parse(saJson);
    const token = await getAccessToken(serviceAccount);

    const files = await driveList(token, FACTURACION_FOLDER_ID);
    const zipFile = files.find(f => f.name.toLowerCase() === zipName.toLowerCase());
    if (!zipFile) return res.status(404).json({ error: `${zipName} no encontrado` });

    const zipRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!zipRes.ok) throw new Error(`Drive error ${zipRes.status}`);
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(zipBuffer);

    const SITIO_MAP = {"5A":"5-A","4A":"4-A","A1":"A-1","A2":"A-2","B":"B","D2":"D-2"};
    const result = {};

    for (const [path, entry] of Object.entries(zip.files)) {
      if (!path.toLowerCase().endsWith(".pdf")) continue;
      const parts = path.split("/");
      const carpeta = parts.length > 1 ? parts[parts.length-2] : "";
      const nombre = parts[parts.length-1];
      const sitio = SITIO_MAP[carpeta] || carpeta;

      const nroMatch = nombre.match(/^(F(?:EE)?-\d+)/i);
      if (!nroMatch) continue;
      const nroFact = nroMatch[1].toUpperCase();
      const tipo = nroFact.startsWith("FEE-") ? "serv_adm" : "arriendo";

      const pdfBuffer = Buffer.from(await entry.async("arraybuffer"));
      const text = extractTextFromPDFBuffer(pdfBuffer);
      const { rut, uf } = extractFromText(text, tipo);

      result[nroFact] = { rut, uf, tipo, sitio, path };
    }

    return res.status(200).json({ pdfs: result, count: Object.keys(result).length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
