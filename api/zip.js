export const config = { api: { bodyParser: false, responseLimit: '50mb' } };

const FACTURACION_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NUM = {
  "Enero":"01","Febrero":"02","Marzo":"03","Abril":"04",
  "Mayo":"05","Junio":"06","Julio":"07","Agosto":"08",
  "Septiembre":"09","Octubre":"10","Noviembre":"11","Diciembre":"12"
};

const MES_NOM = {
  "01":"Enero","02":"Febrero","03":"Marzo","04":"Abril",
  "05":"Mayo","06":"Junio","07":"Julio","08":"Agosto",
  "09":"Septiembre","10":"Octubre","11":"Noviembre","12":"Diciembre"
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
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error("Drive list error: " + JSON.stringify(data));
  return data.files || [];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const periodo = req.query.periodo;
  if (!periodo) return res.status(400).json({ error: "Falta parametro periodo" });

  const parts = periodo.split(" ");
  const mesNombre = parts[0];
  const anio = parts[1];
  const mesNum = MES_NUM[mesNombre];
  if (!mesNum || !anio) return res.status(400).json({ error: "Periodo invalido: " + periodo });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });

  try {
    const serviceAccount = JSON.parse(saJson);
    const token = await getAccessToken(serviceAccount);

    const files = await driveList(token, FACTURACION_FOLDER_ID);

    // 1. Buscar ZIP: "2026-05.zip"
    const zipName = `${anio}-${mesNum}.zip`;
    const zipFile = files.find(f => f.name.toLowerCase() === zipName.toLowerCase());

    if (zipFile) {
      // ZIP encontrado — descargarlo y servirlo
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!driveRes.ok) {
        const txt = await driveRes.text();
        return res.status(driveRes.status).json({ error: `Drive ${driveRes.status}: ${txt.slice(0,200)}` });
      }
      const buffer = await driveRes.arrayBuffer();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Length", buffer.byteLength);
      return res.status(200).send(Buffer.from(buffer));
    }

    // 2. ZIP no existe — buscar PDF maestro del mes
    // Nombres posibles: "Facturación Pisa Mayo.pdf", "Facturacion Pisa Mayo.pdf",
    //                   "Facturación PISA Mayo.pdf", variantes con/sin acento
    const mesNom = mesNombre; // "Mayo", "Junio", etc.
    const pdfMaestro = files.find(f => {
      const n = f.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      const mes = mesNom.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      return n.endsWith(".pdf") && n.includes("pisa") && n.includes(mes);
    });

    if (pdfMaestro) {
      // PDF maestro encontrado — informar al frontend para que pueda generar el ZIP
      return res.status(404).json({
        error: "no_zip",
        pdfMaestroId: pdfMaestro.id,
        pdfMaestroNombre: pdfMaestro.name,
        canGenerate: true,
        mensaje: `No existe ${zipName} pero hay un PDF maestro disponible para generar.`
      });
    }

    // 3. Nada disponible para este mes
    return res.status(404).json({
      error: "no_zip",
      canGenerate: false,
      mensaje: `No existe ${zipName} ni PDF maestro para ${mesNombre} ${anio} en Drive.`
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
