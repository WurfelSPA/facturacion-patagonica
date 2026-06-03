/**
 * /api/mark-sent
 * Escribe "Enviado" en la columna HC de la fila correspondiente en el Google Sheets.
 *
 * POST body: { sheetRow }  — número de fila en el Sheets (1-indexed)
 */

const SPREADSHEET_ID = '1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml';
const SHEET_NAME     = 'Flujo';
const COLUMN         = 'HC';  // columna "Correo Enviado"

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

async function getSAToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }, sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

  const { sheetRow } = req.body || {};
  if (!sheetRow || typeof sheetRow !== 'number')
    return res.status(400).json({ error: 'Se requiere sheetRow (número de fila en el Sheets)' });

  try {
    const token = await getSAToken();
    const range = `${SHEET_NAME}!${COLUMN}${sheetRow}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;

    const updateRes = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Enviado']] }),
    });

    if (!updateRes.ok) {
      const err = await updateRes.text();
      return res.status(502).json({ error: `Sheets API ${updateRes.status}: ${err.slice(0, 200)}` });
    }

    return res.status(200).json({ ok: true, range });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
