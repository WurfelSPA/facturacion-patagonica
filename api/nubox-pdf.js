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

const API  = 'https://api.nubox.com/nubox.api';
const APIV = 'https://api.nubox.com/Nubox.API';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { mes, googleToken, destFolderId } = req.body || {};
  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: 'Se requiere mes en formato YYYY-MM' });
  if (!googleToken) return res.status(400).json({ error: 'Se requiere googleToken' });
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

    const tokenHeaders = {
      'Token': token,
      'Authorization': `Basic ${basicCreds}`,
      ...(partnerKey ? { 'PartnerKey': partnerKey } : {}),
      'Content-Type': 'application/json',
    };

    // ── PASO 2: Listar documentos del período ─────────────────────────────────
    // Intentamos el endpoint de listado por fecha. La URL exacta no está
    // documentada públicamente, probamos variantes comunes.
    let documentos = null;
    const listEndpoints = [
      `${API}/factura/documentos/${pisaRut}/${numeroSerie}?fechaDesde=${encodeURIComponent(fechaDesde)}&fechaHasta=${encodeURIComponent(fechaHasta)}&tipoDocumento=FAC-EL`,
      `${APIV}/factura/documentos/${pisaRut}/${numeroSerie}?fechaDesde=${encodeURIComponent(fechaDesde)}&fechaHasta=${encodeURIComponent(fechaHasta)}`,
      `${API}/factura/documento/${pisaRut}/${numeroSerie}/listar?fechaDesde=${encodeURIComponent(fechaDesde)}&fechaHasta=${encodeURIComponent(fechaHasta)}`,
      `${APIV}/factura/documento/${pisaRut}/${numeroSerie}/listar?fechaDesde=${encodeURIComponent(fechaDesde)}&fechaHasta=${encodeURIComponent(fechaHasta)}`,
    ];

    let listDebug = [];
    for (const url of listEndpoints) {
      console.log(`[nubox] Intentando listar: ${url}`);
      const r = await fetch(url, { headers: tokenHeaders });
      const txt = await r.text();
      listDebug.push({ url, status: r.status, body: txt.substring(0, 200) });
      if (r.ok) {
        try {
          const j = JSON.parse(txt);
          documentos = Array.isArray(j) ? j : (j.data || j.documentos || j.Documentos || j.items || []);
          if (documentos.length > 0) { console.log(`[nubox] Lista OK en: ${url}`); break; }
        } catch { /* no JSON */ }
      }
    }

    if (!documentos || documentos.length === 0) {
      return res.status(404).json({
        error: `No se encontraron documentos para ${mes}. Posiblemente el endpoint de listado necesita ajuste.`,
        intentos: listDebug,
        sugerencia: 'Comparte este error con el soporte de Nubox para obtener la URL exacta del endpoint de listado.',
      });
    }

    console.log(`[nubox] ${documentos.length} documentos encontrados.`);

    // ── PASO 3: Descargar cada PDF ────────────────────────────────────────────
    const pdfBuffers = [];
    for (const doc of documentos) {
      const folio = doc.Folio || doc.folio || doc.NumeroFolio || doc.numeroFolio;
      const tipo  = doc.TipoDocumento || doc.tipoDocumento || doc.Tipo || 'FAC-EL';
      // Los tipos con / deben codificarse: N/C-EL → N%2FC-EL
      const tipoEncoded = tipo.replace(/\//g, '%2F');

      if (!folio) {
        console.warn('[nubox] Documento sin folio:', JSON.stringify(doc).substring(0, 100));
        continue;
      }

      const pdfUrl = `${APIV}/factura/documento/${pisaRut}/${numeroSerie}/${folio}/${tipoEncoded}/pdf`;
      console.log(`[nubox] Descargando PDF folio ${folio}: ${pdfUrl}`);

      const pdfResp = await fetch(pdfUrl, {
        headers: { 'Token': token, ...(partnerKey ? { 'PartnerKey': partnerKey } : {}) },
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

    // ── PASO 5: Subir a Google Drive ──────────────────────────────────────────
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
          'Authorization': `Bearer ${googleToken}`,
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
