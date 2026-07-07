/**
 * render-service/drive-uploader.js
 *
 * Delega la subida de PDFs a Google Drive al endpoint Vercel /api/upload-aguas,
 * que ya tiene las credenciales de la cuenta de servicio configuradas.
 *
 * Env vars requeridas:
 *   VERCEL_UPLOAD_URL — URL completa del endpoint (ej: https://facturacion-patagonica.vercel.app/api/upload-aguas)
 *   SYNC_SECRET       — token de autenticación compartido
 */

const fetch = require('node-fetch');

const BATCH_SIZE = 5; // ~5 × 150KB × 1.33 base64 ≈ 1MB por batch, bien bajo el límite Vercel

async function uploadBoletas(boletas) {
  const uploadUrl = process.env.VERCEL_UPLOAD_URL;
  const secret    = process.env.SYNC_SECRET || '';

  if (!uploadUrl) throw new Error('Falta VERCEL_UPLOAD_URL');
  if (!secret)    throw new Error('Falta SYNC_SECRET');

  const uploaded = [];
  const errors   = [];

  // Procesar en batches para respetar límite de 10MB en Vercel
  for (let i = 0; i < boletas.length; i += BATCH_SIZE) {
    const batch     = boletas.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(boletas.length / BATCH_SIZE);

    console.log(`[drive] Batch ${batchNum}/${totalBatches} — ${batch.length} boletas`);

    try {
      const resp = await fetch(uploadUrl, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-sync-secret':  secret,
        },
        body:    JSON.stringify({ boletas: batch }),
        timeout: 120000, // 2 min por batch
      });

      if (!resp.ok) {
        const txt = await resp.text();
        const msg = `HTTP ${resp.status}: ${txt.slice(0, 200)}`;
        console.error('[drive] Batch error:', msg);
        batch.forEach(b => errors.push({ nroFactura: b.nroFactura, error: msg }));
        continue;
      }

      const result = await resp.json();
      console.log(`[drive] Batch ${batchNum} OK — subidos: ${result.uploaded}, errores: ${result.errors}`);

      if (result.uploadedFiles) uploaded.push(...result.uploadedFiles);
      if (result.errorList)     errors.push(...result.errorList);

    } catch (err) {
      console.error('[drive] Batch', batchNum, 'excepción:', err.message);
      batch.forEach(b => errors.push({ nroFactura: b.nroFactura, error: err.message }));
    }
  }

  return { uploaded, errors };
}

module.exports = { uploadBoletas };
