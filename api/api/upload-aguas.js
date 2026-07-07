/**
 * api/upload-aguas.js
 *
 * Endpoint Vercel — recibe PDFs de boletas Aguas Andinas desde render-service
 * y los sube a Google Drive usando GOOGLE_SERVICE_ACCOUNT ya configurada.
 *
 * POST /api/upload-aguas
 * Headers: x-sync-secret: <SYNC_SECRET>
 * Body: { boletas: [{ nroFactura, mes, pdfBase64, monto?, estado? }] }
 *
 * Env vars requeridas (ya en Vercel):
 *   GOOGLE_SERVICE_ACCOUNT          — JSON de cuenta de servicio
 *   SYNC_SECRET                     — token de autenticación
 * Env vars nuevas a agregar en Vercel:
 *   AGUAS_ANDINAS_DRIVE_FOLDER_ID   — ID carpeta "agua" en Drive
 */

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// ── JWT + Auth (mismo patrón que planilla.js) ─────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = obj =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${encode(header)}.${encode(payload)}`;

  const pemContents = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${signingInput}.${sigB64}`;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }, sa.private_key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Month helpers ─────────────────────────────────────────────────────────────
const MONTH_MAP = {
  ene:{num:'01',es:'enero'}, feb:{num:'02',es:'febrero'}, mar:{num:'03',es:'marzo'},
  abr:{num:'04',es:'abril'}, may:{num:'05',es:'mayo'},    jun:{num:'06',es:'junio'},
  jul:{num:'07',es:'julio'}, ago:{num:'08',es:'agosto'},  sep:{num:'09',es:'septiembre'},
  oct:{num:'10',es:'octubre'},nov:{num:'11',es:'noviembre'},dic:{num:'12',es:'diciembre'},
};

function parseMes(mes) {
  const m = String(mes || '').match(/^(\w{3})\/(\d{4})$/);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const info = MONTH_MAP[key];
  if (!info) return null;
  return { month: key, year: m[2], ...info };
}

function folderMatchesMes(folderName, parsed) {
  const n = folderName.toLowerCase();
  const { month, year, num, es } = parsed;
  return (n.includes(month) && n.includes(year)) ||
         (n.includes(es)    && n.includes(year)) ||
         n.includes(`${year}-${num}`) || n.includes(`${num}-${year}`);
}

// ── Drive REST helpers ────────────────────────────────────────────────────────
async function driveList(token, q) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive list error ${r.status}: ${await r.text()}`);
  return (await r.json()).files || [];
}

async function driveCreateFolder(token, name, parentId) {
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  if (!r.ok) throw new Error(`Drive createFolder error ${r.status}: ${await r.text()}`);
  return (await r.json()).id;
}

async function driveUploadPDF(token, filename, pdfBase64, folderId) {
  const boundary = 'pdfsep_' + Math.random().toString(36).slice(2);
  const metadata  = JSON.stringify({ name: filename, parents: [folderId] });
  const pdfBytes  = Buffer.from(pdfBase64, 'base64');

  // Build multipart body
  const enc  = new TextEncoder();
  const part1 = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
  );
  const part2header = enc.encode(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`);
  const part2footer = enc.encode(`\r\n--${boundary}--`);

  const body = Buffer.concat([part1, part2header, pdfBytes, part2footer]);

  const r = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    }
  );
  if (!r.ok) throw new Error(`Drive upload error ${r.status}: ${await r.text()}`);
  return await r.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const secret = req.headers['x-sync-secret'] || req.body?.secret;
  const SYNC_SECRET = process.env.SYNC_SECRET || '';
  if (!SYNC_SECRET || secret !== SYNC_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // Env vars
  const saJson       = process.env.GOOGLE_SERVICE_ACCOUNT;
  const parentFolder = process.env.AGUAS_ANDINAS_DRIVE_FOLDER_ID;
  if (!saJson)       return res.status(500).json({ error: 'Falta GOOGLE_SERVICE_ACCOUNT' });
  if (!parentFolder) return res.status(500).json({ error: 'Falta AGUAS_ANDINAS_DRIVE_FOLDER_ID' });

  const { boletas } = req.body || {};
  if (!Array.isArray(boletas) || boletas.length === 0) {
    return res.status(400).json({ error: 'boletas debe ser un array no vacío' });
  }

  const sa      = JSON.parse(saJson);
  const token   = await getAccessToken(sa);
  const uploaded = [];
  const errors   = [];

  // Cache month folder IDs to avoid repeated Drive API calls
  const folderCache = {};

  for (const b of boletas) {
    const parsed = parseMes(b.mes);
    if (!parsed) {
      errors.push({ nroFactura: b.nroFactura, error: 'No se pudo parsear mes: ' + b.mes });
      continue;
    }
    if (!b.pdfBase64) {
      errors.push({ nroFactura: b.nroFactura, error: 'pdfBase64 vacío' });
      continue;
    }

    const cacheKey = `${parsed.month}-${parsed.year}`;

    try {
      // Find or create month subfolder (cached)
      if (!folderCache[cacheKey]) {
        const folders = await driveList(token,
          `'${parentFolder}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
        );
        const match = folders.find(f => folderMatchesMes(f.name, parsed));
        if (match) {
          folderCache[cacheKey] = match.id;
        } else {
          folderCache[cacheKey] = await driveCreateFolder(token, cacheKey, parentFolder);
        }
      }

      const folderId = folderCache[cacheKey];
      const filename = `aguasandinas_${parsed.year}${parsed.num}_factura_${b.nroFactura}.pdf`;

      // Skip if already exists
      const existing = await driveList(token,
        `'${folderId}' in parents and name='${filename}' and trashed=false`
      );
      if (existing.length > 0) {
        uploaded.push({ filename, id: existing[0].id, skipped: true });
        continue;
      }

      // Upload
      const file = await driveUploadPDF(token, filename, b.pdfBase64, folderId);
      uploaded.push({ filename, id: file.id, size: file.size, folder: cacheKey });
      console.log('[upload-aguas] Subido:', filename);

    } catch (err) {
      console.error('[upload-aguas] Error', b.nroFactura, ':', err.message);
      errors.push({ nroFactura: b.nroFactura, error: err.message });
    }
  }

  return res.status(200).json({
    ok:       true,
    uploaded: uploaded.length,
    errors:   errors.length,
    uploadedFiles: uploaded,
    errorList:     errors,
  });
}
