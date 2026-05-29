/**
 * /api/nubox-pdf
 *
 * Descarga todas las facturas PISA del período usando la Nubox Partner API,
 * las une en un solo PDF con pdf-lib y sube el resultado a Google Drive.
 *
 * Variables de entorno (Vercel):
 *   NUBOX_PARTNER_TOKEN  — Bearer token de la Partner API
 *   NUBOX_PISA_API_KEY   — X-Api-Key para la empresa PISA
 *
 * POST body (JSON):
 *   mes          — YYYY-MM
 *   googleToken  — OAuth access token Drive
 *   destFolderId — carpeta Drive destino
 */

import { PDFDocument } from 'pdf-lib';

const API_BASE = 'https://api.pyme.nubox.com/nbxpymapi-environment-pyme';

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

  const partnerToken = process.env.NUBOX_PARTNER_TOKEN;
  const apiKey       = process.env.NUBOX_PISA_API_KEY;
  if (!partnerToken || !apiKey)
    return res.status(500).json({ error: 'Faltan NUBOX_PARTNER_TOKEN o NUBOX_PISA_API_KEY en variables de entorno.' });

  const authHeaders = {
    'Authorization': `Bearer ${partnerToken}`,
    'X-Api-Key': apiKey,
    'Accept': 'application/json',
  };

  try {
    // ── PASO 1: Listar documentos del período ─────────────────────────────────
    console.log(`[nubox] Obteniendo facturas para período ${mes}...`);
    const listResp = await fetch(
      `${API_BASE}/v1/sales?period=${mes}&size=200`,
      { headers: authHeaders }
    );

    if (!listResp.ok) {
      const errText = await listResp.text();
      return res.status(502).json({
        error: `Partner API /v1/sales respondió ${listResp.status}`,
        detail: errText.substring(0, 400),
      });
    }

    const listData = await listResp.json();

    // La API puede devolver { data: [...] } o directamente un array
    const documentos = Array.isArray(listData) ? listData : (listData.data || listData.items || listData.sales || []);

    if (documentos.length === 0)
      return res.status(404).json({ error: `Sin facturas PISA para ${mes}` });

    console.log(`[nubox] ${documentos.length} documentos encontrados.`);

    // ── PASO 2: Descargar cada PDF individualmente ────────────────────────────
    const pdfBuffers = [];
    for (const doc of documentos) {
      const docId = doc.id || doc.documentId || doc.Id || doc.folio;
      if (!docId) {
        console.warn('[nubox] Documento sin ID, omitiendo:', JSON.stringify(doc).substring(0, 100));
        continue;
      }

      const pdfResp = await fetch(
        `${API_BASE}/v1/sales/${docId}/pdf`,
        { headers: { ...authHeaders, Accept: 'application/pdf,*/*' } }
      );

      if (!pdfResp.ok) {
        console.warn(`[nubox] PDF para ${docId} respondió ${pdfResp.status}, omitiendo.`);
        continue;
      }

      const buf = Buffer.from(await pdfResp.arrayBuffer());
      pdfBuffers.push(buf);
      console.log(`[nubox] PDF ${docId} descargado (${buf.length} bytes)`);
    }

    if (pdfBuffers.length === 0)
      return res.status(404).json({ error: 'No se pudo descargar ningún PDF para el período indicado.' });

    // ── PASO 3: Unir todos los PDFs en uno solo ───────────────────────────────
    console.log(`[nubox] Uniendo ${pdfBuffers.length} PDFs...`);
    const merged = await PDFDocument.create();

    for (const buf of pdfBuffers) {
      try {
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const page of pages) merged.addPage(page);
      } catch (e) {
        console.warn('[nubox] Error al procesar un PDF, omitiendo:', e.message);
      }
    }

    const mergedBytes = await merged.save();
    const pdfBuffer = Buffer.from(mergedBytes);
    const fileName  = `Facturas_PISA_${mes}.pdf`;

    console.log(`[nubox] PDF unificado: ${pdfBuffer.length} bytes (${merged.getPageCount()} páginas)`);

    // ── PASO 4: Subir a Google Drive ──────────────────────────────────────────
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
          Authorization: `Bearer ${googleToken}`,
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
