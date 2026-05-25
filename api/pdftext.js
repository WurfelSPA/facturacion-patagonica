import JSZip from "jszip";

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

/* Parsear CMap correctamente: rangos primero, luego chars individuales */
function parseCMap(cmapText) {
  const mapping = {};
  // bfrange
  const rangeSection = cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
  for (const section of rangeSection) {
    const matches = section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const [, s, e, d] of matches) {
      const si = parseInt(s, 16), ei = parseInt(e, 16), di = parseInt(d, 16);
      for (let i = 0; i <= ei - si; i++) mapping[si + i] = String.fromCodePoint(di + i);
    }
  }
  // bfchar (sobreescribe rangos)
  const charSection = cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
  for (const section of charSection) {
    const matches = section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const [, src, dst] of matches) {
      try {
        const code = parseInt(src, 16);
        const dstBytes = Buffer.from(dst, "hex");
        mapping[code] = dstBytes.toString("utf16le").split("").reverse().join(""); // BE
        // Proper UTF-16BE decode
        mapping[code] = "";
        for (let i = 0; i < dstBytes.length; i += 2) {
          mapping[code] += String.fromCodePoint(dstBytes.readUInt16BE(i));
        }
      } catch {}
    }
  }
  return mapping;
}

/* Extraer texto del PDF usando CMap para decodificar */
function extractPDFText(pdfBuffer) {
  const { createInflateSync } = require("zlib");
  const inflate = createInflateSync ? createInflateSync() : null;

  const str = pdfBuffer.toString("latin1");
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  const streams = [];
  let m;
  while ((m = streamRegex.exec(str)) !== null) {
    streams.push(Buffer.from(m[1], "latin1"));
  }

  // Construir CMap de todos los streams
  const mapping = {};
  for (const s of streams) {
    try {
      const decompressed = require("zlib").inflateSync(s).toString("latin1");
      if (decompressed.includes("beginbfchar") || decompressed.includes("beginbfrange")) {
        Object.assign(mapping, parseCMap(decompressed));
      }
    } catch {}
  }

  // Extraer texto del stream de contenido
  let text = "";
  for (const s of streams) {
    try {
      const decompressed = require("zlib").inflateSync(s).toString("latin1");
      // Buscar operadores Tj con hex: <HHHH> Tj
      const hexTj = decompressed.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g);
      for (const [, h] of hexTj) {
        const code = parseInt(h, 16);
        text += mapping[code] !== undefined ? mapping[code] : (code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
      }
    } catch {}
  }

  return text.replace(/\s+/g, " ").trim();
}

function normalizeRUT(rut) {
  return rut.replace(/\./g, "").replace(/\s/g, "").toLowerCase();
}

function extractData(text, tipo) {
  // Buscar RUT del cliente (el segundo RUT, después del RUT de Patagónica 96.673.250-4)
  const ruts = [...text.matchAll(/\d{1,2}\.\d{3}\.\d{3}-[\dkK]/g)].map(m => m[0]);
  const clientRut = ruts.find(r => r !== "96.673.250-4") || null;
  const rut = clientRut ? normalizeRUT(clientRut) : null;

  // Extraer UF — 3 patrones detectados en facturas Patagónica:
  //   P1: col Cant/Unidad  →  "10,24 UF   40.186,79"  (serv_adm y arriendo simple)
  //   P2: en descripción   →  "UF 85,37 x 40186,79"   (arriendo mayoría)
  //   P3: layout partido   →  línea cortada por PDF, fallback colapsando whitespace
  let uf = null;
  let m;

  // P1: "XX,XX UF   40.186"
  m = text.match(/([\d]+(?:[,.][\d]+)?)\s+UF\s+4[09][,.\d]/);
  if (m) uf = parseFloat(m[1].replace(",", "."));

  // P2: "UF XX,XX x 40186"
  if (!uf) {
    m = text.match(/UF\s+([\d]+(?:[,.][\d]+)?)\s+x\s+4[09]/);
    if (m) uf = parseFloat(m[1].replace(",", "."));
  }

  // P3: layout partido — colapsar whitespace y reintentar
  if (!uf) {
    const flat = text.replace(/\s+/g, " ");
    m = flat.match(/UF\s+([\d]+(?:[,.][\d]+)?)\s+x\s+/);
    if (m) uf = parseFloat(m[1].replace(",", "."));
    if (!uf) {
      m = flat.match(/([\d]+[,.][\d]+)\s+x\s+4[09]/);
      if (m) uf = parseFloat(m[1].replace(",", "."));
    }
  }

  return { rut, uf: uf ? Math.round(uf * 10000) / 10000 : null };
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

    const SITIO_MAP = {"5A":"5-A","4A":"4-A","A1":"A-1","A2":"A-2","B":"B","D2":"D-2"};
    const zip = await JSZip.loadAsync(zipBuffer);
    const result = {};

    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !path.toLowerCase().endsWith(".pdf")) continue;
      const parts = path.split("/");
      const carpeta = parts.length > 1 ? parts[parts.length - 2] : "";
      const nombre = parts[parts.length - 1];
      const sitio = SITIO_MAP[carpeta] || carpeta;
      const nroMatch = nombre.match(/^(F(?:EE)?-\d+)/i);
      if (!nroMatch) continue;
      const nroFact = nroMatch[1].toUpperCase();

      // FIX: detectar tipo por contenido del PDF, no solo por prefijo del nombre.
      // F-14633 empieza con "F-" pero su descripción dice "Serv. Adm." → debe ser serv_adm.
      const pdfBuffer = Buffer.from(await entry.async("arraybuffer"));
      const text = extractPDFText(pdfBuffer);
      const tipo = text.includes("Serv. Adm.") || text.includes("Serv.Adm.")
        ? "serv_adm"
        : text.includes("Arriendo")
        ? "arriendo"
        : nroFact.startsWith("FEE-") ? "serv_adm" : "arriendo";

      const { rut, uf } = extractData(text, tipo);
      result[nroFact] = { rut, uf, tipo, sitio };
    }

    return res.status(200).json({ pdfs: result, count: Object.keys(result).length });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 500) });
  }
}
