/**
 * GET /api/recordatorio-pago?trigger=dia20|fin-mes
 *
 * Cron automático:
 *   - Día 20 de cada mes  → trigger=dia20  (siempre corre)
 *   - Último día del mes  → trigger=fin-mes (se programa días 28-31, pero
 *     solo actúa si el día siguiente es 1 — es decir, si HOY es realmente
 *     el último día del mes)
 *
 * Envía un recordatorio de pago individual (sin CC/BCC) a cada cliente con
 * deuda pendiente en "Facturas x Cobrar PISA", usando el correo registrado
 * en la Planilla de facturación.
 *
 * ⚠️ MODO PRUEBA ACTIVO (ver constantes TEST_MODE/TEST_DEST/TEST_LIMIT más
 * abajo): mientras TEST_MODE=true, solo se envía a TEST_LIMIT cliente(s) y
 * el destinatario real se reemplaza por TEST_DEST. Para producción, cambiar
 * TEST_MODE a false.
 *
 * Env vars requeridas (todas ya existentes en el proyecto):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM
 *   GOOGLE_SERVICE_ACCOUNT   - lectura de Drive (Planilla y F x Cobrar)
 *   DRIVE_PLANILLA_ID        - id de la Planilla en Drive
 *   CRON_SECRET / SYNC_SECRET / ADMIN_SEED_SECRET - autenticación
 */

import XLSX from 'xlsx';

// ═════════════════ MODO PRUEBA — cambiar TEST_MODE a false cuando esté listo ═════════════════
const TEST_MODE  = true;
const TEST_DEST  = 'facturacion@patagonica.cl';
const TEST_LIMIT = 1;
// ══════════════════════════════════════════════════════════════════════════════════════════════

const DRIVE_FACTURACION_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";
const DRIVE_PLANILLA_ID_DEFAULT   = "1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml";

// ── Gmail OAuth (mismo patrón que planilla-email.js) ─────────────────────────
async function getGmailToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error('OAuth2 Gmail error: ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth2 Gmail: sin access_token');
  return data.access_token;
}

// ── Service Account (lectura Drive) — mismo patrón que otros api/*.js ────────
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
async function getSAToken(scope) {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT(
    { iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 },
    sa.private_key
  );
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token error: " + JSON.stringify(d));
  return d.access_token;
}

async function driveListFolder(token, folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (!r.ok) throw new Error('Drive list error: ' + JSON.stringify(d));
  return d.files || [];
}
async function driveDownload(token, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Drive download error ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function rutNorm(r) { return String(r || '').replace(/\./g, '').replace(/-/g, '').trim().toLowerCase(); }

// ── Deuda por cliente desde "Facturas x Cobrar PISA" (misma lógica que la vista de la app) ──
function parseFacturasPorCobrarBase(values) {
  if (!values || values.length < 2) return [];
  const hdr = values[0].map(h => String(h || '').toLowerCase().replace(/[\r\n\s_]/g, ''));
  function fi(tests) { for (let i = 0; i < hdr.length; i++) for (const t of tests) if (hdr[i].includes(t)) return i; return -1; }
  const iCod = fi(['cod']) >= 0 ? fi(['cod']) : 3;
  const iCliente = fi(['cliente']) >= 0 ? fi(['cliente']) : 4;
  const iMonto = fi(['monto', 'c/d(ml)', 'c/d(m']) >= 0 ? fi(['monto', 'c/d(ml)', 'c/d(m']) : 13;
  const iSdo = fi(['sdo', 'vencido']) >= 0 ? fi(['sdo', 'vencido']) : 14;
  function n(v) { return parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0; }
  return values.slice(1)
    .filter(r => r.length > 4 && String(r[iCliente] || '').trim() !== '' && String(r[iCliente] || '').trim() !== 'Cliente')
    .map(r => ({ rut: String(r[iCod] || '').trim(), cliente: String(r[iCliente] || '').trim(), monto: n(r[iMonto]), sdoVencido: n(r[iSdo]) }))
    .filter(r => r.monto > 0 || r.sdoVencido > 0);
}

async function obtenerDeudaPorCliente(saToken) {
  const raiz = await driveListFolder(saToken, DRIVE_FACTURACION_FOLDER_ID);
  const carpeta = raiz.find(f => f.name.toLowerCase().includes('cobrar') && (f.mimeType || '').includes('folder'));
  if (!carpeta) throw new Error('No se encontró la carpeta "Facturas x Cobrar"');
  const archivos = await driveListFolder(saToken, carpeta.id);
  function dateKey(name) { const m = name.match(/(\d{2})-(\d{2})-(\d{4})/); return m ? m[3] + m[2] + m[1] : name; }
  const xlsxs = archivos.filter(f => f.name.toLowerCase().endsWith('.xlsx')).sort((a, b) => dateKey(a.name).localeCompare(dateKey(b.name)));
  if (!xlsxs.length) throw new Error('No se encontró ningún archivo "F x Cobrar Pisa"');
  const ultimo = xlsxs[xlsxs.length - 1];
  const buf = await driveDownload(saToken, ultimo.id);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['Base'] || wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const rows = parseFacturasPorCobrarBase(raw);
  const porRut = {};
  for (const r of rows) {
    const key = rutNorm(r.rut);
    if (!key) continue;
    if (!porRut[key]) porRut[key] = { total: 0, nombre: r.cliente };
    porRut[key].total += r.monto;
  }
  return { porRut, archivo: ultimo.name };
}

// ── Mapa RUT → correo desde la Planilla (hoja "Flujo") ────────────────────────
async function obtenerCorreosPlanilla(saToken) {
  const fileId = process.env.DRIVE_PLANILLA_ID || DRIVE_PLANILLA_ID_DEFAULT;
  const buf = await driveDownload(saToken, fileId);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['Flujo'];
  if (!ws) throw new Error("Hoja 'Flujo' no encontrada en la Planilla");
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const mapa = {};
  for (let r = 4; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const cliente = row[11], correo = row[12], rut = row[9];
    if (!cliente || !rut) continue;
    const key = rutNorm(rut);
    if (!mapa[key]) mapa[key] = { nombre: String(cliente).trim(), correo: correo ? String(correo).trim() : '' };
  }
  return mapa;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Email HTML — mismo estilo visual que buildEmailHtml() del cliente ────────
function buildRecordatorioHtml(nombreCliente) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:28px 0"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e0e0e0;overflow:hidden"><tr><td style="background:#0f1117;padding:22px 32px"><div style="font-size:18px;font-weight:700;color:#fff">Patagónica Inmobiliaria SpA</div><div style="font-size:11px;color:#7b8299;margin-top:4px">Av. Américo Vespucio 2680, Conchalí, Santiago</div></td></tr><tr><td style="padding:28px 32px">
    <p style="font-size:14px;color:#333;margin:0 0 16px">Estimado(a) ${nombreCliente ? esc(nombreCliente) : 'cliente'},</p>
    <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px">Junto con saludar, le recordamos que registra factura(s) pendiente(s) de pago con Patagónica Inmobiliaria SpA.</p>
    <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 20px">Le solicitamos regularizar el pago a la brevedad, y enviar el comprobante correspondiente a <a href="mailto:facturacion@patagonica.cl" style="color:#2563eb">facturacion@patagonica.cl</a> y <a href="mailto:contabilidad@patagonica.cl" style="color:#2563eb">contabilidad@patagonica.cl</a>.</p>
    <p style="font-size:13px;color:#666;margin:0">Quedamos atentos a cualquier consulta.</p>
  </td></tr><tr><td style="background:#f8f8f8;border-top:1px solid #e8e8e8;padding:18px 32px"><p style="font-size:13px;font-weight:600;color:#111;margin:0 0 2px">Área de Administración</p><p style="font-size:12px;color:#666;margin:0">Patagónica Inmobiliaria SpA · RUT 96.673.250-4</p><p style="font-size:11px;color:#999;margin:6px 0 0">Correo generado automáticamente.</p></td></tr></table></td></tr></table></body></html>`;
}

// ── Enviar (sin CC/BCC) ────────────────────────────────────────────────────────
async function sendGmailSimple(token, to, from, subject, htmlBody) {
  const fromEncoded = `=?UTF-8?B?${Buffer.from('Patagónica Inmobiliaria').toString('base64')}?= <${from}>`;
  const lines = [
    `From: ${fromEncoded}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlBody).toString('base64'),
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`Gmail ${res.status}: ${err.error?.message || JSON.stringify(err).slice(0, 200)}`); }
  return res.json();
}

function esUltimoDiaDelMes(d) {
  const t = new Date(d); t.setDate(t.getDate() + 1);
  return t.getDate() === 1;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const seedSecret = process.env.ADMIN_SEED_SECRET; // reutilizado solo para pruebas manuales
  const isCron = req.headers['x-vercel-cron'] === '1' || (cronSecret && authHeader === `Bearer ${cronSecret}`);
  const isAuth = isCron
    || (syncSecret && authHeader === `Bearer ${syncSecret}`)
    || (seedSecret && authHeader === `Bearer ${seedSecret}`);
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  const trigger = req.query.trigger || 'dia20';
  if (trigger === 'fin-mes' && !esUltimoDiaDelMes(new Date()) && !req.query.force) {
    return res.status(200).json({ ok: true, skip: 'hoy no es el último día del mes' });
  }

  const FROM = process.env.GMAIL_FROM || 'facturacion@patagonica.cl';

  try {
    const saToken = await getSAToken('https://www.googleapis.com/auth/drive.readonly');
    const [{ porRut, archivo }, correos] = await Promise.all([
      obtenerDeudaPorCliente(saToken),
      obtenerCorreosPlanilla(saToken)
    ]);

    const gmailToken = await getGmailToken();

    const detalle = [];
    let enviados = 0;
    for (const [rut, deuda] of Object.entries(porRut)) {
      if (!(deuda.total > 0)) continue;
      const info = correos[rut];
      const nombre = info?.nombre || deuda.nombre;
      const correoReal = info?.correo || '';
      if (!correoReal) { detalle.push({ rut, nombre, skip: 'sin correo en planilla' }); continue; }
      if (TEST_MODE && enviados >= TEST_LIMIT) { detalle.push({ rut, nombre, skip: 'omitido — modo prueba' }); continue; }

      const destinatario = TEST_MODE ? TEST_DEST : correoReal;
      try {
        await sendGmailSimple(gmailToken, destinatario, FROM, 'Recordatorio de pago pendiente — Patagónica Inmobiliaria', buildRecordatorioHtml(nombre));
        detalle.push({ rut, nombre, enviadoA: destinatario, deudaTotal: Math.round(deuda.total) });
        enviados++;
      } catch (e) {
        detalle.push({ rut, nombre, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true, trigger, testMode: TEST_MODE, archivoDeuda: archivo,
      enviados, clientesConDeuda: Object.keys(porRut).filter(k => porRut[k].total > 0).length,
      detalle
    });
  } catch (e) {
    console.error('[recordatorio-pago] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
