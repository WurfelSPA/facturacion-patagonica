/**
 * api/upload-aguas.js
 *
 * Endpoint Vercel — dos modos:
 *
 * Modo A (render-service): recibe pdfBase64 directamente
 *   Body: { boletas: [{ nroFactura, mes, pdfBase64 }] }
 *
 * Modo B (browser-directo): recibe URL de Sovos, Vercel baja el PDF
 *   Body: { boletas: [{ nroFactura, mes, sovosUrl }] }
 *
 * POST /api/upload-aguas
 * Headers: x-sync-secret: <SYNC_SECRET>
 */

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// ── CORS ──────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');
}

// ── JWT + Auth ─────────────────────────────────────────────────────────────────
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

// ── Sovos PDF fetcher (server-to-server, sin restricciones CORS) ──────────────
async function fetchSovosPdf(sovosUrl) {
  const r = await fetch(sovosUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,*/*',
    },
  });
  if (!r.ok) throw new Error(`Sovos HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 1000) throw new Error(`Sovos respuesta muy pequeña: ${buf.byteLength}b — ` + ct);
  return Buffer.from(buf).toString('base64');
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-sync-secret'] || req.body?.secret;
  const SYNC_SECRET = process.env.SYNC_SECRET || '';
  if (!SYNC_SECRET || secret !== SYNC_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const saJson       = process.env.GOOGLE_SERVICE_ACCOUNT;
  const parentFolder = req.body.parentFolderId || process.env.AGUAS_ANDINAS_DRIVE_FOLDER_ID;
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
  const folderCache = {};

  for (const b of boletas) {
    const parsed = parseMes(b.mes);
    if (!parsed) {
      errors.push({ nroFactura: b.nroFactura, error: 'No se pudo parsear mes: ' + b.mes });
      continue;
    }

    // Obtener PDF en base64: desde pdfBase64 directo o descargando de Sovos
    let pdfBase64 = b.pdfBase64 || null;
    if (!pdfBase64 && b.sovosUrl) {
      try {
        pdfBase64 = await fetchSovosPdf(b.sovosUrl);
        console.log('[upload-aguas] PDF descargado de Sovos para', b.nroFactura, '— tamaño:', Math.round(pdfBase64.length * 0.75 / 1024), 'KB');
      } catch (err) {
        errors.push({ nroFactura: b.nroFactura, error: 'Sovos fetch: ' + err.message });
        continue;
      }
    }

    if (!pdfBase64) {
      errors.push({ nroFactura: b.nroFactura, error: 'falta pdfBase64 o sovosUrl' });
      continue;
    }

    const cacheKey = `${parsed.month}-${parsed.year}`;

    try {
      if (!folderCache[cacheKey]) {
        const folders = await driveList(token,
          `'${parentFolder}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
        );
        const match = folders.find(f => folderMatchesMes(f.name, parsed));
        folderCache[cacheKey] = match
          ? match.id
          : await driveCreateFolder(token, `${parsed.year}-${parsed.num}`, parentFolder);
      }

      const folderId = folderCache[cacheKey];
      const filename = `aguasandinas_${parsed.year}${parsed.num}_factura_${b.nroFactura}.pdf`;

      const existing = await driveList(token,
        `'${folderId}' in parents and name='${filename}' and trashed=false`
      );
      if (existing.length > 0) {
        uploaded.push({ filename, id: existing[0].id, skipped: true });
        continue;
      }

      const file = await driveUploadPDF(token, filename, pdfBase64, folderId);
      uploaded.push({ filename, id: file.id, size: file.size, folder: cacheKey });
      console.log('[upload-aguas] Subido:', filename);

    } catch (err) {
      console.error('[upload-aguas] Error', b.nroFactura, ':', err.message);
      errors.push({ nroFactura: b.nroFactura, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    uploaded: uploaded.length,
    errors:   errors.length,
    uploadedFiles: uploaded,
    errorList:     errors,
  });
}
