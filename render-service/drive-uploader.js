/**
 * render-service/drive-uploader.js
 *
 * Sube los PDFs scrapeados de Aguas Andinas a Google Drive.
 * Estructura esperada en Drive:
 *   [AGUAS_ANDINAS_DRIVE_FOLDER_ID]/
 *     jun-2026/   (o cualquier nombre que contenga "jun" + "2026")
 *     may-2026/
 *     ...
 *
 * Env vars requeridas:
 *   GOOGLE_SERVICE_ACCOUNT_JSON     — JSON completo de la cuenta de servicio
 *   AGUAS_ANDINAS_DRIVE_FOLDER_ID   — ID de la carpeta "agua" en Drive
 */

const { google }   = require('googleapis');
const { Readable } = require('stream');

// ── Auth ──────────────────────────────────────────────────────────────────────
function getAuthClient() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('Falta GOOGLE_SERVICE_ACCOUNT_JSON');
  const creds = JSON.parse(saJson);
  return new google.auth.JWT({
    email:  creds.client_email,
    key:    creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

// ── Month helpers ─────────────────────────────────────────────────────────────
const ES_MONTHS = {
  ene: { en: 'jan', num: '01', es: 'enero'      },
  feb: { en: 'feb', num: '02', es: 'febrero'    },
  mar: { en: 'mar', num: '03', es: 'marzo'      },
  abr: { en: 'apr', num: '04', es: 'abril'      },
  may: { en: 'may', num: '05', es: 'mayo'       },
  jun: { en: 'jun', num: '06', es: 'junio'      },
  jul: { en: 'jul', num: '07', es: 'julio'      },
  ago: { en: 'aug', num: '08', es: 'agosto'     },
  sep: { en: 'sep', num: '09', es: 'septiembre' },
  oct: { en: 'oct', num: '10', es: 'octubre'    },
  nov: { en: 'nov', num: '11', es: 'noviembre'  },
  dic: { en: 'dec', num: '12', es: 'diciembre'  },
};

// Parses "jun/2026" → { month: 'jun', year: '2026', num: '06', es: 'junio' }
function parseMes(mes) {
  if (!mes) return null;
  const m = String(mes).match(/^(\w{3})\/(\d{4})$/);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const info = ES_MONTHS[key];
  if (!info) return null;
  return { month: key, year: m[2], ...info };
}

// Check if a Drive folder name matches a parsed month
function folderMatchesMes(folderName, parsed) {
  const name = folderName.toLowerCase();
  const { month, year, num, es } = parsed;
  // Accept: jun-2026, jun 2026, junio-2026, junio 2026, 2026-06, 06-2026, etc.
  return (
    (name.includes(month) && name.includes(year)) ||
    (name.includes(es)    && name.includes(year)) ||
    (name.includes(year + '-' + num)) ||
    (name.includes(num + '-' + year))
  );
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function listChildFolders(drive, parentId) {
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 100,
  });
  return res.data.files || [];
}

async function findOrCreateMonthFolder(drive, parentId, parsed) {
  const folders = await listChildFolders(drive, parentId);
  const match   = folders.find(f => folderMatchesMes(f.name, parsed));
  if (match) {
    console.log(`[drive] Carpeta existente: "${match.name}" (${match.id})`);
    return match.id;
  }

  // Create with standard name e.g. "jun-2026"
  const newName = `${parsed.month}-${parsed.year}`;
  console.log(`[drive] Creando carpeta: "${newName}" bajo ${parentId}`);
  const created = await drive.files.create({
    requestBody: {
      name:     newName,
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [parentId],
    },
    fields: 'id',
  });
  return created.data.id;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function uploadBoletas(boletas) {
  const parentFolderId = process.env.AGUAS_ANDINAS_DRIVE_FOLDER_ID;
  if (!parentFolderId) throw new Error('Falta AGUAS_ANDINAS_DRIVE_FOLDER_ID');

  const auth  = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const uploaded = [];
  const errors   = [];

  // Group boletas by month to minimize folder listing calls
  const byMonth = new Map();
  for (const b of boletas) {
    const parsed = parseMes(b.mes);
    if (!parsed) {
      errors.push({ boleta: b, error: 'No se pudo parsear mes: ' + b.mes });
      continue;
    }
    const key = `${parsed.month}-${parsed.year}`;
    if (!byMonth.has(key)) byMonth.set(key, { parsed, items: [] });
    byMonth.get(key).items.push(b);
  }

  for (const [key, { parsed, items }] of byMonth) {
    let folderId;
    try {
      folderId = await findOrCreateMonthFolder(drive, parentFolderId, parsed);
    } catch (err) {
      const msg = `No se pudo obtener carpeta ${key}: ${err.message}`;
      console.error('[drive]', msg);
      items.forEach(b => errors.push({ boleta: b, error: msg }));
      continue;
    }

    for (const b of items) {
      if (!b.pdfBase64) {
        errors.push({ boleta: b, error: 'pdfBase64 vacío' });
        continue;
      }

      // Filename: aguasandinas_202606_factura_9297652.pdf
      const filename = `aguasandinas_${parsed.year}${parsed.num}_factura_${b.nroFactura}.pdf`;

      try {
        // Skip if already uploaded
        const q = `'${folderId}' in parents and name = '${filename}' and trashed = false`;
        const existing = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
        if (existing.data.files && existing.data.files.length > 0) {
          console.log('[drive] Ya existe, saltando:', filename);
          uploaded.push({ filename, id: existing.data.files[0].id, skipped: true });
          continue;
        }

        const buffer = Buffer.from(b.pdfBase64, 'base64');
        const stream = Readable.from(buffer);

        const res = await drive.files.create({
          requestBody: {
            name:    filename,
            parents: [folderId],
          },
          media: {
            mimeType: 'application/pdf',
            body:     stream,
          },
          fields: 'id, name, size',
        });

        console.log('[drive] Subido:', filename, '→', res.data.id, `(${res.data.size} bytes)`);
        uploaded.push({ filename, id: res.data.id, size: res.data.size, folder: key });

      } catch (err) {
        console.error('[drive] Error subiendo', filename, ':', err.message);
        errors.push({ boleta: b, error: err.message });
      }
    }
  }

  return { uploaded, errors };
}

module.exports = { uploadBoletas };
