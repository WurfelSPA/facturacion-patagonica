export const config = { api: { bodyParser: false } };

const FACTURACION_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NUM = {
  "Enero":"01","Febrero":"02","Marzo":"03","Abril":"04",
  "Mayo":"05","Junio":"06","Julio":"07","Agosto":"08",
  "Septiembre":"09","Octubre":"10","Noviembre":"11","Diciembre":"12"
};

// Reutiliza la misma lógica de firma JWT que planilla.js
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

async function driveList(token, folderId, mimeType = null) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (mimeType) q += ` and mimeType='${mimeType}'`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error("Drive list error: " + JSON.stringify(data));
  return data.files || [];
}

async function downloadFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Download error ${res.status}`);
  return res.arrayBuffer();
}

// Crear ZIP en memoria con los PDFs de la carpeta
async function buildZip(token, folderId) {
  // Listar PDFs directos y subcarpetas
  const items = await driveList(token, folderId);
  
  // Coleccionar todos los PDFs (en raíz y subcarpetas un nivel)
  const pdfs = []; // {name, data, folder}
  
  for (const item of items) {
    if (item.mimeType === "application/vnd.google-apps.folder") {
      // Subcarpeta (5A, 4A, etc.) — listar PDFs dentro
      const subItems = await driveList(token, item.id, "application/pdf");
      for (const pdf of subItems) {
        pdfs.push({ name: pdf.name, folderId: item.id, fileId: pdf.id, subfolder: item.name });
      }
    } else if (item.mimeType === "application/pdf") {
      pdfs.push({ name: item.name, fileId: item.id, subfolder: "" });
    }
  }

  if (pdfs.length === 0) throw new Error("No se encontraron PDFs en la carpeta del mes");

  // Construir ZIP manualmente (formato ZIP sin compresión)
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;

  function u16(n) { const b = new Uint8Array(2); b[0]=n&0xff; b[1]=(n>>8)&0xff; return b; }
  function u32(n) { const b = new Uint8Array(4); b[0]=n&0xff; b[1]=(n>>8)&0xff; b[2]=(n>>16)&0xff; b[3]=(n>>24)&0xff; return b; }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = [];
    for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?(0xEDB88320^(c>>>1)):(c>>>1);table[i]=c;}
    for (let i=0;i<buf.length;i++) crc=table[(crc^buf[i])&0xff]^(crc>>>8);
    return (crc^0xFFFFFFFF)>>>0;
  }

  const parts = [];

  for (const pdf of pdfs) {
    const data = new Uint8Array(await downloadFile(token, pdf.fileId));
    const path = pdf.subfolder ? `${pdf.subfolder}/${pdf.name}` : pdf.name;
    const nameBytes = encoder.encode(path);
    const crc = crc32(data);
    const size = data.length;

    // Local file header
    const lhSig = new Uint8Array([0x50,0x4b,0x03,0x04]);
    const lh = concat([lhSig, u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes, data]);
    
    // Central directory entry
    const cdSig = new Uint8Array([0x50,0x4b,0x01,0x02]);
    const cd = concat([cdSig, u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]);

    localHeaders.push(lh);
    centralDir.push(cd);
    offset += lh.length;
  }

  // End of central directory
  const cdOffset = offset;
  const cdSize = centralDir.reduce((s,c)=>s+c.length, 0);
  const eocd = concat([
    new Uint8Array([0x50,0x4b,0x05,0x06]),
    u16(0), u16(0),
    u16(pdfs.length), u16(pdfs.length),
    u32(cdSize), u32(cdOffset),
    u16(0)
  ]);

  return concat([...localHeaders, ...centralDir, eocd]);
}

function concat(arrays) {
  const total = arrays.reduce((s,a)=>s+a.length,0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // ?periodo=Mayo+2026
  const periodo = req.query.periodo;
  if (!periodo) return res.status(400).json({ error: "Falta parámetro periodo" });

  const [mesNombre, anio] = periodo.split(" ");
  const mesNum = MES_NUM[mesNombre];
  if (!mesNum || !anio) return res.status(400).json({ error: "Período inválido: " + periodo });

  const folderName = `${mesNum}-${anio}`; // "05-2026"

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });

  try {
    const serviceAccount = JSON.parse(saJson);
    const token = await getAccessToken(serviceAccount);

    // Buscar la carpeta del mes dentro de Facturacion Mensual
    const folders = await driveList(token, FACTURACION_FOLDER_ID, "application/vnd.google-apps.folder");
    const monthFolder = folders.find(f => f.name === folderName);
    if (!monthFolder) {
      return res.status(404).json({ error: `Carpeta ${folderName} no encontrada en Drive` });
    }

    // Construir ZIP con los PDFs
    const zipData = await buildZip(token, monthFolder.id);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${folderName}.zip"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", zipData.length);
    return res.status(200).send(Buffer.from(zipData));

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
