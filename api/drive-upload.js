/**
 * /api/drive-upload
 * Sube un archivo a Google Drive usando el Service Account.
 * Reemplaza el upload directo desde el frontend con token OAuth del usuario.
 *
 * POST body: { base64, filename, mimeType, folderId }
 * Response:  { id, name }
 */

export const config = { api: { bodyParser: true, responseLimit: '60mb' } };

async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey.buffer, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${signingInput}.${sigB64}`;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }, sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("SA token error: " + JSON.stringify(data));
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { base64, filename, mimeType, folderId } = req.body || {};
  if (!base64 || !filename || !folderId)
    return res.status(400).json({ error: 'Faltan parámetros: base64, filename, folderId' });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT no configurada' });

  try {
    const sa = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    // Decodificar base64 a bytes
    const binaryStr = atob(base64);
    const fileBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) fileBytes[i] = binaryStr.charCodeAt(i);

    const mime = mimeType || 'application/octet-stream';
    const meta = JSON.stringify({ name: filename, mimeType: mime, parents: [folderId] });
    const boundary = 'drive_sa_upload_boundary';
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
    const endPart = `\r\n--${boundary}--`;
    const metaBytes = new TextEncoder().encode(metaPart);
    const endBytes = new TextEncoder().encode(endPart);
    const body = new Uint8Array(metaBytes.length + fileBytes.length + endBytes.length);
    body.set(metaBytes, 0);
    body.set(fileBytes, metaBytes.length);
    body.set(endBytes, metaBytes.length + fileBytes.length);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body.buffer,
      }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(502).json({ error: `Drive upload ${uploadRes.status}: ${err.slice(0, 200)}` });
    }

    const data = await uploadRes.json();
    return res.status(200).json({ id: data.id, name: data.name });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
