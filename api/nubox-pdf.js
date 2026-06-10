/**
 * /api/nubox-pdf
 *
 * Descarga todas las facturas PISA del período usando la Nubox Partner API,
 * las une en un solo PDF con pdf-lib y sube el resultado a Google Drive.
 *
 * Variables de entorno (Vercel):
 *   NUBOX_PISA_USER     — Usuario API (ej: QE710sHnJCrt)
 *   NUBOX_PISA_PASS     — Contraseña API
 *   NUBOX_PARTNER_TOKEN — PartnerKey (sk_live_...)
 *   NUBOX_PISA_RUT      — RUT empresa sin DV (ej: 96673250)
 *   NUBOX_PISA_RUT_DV   — DV del RUT (ej: 4)
 *
 * POST body (JSON):
 *   mes          — YYYY-MM
 *   googleToken  — OAuth access token Drive
 *   destFolderId — carpeta Drive destino
 */

import { PDFDocument } from 'pdf-lib';

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
  const jwt = await signJWT({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }, sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const data = await res.json();
  if (!data.access_token) throw new Error("SA token error: " + JSON.stringify(data));
  return data.access_token;
}

const API    = 'https://api.nubox.com/nubox.api';
const APIV   = 'https://api.nubox.com/Nubox.API';
const APIV1  = 'https://api.pyme.nubox.com/nbxpymapi-environment-pyme';

// ── Handler legado nubox-pisa (GET ?utn=...&mes=YYYY-MM) ─────────────────────
async function handlePisa(req, res) {
  const { mes, utn } = req.query;
  if (!utn) return res.status(400).json({ error: 'Se requiere el parámetro utn' });
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Se requiere mes en formato YYYY-MM' });
  const [year, month] = mes.split('-');
  const fechaDesde = `01/${month}/${year}`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaHasta = `${String(lastDay).padStart(2,'0')}/${month}/${year}`;
  const BASE = 'https://app.nubox.com';
  const H = { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language':'es-CL,es;q=0.9' };
  try {
    const p1 = await fetch(`${BASE}/ServiFactura/paginas/dtePrincipal.aspx?utn=${encodeURIComponent(utn)}`, { headers:H, redirect:'follow' });
    const rawCookies = p1.headers.getSetCookie ? p1.headers.getSetCookie() : (p1.headers.get('set-cookie')?[p1.headers.get('set-cookie')]:[]);
    const cookieHeader = rawCookies.map(c=>c.split(';')[0]).join('; ');
    const dtePage = `${BASE}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;
    const dteRes = await fetch(dtePage, { headers:{...H,Cookie:cookieHeader}, redirect:'follow' });
    const html = await dteRes.text();
    const tokenMatch = html.match(/var\s+token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/) || html.match(/"token"\s*:\s*"([A-Za-z0-9+/=]{20,})"/) || html.match(/token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/);
    if (!tokenMatch) return res.status(500).json({ error:'No se pudo extraer el token. El utn puede haber expirado.', htmlSnippet:html.substring(0,800) });
    const token = tokenMatch[1];
    const funcMatch = html.match(/funcionarioId\s*[=:]\s*["']?(\d{4,})["']?/) || html.match(/"funcionarioId"\s*:\s*"(\d+)"/);
    const funcionarioId = funcMatch ? funcMatch[1] : '339708';
    const filtroRes = await fetch(`${dtePage}/ObtenerPorFiltro`, { method:'POST', headers:{...H,'Content-Type':'application/json; charset=utf-8',Cookie:cookieHeader,Referer:dtePage}, body:JSON.stringify({token,EstadoId:3,estadoEnvio:0,fechaDesde,fechaHasta,filtro:'<Terminos></Terminos>',folioDesde:0,folioHasta:0,usaFormatoImpresionEspecial:false}) });
    if (!filtroRes.ok) return res.status(502).json({ error:`ObtenerPorFiltro ${filtroRes.status}`, body:await filtroRes.text() });
    const filtroInner = JSON.parse((await filtroRes.json()).d);
    const documentos = filtroInner.data || [];
    if (documentos.length === 0) return res.status(404).json({ error:`No se encontraron documentos para ${mes}` });
    const ids = documentos.map(d=>d.Id).join(',');
    const pdfRes = await fetch(`${dtePage}/VerPDF`, { method:'POST', headers:{...H,'Content-Type':'application/json; charset=utf-8',Cookie:cookieHeader,Referer:dtePage}, body:JSON.stringify({token,funcionarioId,id:ids}) });
    if (!pdfRes.ok) return res.status(502).json({ error:`VerPDF ${pdfRes.status}`, body:await pdfRes.text() });
    const pdfPath = (await pdfRes.json()).d;
    return res.status(200).json({ ok:true, pdfUrl:`${BASE}${pdfPath}`, total:filtroInner.total?.[0]?.Total??documentos.length, mes, fechaDesde, fechaHasta });
  } catch(err) { return res.status(500).json({ error:err.message }); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // GET con utn → flujo legado nubox-pisa
  if (req.method === 'GET') return handlePisa(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { mes, destFolderId } = req.body || {};
  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: 'Se requiere mes en formato YYYY-MM' });
  if (!destFolderId) return res.status(400).json({ error: 'Se requiere destFolderId' });

  const nuboxUser   = process.env.NUBOX_API_USER;
  const nuboxPass   = process.env.NUBOX_API_PASS;
  const partnerKey  = process.env.NUBOX_PARTNER_TOKEN;
  const pisaRutNum  = (process.env.NUBOX_PISA_RUT || '96673250').replace(/[^0-9]/g, '');
  const pisaRutDV   = process.env.NUBOX_PISA_RUT_DV || '4';
  const pisaRut     = `${pisaRutNum}-${pisaRutDV}`;  // ej: 96673250-4

  if (!nuboxUser || !nuboxPass)
    return res.status(500).json({ error: 'Faltan NUBOX_API_USER o NUBOX_API_PASS en variables de entorno.' });

  const [year, month] = mes.split('-');
  const lastDay   = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaDesde = `01/${month}/${year}`;
  const fechaHasta = `${String(lastDay).padStart(2,'0')}/${month}/${year}`;

  try {
    // ── PASO 1: Autenticación ─────────────────────────────────────────────────
    console.log('[nubox] Autenticando via Partner API...');
    const basicCreds = Buffer.from(`${nuboxUser}:${nuboxPass}`).toString('base64');

    const authResp = await fetch(`${API}/autenticar`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicCreds}`,
        'Content-Type': 'application/json',
        ...(partnerKey ? { 'PartnerKey': partnerKey } : {}),
      },
    });

    if (!authResp.ok) {
      const body = await authResp.text();
      return res.status(401).json({
        error: `Auth respondió ${authResp.status}`,
        detail: body.substring(0, 400),
        hint: 'Revisa NUBOX_PISA_USER y NUBOX_PISA_PASS en Vercel.',
      });
    }

    // Token viene en el header de respuesta (no en el body)
    const token = authResp.headers.get('Token') || authResp.headers.get('token') || '';
    const authBody = await authResp.json().catch(() => []);

    if (!token)
      return res.status(401).json({
        error: 'Auth no devolvió Token en el header de respuesta.',
        authBodySample: JSON.stringify(authBody).substring(0, 300),
        headers: Object.fromEntries([...authResp.headers.entries()]),
      });

    // NumeroSerie del sistema PISA (viene en el body de auth)
    const sistemas = Array.isArray(authBody) ? authBody : (authBody.sistemas || authBody.Sistemas || [authBody]);
    // Preferir SERVIFACTURA (facturación electrónica); filtrar por RUT PISA
    const sistema  =
      sistemas.find(s => s.Sistema === 'SERVIFACTURA' && String(s.Rut) === pisaRutNum) ||
      sistemas.find(s => String(s.Rut) === pisaRutNum) ||
      sistemas.find(s => s.Sistema === 'SERVIFACTURA') ||
      sistemas[0];
    const numeroSerie = sistema?.NumeroDeSerie || sistema?.NumeroSerie || sistema?.numeroSerie || sistema?.NumSerie;

    if (!numeroSerie)
      return res.status(500).json({
        error: 'No se encontró NumeroSerie en la respuesta de auth.',
        sistemas: sistemas.slice(0, 3),
      });

    console.log(`[nubox] Auth OK. Token obtenido. NumeroSerie: ${numeroSerie}`);

    // Headers para Partner API v1 (Bearer obligatorio)
    const v1Headers = {
      'Authorization': `Bearer ${partnerKey}`,
      'X-Api-Key': process.env.NUBOX_PISA_API_KEY,
      'Content-Type': 'application/json',
    };

    // ── PASO 2: GET /v1/sales?period=YYYY-MM ──────────────────────────────────
    console.log(`[nubox] Listando ventas: ${APIV1}/v1/sales?period=${mes}`);
    const salesResp = await fetch(`${APIV1}/v1/sales?period=${mes}`, { headers: v1Headers });
    const salesTxt  = await salesResp.text();
    console.log(`[nubox] /v1/sales status: ${salesResp.status}, body: ${salesTxt.substring(0, 300)}`);

    if (!salesResp.ok) {
      return res.status(502).json({
        error: `GET /v1/sales respondió ${salesResp.status}`,
        detail: salesTxt.substring(0, 500),
      });
    }

    const salesJson = JSON.parse(salesTxt);
    const documentos = Array.isArray(salesJson)
      ? salesJson
      : (salesJson.data || salesJson.items || salesJson.sales || []);

    if (documentos.length === 0)
      return res.status(404).json({ error: `Sin documentos de venta para ${mes}.` });

    console.log(`[nubox] ${documentos.length} documentos encontrados.`);

    // ── PASO 3: Descargar cada PDF ────────────────────────────────────────────
    const pdfBuffers = [];
    for (const doc of documentos) {
      const docId = doc.id || doc.documentId || doc.Id || doc.documentID;

      if (!docId) {
        console.warn('[nubox] Documento sin id:', JSON.stringify(doc).substring(0, 100));
        continue;
      }

      const pdfUrl = `${APIV1}/v1/sales/${docId}/pdf`;
      console.log(`[nubox] Descargando PDF id ${docId}`);

      const pdfResp = await fetch(pdfUrl, {
        headers: {
          'Authorization': `Bearer ${partnerKey}`,
          'X-Api-Key': process.env.NUBOX_PISA_API_KEY,
        },
      });

      if (!pdfResp.ok) {
        console.warn(`[nubox] PDF folio ${folio} respondió ${pdfResp.status}, omitiendo.`);
        continue;
      }

      const buf = Buffer.from(await pdfResp.arrayBuffer());
      pdfBuffers.push(buf);
      console.log(`[nubox] PDF folio ${folio} OK (${buf.length} bytes)`);
    }

    if (pdfBuffers.length === 0)
      return res.status(404).json({ error: 'No se pudo descargar ningún PDF para el período.' });

    // ── PASO 4: Unir PDFs ─────────────────────────────────────────────────────
    console.log(`[nubox] Uniendo ${pdfBuffers.length} PDFs...`);
    const merged = await PDFDocument.create();
    for (const buf of pdfBuffers) {
      try {
        const src   = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const page of pages) merged.addPage(page);
      } catch (e) {
        console.warn('[nubox] Error procesando un PDF, omitiendo:', e.message);
      }
    }
    const pdfBuffer = Buffer.from(await merged.save());
    const fileName  = `Facturas_PISA_${mes}.pdf`;
    console.log(`[nubox] PDF unificado: ${pdfBuffer.length} bytes (${merged.getPageCount()} páginas)`);

    // ── PASO 5: Subir a Google Drive con Service Account ─────────────────────
    const saToken   = await getSAToken();
    const metadata  = JSON.stringify({ name: fileName, mimeType: 'application/pdf', parents: [destFolderId] });
    const boundary  = 'nubox_pdf_boundary';
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      pdfBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const uploadResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${saToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      }
    );

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return res.status(502).json({ error: `Drive upload respondió ${uploadResp.status}`, detail: errText.substring(0, 300) });
    }

    const uploadJson = await uploadResp.json();
    return res.status(200).json({
      ok: true,
      fileId: uploadJson.id,
      fileName,
      total: documentos.length,
      pages: merged.getPageCount(),
      mes,
    });

  } catch (err) {
    console.error('[nubox] Error:', err);
    return res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
}
