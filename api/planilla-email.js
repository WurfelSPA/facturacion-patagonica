/**
 * GET /api/planilla-email?recipients=preview|contabilidad
 *
 * Cron automático:
 *   - Día 24 08:00 AM Chile → recipients=preview  → amelendez@, mmunoz@
 *   - Día 26 08:00 AM Chile → recipients=contabilidad → bpulgar@, contabilidad@ (CC mmunoz@, alagies@, amelendez@)
 *
 * Flujo:
 *   1. Obtiene access token de Gmail via refresh token
 *   2. Descarga la planilla XLSX desde Google Drive (DRIVE_PLANILLA_ID)
 *   3. Calcula el período = mes siguiente al día de ejecución
 *   4. Extrae comentarios del mes de la hoja "Flujo"
 *   5. Genera Excel resumen (misma lógica que el cliente)
 *   6. Envía correo con adjunto
 *
 * Env vars requeridas:
 *   GMAIL_CLIENT_ID       - OAuth2 client ID (Google Cloud Console)
 *   GMAIL_CLIENT_SECRET   - OAuth2 client secret
 *   GMAIL_REFRESH_TOKEN   - Refresh token con scope gmail.send + drive.readonly
 *   GMAIL_FROM            - Remitente (default: facturacion@patagonica.cl)
 *   DRIVE_PLANILLA_ID     - File ID de la planilla en Drive (default: hardcoded)
 *   CRON_SECRET           - Secreto para autenticar crons de Vercel
 *   SYNC_SECRET           - Secreto para llamadas manuales
 */

import XLSX from 'xlsx';
import JSZip from 'jszip';

const MESES_NOMBRES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const MESES = {Enero:0,Febrero:1,Marzo:2,Abril:3,Mayo:4,Junio:5,Julio:6,Agosto:7,Septiembre:8,Octubre:9,Noviembre:10,Diciembre:11};

const DRIVE_PLANILLA_ID_DEFAULT = "1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml";

// ── 1. OAuth2: intercambiar refresh token por access token ────────────────────
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth2 error: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth2: no access_token en respuesta');
  return data.access_token;
}

// ── 2. Drive: descargar planilla XLSX ────────────────────────────────────────
async function downloadFromDrive(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive download ${res.status}: ${err.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

// ── 3. Período: mes siguiente al día de ejecución ────────────────────────────
function getPeriodo(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${MESES_NOMBRES[next.getMonth()]} ${next.getFullYear()}`;
}

// ── Helper: encontrar columna del mes en la planilla ─────────────────────────
function findMonthCol(headerRow, targetYear, targetMonth) {
  function excelSerialToDate(s) { return new Date(Math.round((s - 25569) * 86400 * 1000)); }
  for (let c = 50; c < headerRow.length; c++) {
    const v = headerRow[c];
    let match = false;
    if (v instanceof Date) {
      match = (v.getUTCFullYear() === targetYear && v.getUTCMonth() === targetMonth)
           || (v.getFullYear()    === targetYear && v.getMonth()    === targetMonth);
    } else if (typeof v === 'number' && v > 40000 && v < 60000) {
      const d = excelSerialToDate(v);
      match = (d.getUTCFullYear() === targetYear && d.getUTCMonth() === targetMonth)
           || (d.getFullYear()    === targetYear && d.getMonth()    === targetMonth);
    }
    if (match) return c;
  }
  return -1;
}

// ── 4. Extraer comentarios del mes ───────────────────────────────────────────
function extraerComentarios(buf, periodo) {
  const [mesNombre, anio] = periodo.split(' ');
  const targetYear = parseInt(anio), targetMonth = MESES[mesNombre];

  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['Flujo'];
  if (!ws) throw new Error("Hoja 'Flujo' no encontrada en la planilla");

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const headerRow = rows[2] || [];

  const monthCol = findMonthCol(headerRow, targetYear, targetMonth);
  if (monthCol === -1) throw new Error(`Columna del mes ${periodo} no encontrada`);

  const comentariosCol = monthCol + 4;
  const SITIO_ORDER = ['5-A','4-A','A-1','A-2','B','D-2','D-3'];
  const grupos = {};

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const sitio = row[7], edif = row[8], cliente = row[11];
    const comentario = row[comentariosCol];
    if (!sitio || !cliente) continue;
    const comStr = comentario != null ? String(comentario).trim() : '';
    if (!comStr) continue;
    if (!grupos[sitio]) grupos[sitio] = [];
    grupos[sitio].push({
      edif:      edif    ? String(edif).trim()    : '',
      cliente:   String(cliente).trim(),
      comentario: comStr
    });
  }

  const ordenados = {};
  SITIO_ORDER.forEach(s => { if (grupos[s]) ordenados[s] = grupos[s]; });
  Object.keys(grupos).forEach(s => { if (!ordenados[s]) ordenados[s] = grupos[s]; });
  return ordenados;
}

// ── 5. Generar Excel resumen (misma lógica que el cliente) ───────────────────
async function generarExcelResumen(buf, periodo) {
  const [mesNombre, anio] = periodo.split(' ');
  const targetYear = parseInt(anio), targetMonth = MESES[mesNombre];

  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['Flujo'];
  if (!ws) throw new Error("Hoja 'Flujo' no encontrada");

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const headerRow = rows[2] || [];

  const monthCol = findMonthCol(headerRow, targetYear, targetMonth);
  if (monthCol === -1) throw new Error(`Columna del mes ${periodo} no encontrada`);

  const COLS    = [7, 8, 9, 10, 11, 42, monthCol, monthCol + 2, monthCol + 4];
  const HEADERS = ['Sitio','Edificio','RUT','Dirección','Cliente','Total m²',`Arriendo ${periodo}`,'GC','Comentarios'];
  const outRows = [HEADERS];

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const cv = row[11] != null ? String(row[11]).trim() : '';
    if (!cv || cv.toUpperCase() === 'VACANTE') continue;
    outRows.push(COLS.map(c => (row[c] != null ? row[c] : '')));
  }

  // Construir XLSX manualmente con XML (soporte estilos)
  function xlCol(idx) {
    let r = '', n = idx + 1;
    while (n > 0) { const rem = (n - 1) % 26; r = String.fromCharCode(65 + rem) + r; n = Math.floor((n - 1) / 26); }
    return r;
  }
  function xlEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const ss = [], ssMap = new Map();
  function ssIdx(v) {
    const s = String(v);
    if (ssMap.has(s)) return ssMap.get(s);
    const i = ss.length; ss.push(s); ssMap.set(s, i); return i;
  }

  const COL_W   = [8, 12, 14, 30, 28, 10, 14, 14, 40];
  const DEC_COLS = new Set([6, 7]);

  let rowsXml = '';
  let hCells = '';
  outRows[0].forEach((h, c) => { hCells += `<c r="${xlCol(c)}1" t="s" s="1"><v>${ssIdx(h)}</v></c>`; });
  rowsXml += `<row r="1" ht="18" customHeight="1">${hCells}</row>`;

  for (let ri = 1; ri < outRows.length; ri++) {
    const rowNum = ri + 1;
    let cells = '';
    outRows[ri].forEach((val, c) => {
      const addr = `${xlCol(c)}${rowNum}`;
      if (val === null || val === undefined || val === '') { cells += `<c r="${addr}" s="0"/>`; return; }
      if (typeof val === 'number') {
        cells += `<c r="${addr}" t="n" s="${DEC_COLS.has(c) ? '2' : '0'}"><v>${val}</v></c>`;
      } else {
        cells += `<c r="${addr}" t="s" s="0"><v>${ssIdx(val)}</v></c>`;
      }
    });
    rowsXml += `<row r="${rowNum}">${cells}</row>`;
  }

  const colsXml   = COL_W.map((w, i) => `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('');
  const sheetXml  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${colsXml}</cols><sheetData>${rowsXml}</sheetData></worksheet>`;
  const ssXml     = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ss.length}" uniqueCount="${ss.length}">${ss.map(s=>`<si><t xml:space="preserve">${xlEsc(s)}</t></si>`).join('')}</sst>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0277BD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const wbXml     = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Resumen" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const ctXml     = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', ctXml);
  zip.file('_rels/.rels', relsXml);
  zip.file('xl/workbook.xml', wbXml);
  zip.file('xl/_rels/workbook.xml.rels', wbRelsXml);
  zip.file('xl/styles.xml', stylesXml);
  zip.file('xl/sharedStrings.xml', ssXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);

  const uint8 = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(uint8);
}

// ── 6. Construir cuerpo HTML del correo ──────────────────────────────────────
function buildBodyHtml(grupos, periodo) {
  const sitios = Object.keys(grupos).filter(s => grupos[s].length > 0);
  let html = `<p>Estimados,</p><p>Adjunto planilla facturación <strong>${periodo}</strong></p>`;

  if (sitios.length === 0) {
    html += `<p>Sin comentarios especiales para este período.</p>`;
  } else {
    for (const sitio of sitios) {
      html += `<p><strong>Sitio ${sitio}</strong></p><ul>`;
      for (const { edif, cliente, comentario } of grupos[sitio]) {
        html += `<li><strong>${cliente}</strong>${edif ? ` ${edif}` : ''}:&nbsp;${comentario}</li>`;
      }
      html += `</ul>`;
    }
  }

  html += `<br><p>Quedo atento a sus comentarios</p><p>Saludos</p>`;
  html += `<br><hr><p style="color:#999;font-size:11px">Este correo fue generado automáticamente con apoyo de inteligencia artificial.</p>`;
  return html;
}

// ── 7. Enviar email vía Gmail API ─────────────────────────────────────────────
async function sendEmail(token, to, cc, from, subject, htmlBody, attachBuf, attachName) {
  const boundary = `PAT_${Date.now()}`;
  const fromEncoded = `=?UTF-8?B?${Buffer.from('Patagónica Inmobiliaria').toString('base64')}?= <${from}>`;

  const lines = [
    `From: ${fromEncoded}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlBody).toString('base64'),
    '',
    `--${boundary}`,
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="${attachName}"`,
    `Content-Disposition: attachment; filename="${attachName}"`,
    'Content-Transfer-Encoding: base64',
    '',
    attachBuf.toString('base64'),
    '',
    `--${boundary}--`
  ];

  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gmail ${res.status}: ${err.error?.message || JSON.stringify(err).slice(0, 200)}`);
  }
  return await res.json();
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Autenticación
  const authHeader  = req.headers['authorization'] || '';
  const cronSecret  = process.env.CRON_SECRET;
  const syncSecret  = process.env.SYNC_SECRET;
  const isCron      = req.headers['x-vercel-cron'] === '1' || (cronSecret && authHeader === `Bearer ${cronSecret}`);
  const isAuth      = isCron || (syncSecret && authHeader === `Bearer ${syncSecret}`);
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  // Verificar env vars de Gmail
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Faltan env vars GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN' });
  }

  const recipients = req.query.recipients || 'preview';
  const FROM       = process.env.GMAIL_FROM || 'facturacion@patagonica.cl';
  const FILE_ID    = process.env.DRIVE_PLANILLA_ID || DRIVE_PLANILLA_ID_DEFAULT;

  const TO  = recipients === 'contabilidad'
    ? 'bpulgar@patagonica.cl, contabilidad@patagonica.cl'
    : 'amelendez@patagonica.cl, mmunoz@patagonica.cl';
  const CC  = recipients === 'contabilidad' ? 'mmunoz@patagonica.cl, alagies@patagonica.cl, amelendez@patagonica.cl' : '';

  try {
    const periodo = getPeriodo();
    console.log(`[planilla-email] recipients=${recipients} periodo=${periodo} to=${TO}`);

    const token       = await getAccessToken();
    const planillaBuf = await downloadFromDrive(token, FILE_ID);
    const grupos      = extraerComentarios(planillaBuf, periodo);
    const excelBuf    = await generarExcelResumen(planillaBuf, periodo);
    const bodyHtml    = buildBodyHtml(grupos, periodo);
    const subject     = recipients === 'contabilidad'
      ? `Facturación ${periodo}`
      : `[Vista previa] Facturación ${periodo}`;
    const attachName  = `Planilla Facturación ${periodo}.xlsx`;

    await sendEmail(token, TO, CC, FROM, subject, bodyHtml, excelBuf, attachName);
    console.log(`[planilla-email] ✓ Enviado a ${TO}`);
    return res.status(200).json({ ok: true, periodo, recipients: TO });

  } catch (err) {
    console.error('[planilla-email] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
