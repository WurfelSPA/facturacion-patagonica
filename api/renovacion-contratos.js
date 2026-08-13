/**
 * GET /api/renovacion-contratos
 *
 * Cron automático — corre el día 1 de cada mes.
 *
 * Recorre la Planilla de Facturación (hoja "Flujo") y, para cada cliente,
 * calcula la "Fecha Notificación" (Fecha Término − días de Aviso pactados),
 * igual que la columna homónima de la vista Contratos > Vencimientos.
 *
 * Si esa fecha ya llegó (es decir, cae dentro de este mes o antes) y todavía
 * no se le avisó a ese cliente por ESTE mismo ciclo de renovación (se
 * trackea por rut+sitio+fechaTérmino en renovaciones-notificadas.json), le
 * envía un correo de aviso de renovación automática con copia al equipo.
 *
 * La primera vez que corre, "atrapa" cualquier aviso vencido que quedó sin
 * mandar antes de que este cron existiera — eso es intencional.
 *
 * ✅ EN PRODUCCIÓN (TEST_MODE=false): entrega de verdad al correo del
 * cliente registrado en la Planilla, con copia a alagies@ y mmunoz@.
 * Para volver a modo prueba, cambiar TEST_MODE a true.
 *
 * Env vars requeridas (todas ya existentes en el proyecto):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM
 *   GOOGLE_SERVICE_ACCOUNT   - lectura/escritura de Drive y GitHub
 *   DRIVE_PLANILLA_ID        - id de la Planilla en Drive
 *   GITHUB_TOKEN, GITHUB_REPO - para persistir el tracking de notificados
 *   CRON_SECRET / SYNC_SECRET / ADMIN_SEED_SECRET - autenticación
 */

import XLSX from 'xlsx';

// ═════════════════ Cambiar TEST_MODE a true para volver a modo prueba ═════════════════
const TEST_MODE  = true;
const TEST_DEST  = 'amelendez@patagonica.cl';
// ══════════════════════════════════════════════════════════════════════════════════════

const DRIVE_PLANILLA_ID_DEFAULT = "1yIKK0ZgU5C1ARsD6NIryRlHnom2Qilml";
const TRACKING_FILE = "renovaciones-notificadas.json";
const CC_DEST = ['alagies@patagonica.cl', 'mmunoz@patagonica.cl'];

// ── Gmail OAuth (mismo patrón que recordatorio-pago.js) ──────────────────────
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

// ── Service Account (Drive) — mismo patrón que otros api/*.js ────────────────
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
async function driveDownload(token, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Drive download error ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ── Tracking de notificados vía GitHub API (mismo patrón que nubox-refresh.js) ──
async function githubGetJson(path) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  });
  if (!r.ok) return { data: {}, sha: null };
  const j = await r.json();
  const content = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
  return { data: content, sha: j.sha };
}
async function githubPutJson(path, data, sha, message) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const body = { message, content, ...(sha ? { sha } : {}) };
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GitHub PUT error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── Parseo de fechas / plazos (mismas reglas que el front-end) ──────────────
function serialToDate(v) {
  if (v == null || typeof v !== 'number') return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
}
function fmtDate(d) {
  if (!d) return null;
  return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
}
// "120 dias" → 120 | "cada 3 años" (aviso también puede venir así en planillas viejas)
function parseDiasAviso(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  const m = s.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (s.includes('año') || s.includes('ano')) return n * 365;
  if (s.includes('mes')) return n * 30;
  return n;
}
// "cada 3 años" → {n:3, unit:'year'} | "cada 6 meses" → {n:6, unit:'month'}
function parseRenovacion(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  const m = s.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (s.includes('mes')) ? 'month' : 'year';
  return { n, unit };
}
function sumarPlazo(d, plazo) {
  if (!d || !plazo) return null;
  const r = new Date(d);
  if (plazo.unit === 'month') r.setUTCMonth(r.getUTCMonth() + plazo.n);
  else r.setUTCFullYear(r.getUTCFullYear() + plazo.n);
  return r;
}
function finDeMes(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
}
function rutNorm(r) {
  return String(r || '').replace(/\./g, '').replace(/-/g, '').trim().toLowerCase();
}

// ── Leer clientes desde la Planilla (hoja "Flujo") ───────────────────────────
async function leerClientesPlanilla(saToken) {
  const fileId = process.env.DRIVE_PLANILLA_ID || DRIVE_PLANILLA_ID_DEFAULT;
  const buf = await driveDownload(saToken, fileId);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets['Flujo'];
  if (!ws) throw new Error("Hoja 'Flujo' no encontrada en la Planilla");
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const SKIP = /^(Total|Area|Arrendado|En negociación|Para confirmar|#|\d+$)/;
  const out = [];
  for (let ri = 4; ri < rows.length; ri++) {
    const row = rows[ri]; if (!row) continue;
    const rut = row[9];
    const nombre = row[11] || row[10];
    if (!nombre) continue;
    const name = String(nombre).trim();
    if (/^(VACANTE|Vacante)/.test(name)) continue;
    if (!rut || typeof rut !== 'string' || !rut.match(/\d+\.\d+/)) continue;
    if (SKIP.test(name) || name.includes('Total') || name.startsWith('#') || name === '') continue;
    out.push({
      rut: String(rut).trim(),
      nombre: name,
      sitio: String(row[7] || '').replace(/\s+/g, ' ').trim(),
      edificio: String(row[8] || '').trim(),
      correo: row[12] ? String(row[12]).trim() : '',
      termTermino: serialToDate(row[15]),
      renovacion: row[16] != null ? String(row[16]).trim() : '',
      aviso: row[17] != null ? String(row[17]).trim() : '',
    });
  }
  return out;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Email HTML — mismo estilo visual que recordatorio-pago.js ───────────────
function buildRenovacionHtml({ nombre, sitio, edificio, terminoTxt, renovacion, aviso, nuevoTerminoTxt }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:28px 0"><tr><td align="center"><table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e0e0e0;overflow:hidden"><tr><td style="background:#0f1117;padding:22px 32px"><div style="font-size:18px;font-weight:700;color:#fff">Patagónica Inmobiliaria SpA</div><div style="font-size:11px;color:#7b8299;margin-top:4px">Av. Américo Vespucio 2680, Conchalí, Santiago</div></td></tr><tr><td style="padding:28px 32px">
    <p style="font-size:14px;color:#333;margin:0 0 16px">Estimados señores de ${esc(nombre)}:</p>
    <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px">Junto con saludar, le informamos respecto de su contrato de arrendamiento vigente sobre el inmueble ubicado en el Sitio ${esc(sitio)}${edificio ? ', ' + esc(edificio) : ''}, comuna de Conchalí.</p>
    <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px">Conforme a la cláusula de renovación automática pactada (renovación ${esc(renovacion || 'automática')}, con aviso previo de ${esc(aviso || 'la anticipación pactada')} en caso de término), y no habiendo mediado manifestación de término dentro del plazo correspondiente, le confirmamos que su contrato — cuyo período actual vence el <strong>${esc(terminoTxt)}</strong> — se renovará automáticamente${nuevoTerminoTxt ? ', extendiéndose hasta el <strong>' + esc(nuevoTerminoTxt) + '</strong>' : ''}.</p>
    <p style="font-size:13px;color:#666;margin:0">Quedamos atentos a cualquier consulta o aclaración al respecto.</p>
  </td></tr><tr><td style="background:#f8f8f8;border-top:1px solid #e8e8e8;padding:18px 32px"><p style="font-size:13px;font-weight:600;color:#111;margin:0 0 2px">Administración de Contratos</p><p style="font-size:12px;color:#666;margin:0">Patagónica Inmobiliaria SpA · RUT 96.673.250-4</p><p style="font-size:11px;color:#999;margin:6px 0 0">Correo generado automáticamente.</p></td></tr></table></td></tr></table></body></html>`;
}

// ── MIME crudo CON Cc ─────────────────────────────────────────────────────────
function buildRawEmail(to, cc, from, subject, htmlBody) {
  const fromEncoded = `=?UTF-8?B?${Buffer.from('Patagónica Inmobiliaria').toString('base64')}?= <${from}>`;
  const lines = [
    `From: ${fromEncoded}`,
    `To: ${to}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlBody).toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sendGmail(token, to, cc, from, subject, htmlBody) {
  const raw = buildRawEmail(to, cc, from, subject, htmlBody);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`Gmail ${res.status}: ${err.error?.message || JSON.stringify(err).slice(0, 200)}`); }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const seedSecret = process.env.ADMIN_SEED_SECRET;
  const isCron = req.headers['x-vercel-cron'] === '1' || (cronSecret && authHeader === `Bearer ${cronSecret}`);
  const isAuth = isCron
    || (syncSecret && authHeader === `Bearer ${syncSecret}`)
    || (seedSecret && authHeader === `Bearer ${seedSecret}`)
    || (TEST_MODE && req.query.preview === '1'); // se autodesactiva al pasar TEST_MODE a false
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  const FROM = process.env.GMAIL_FROM || 'facturacion@patagonica.cl';
  const hoy = new Date();
  const limiteMes = finDeMes(hoy);

  try {
    const saToken = await getSAToken('https://www.googleapis.com/auth/drive.readonly');
    const clientes = await leerClientesPlanilla(saToken);
    const { data: tracking, sha } = await githubGetJson(TRACKING_FILE);
    tracking.notificados = tracking.notificados || {};

    const gmailToken = await getGmailToken();

    const detalle = [];
    let enviados = 0;
    let cambios = false;

    for (const c of clientes) {
      if (!c.termTermino) continue;
      const diasAviso = parseDiasAviso(c.aviso);
      if (diasAviso == null) { detalle.push({ ...pick(c), skip: 'sin días de aviso configurados' }); continue; }
      const fechaNotif = new Date(c.termTermino.getTime() - diasAviso * 86400000);
      if (fechaNotif > limiteMes) continue; // aún no le corresponde este ciclo

      const key = `${rutNorm(c.rut)}|${c.sitio}|${c.termTermino.toISOString().slice(0, 10)}`;
      if (tracking.notificados[key]) continue; // ya se le avisó por este mismo vencimiento

      if (!c.correo) { detalle.push({ ...pick(c), fechaNotif: fmtDate(fechaNotif), skip: 'sin correo en planilla' }); continue; }

      const plazo = parseRenovacion(c.renovacion);
      const nuevoTermino = plazo ? sumarPlazo(c.termTermino, plazo) : null;
      const subject = `Renovación automática de contrato — Sitio ${c.sitio}${c.edificio ? ', ' + c.edificio : ''}`;
      const htmlBody = buildRenovacionHtml({
        nombre: c.nombre, sitio: c.sitio, edificio: c.edificio,
        terminoTxt: fmtDate(c.termTermino), renovacion: c.renovacion, aviso: c.aviso,
        nuevoTerminoTxt: fmtDate(nuevoTermino)
      });
      const destinatario = TEST_MODE ? TEST_DEST : c.correo;
      const cc = TEST_MODE ? [] : CC_DEST;

      try {
        await sendGmail(gmailToken, destinatario, cc, FROM, subject, htmlBody);
        detalle.push({ ...pick(c), fechaNotif: fmtDate(fechaNotif), enviadoA: destinatario, cc });
        enviados++;
        if (!TEST_MODE) {
          tracking.notificados[key] = { nombre: c.nombre, sitio: c.sitio, termino: fmtDate(c.termTermino), notificadoEn: new Date().toISOString() };
          cambios = true;
        }
      } catch (e) {
        detalle.push({ ...pick(c), fechaNotif: fmtDate(fechaNotif), error: e.message });
      }
    }

    if (cambios) {
      await githubPutJson(TRACKING_FILE, tracking, sha, `chore: actualizar renovaciones notificadas ${hoy.toISOString().slice(0, 10)}`);
    }

    return res.status(200).json({ ok: true, testMode: TEST_MODE, enviados, revisados: clientes.length, detalle });
  } catch (e) {
    console.error('[renovacion-contratos] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function pick(c) { return { rut: c.rut, nombre: c.nombre, sitio: c.sitio, edificio: c.edificio, termino: fmtDate(c.termTermino) }; }
