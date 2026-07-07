/**
 * render-service/index.js
 *
 * Servidor Express en Render.com — sincronización mensual.
 *
 * Variables de entorno requeridas:
 *   PORT                         — asignado automáticamente por Render
 *   SYNC_SECRET                  — token compartido con n8n y Vercel
 *   NUBOX_UTN                    — token UTN Nubox
 *   VERCEL_HISTORIAL_URL         — URL del endpoint /api/historial en Vercel
 *   BROWSERLESS_TOKEN            — token Browserless.io
 *   AGUAS_ANDINAS_USER           — RUT de acceso al portal Aguas Andinas
 *   AGUAS_ANDINAS_PASS           — Contraseña del portal Aguas Andinas
 *   AGUAS_ANDINAS_DRIVE_FOLDER_ID — ID de la carpeta "agua" en Google Drive
 *   VERCEL_UPLOAD_URL             — URL del endpoint upload-aguas en Vercel
 *
 * Endpoints:
 *   GET  /                         — health check
 *   GET  /sync-nubox/status        — estado de env vars Nubox
 *   POST /sync-nubox               — sincronización Nubox → Drive (requiere secret)
 *   GET  /sync-aguas-andinas/status — estado de env vars Aguas Andinas
 *   POST /sync-aguas-andinas        — descarga boletas + sube a Drive (requiere secret)
 */

const express = require('express');
const fetch   = require('node-fetch');
const { scrapeNuboxResumen }    = require('./nubox-scraper');
const { formatearResumenNubox } = require('./excel-parser');
const { scrapeAguasAndinas }    = require('./aguas-andinas-scraper');
const { uploadBoletas }         = require('./drive-uploader');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || '';

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'patagonica-sync-v3', ts: new Date().toISOString() });
});

// ── Nubox status ──────────────────────────────────────────────────────────────
app.get('/sync-nubox/status', (_req, res) => {
  res.json({
    ok: true,
    env: {
      NUBOX_UTN:            process.env.NUBOX_UTN            ? '✓ set' : '✗ missing',
      SYNC_SECRET:          process.env.SYNC_SECRET          ? '✓ set' : '✗ missing',
      VERCEL_HISTORIAL_URL: process.env.VERCEL_HISTORIAL_URL ? '✓ set' : '✗ missing',
    },
  });
});

// ── Aguas Andinas status ──────────────────────────────────────────────────────
app.get('/sync-aguas-andinas/status', (_req, res) => {
  res.json({
    ok: true,
    env: {
      SYNC_SECRET:                   process.env.SYNC_SECRET                   ? '✓ set' : '✗ missing',
      BROWSERLESS_TOKEN:             process.env.BROWSERLESS_TOKEN             ? '✓ set' : '✗ missing',
      AGUAS_ANDINAS_USER:            process.env.AGUAS_ANDINAS_USER            ? '✓ set' : '✗ missing',
      AGUAS_ANDINAS_PASS:            process.env.AGUAS_ANDINAS_PASS            ? '✓ set' : '✗ missing',
      AGUAS_ANDINAS_DRIVE_FOLDER_ID: process.env.AGUAS_ANDINAS_DRIVE_FOLDER_ID ? '✓ set' : '✗ missing',
      VERCEL_UPLOAD_URL:             process.env.VERCEL_UPLOAD_URL             ? '✓ set' : '✗ missing',
    },
  });
});

// ── POST /sync-nubox ──────────────────────────────────────────────────────────
app.post('/sync-nubox', async (req, res) => {
  const start = Date.now();
  console.log('[nubox] Iniciando sincronización —', new Date().toISOString());

  const { secret } = req.body || {};
  if (!SECRET || secret !== SECRET) {
    console.warn('[nubox] Acceso no autorizado');
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  if (!process.env.NUBOX_UTN) {
    return res.status(500).json({ ok: false, error: 'Falta NUBOX_UTN' });
  }
  if (!process.env.VERCEL_HISTORIAL_URL) {
    return res.status(500).json({ ok: false, error: 'Falta VERCEL_HISTORIAL_URL' });
  }

  try {
    console.log('[nubox] Paso 1: scraping Nubox...');
    const scraped = await scrapeNuboxResumen();
    console.log(`[nubox] Paso 1 OK — ${scraped.clientes.length} clientes`);

    if (scraped.clientes.length === 0) {
      return res.status(200).json({
        ok: false,
        warning: 'No se encontraron clientes',
        elapsed: Date.now() - start,
      });
    }

    console.log('[nubox] Paso 2: formateando...');
    const resumen = formatearResumenNubox(scraped);
    console.log(`[nubox] Paso 2 OK — ${resumen.stats.totalClientes} clientes`);

    console.log('[nubox] Paso 3: guardando en Drive...');
    const saveUrl  = process.env.VERCEL_HISTORIAL_URL + '?syncResumen=1';
    const saveResp = await fetch(saveUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': SECRET },
      body:    JSON.stringify({ resumen }),
      timeout: 30000,
    });

    if (!saveResp.ok) {
      const errText = await saveResp.text();
      throw new Error(`VERCEL_ERROR: ${saveResp.status} — ${errText.slice(0, 200)}`);
    }

    const saveResult = await saveResp.json();
    console.log('[nubox] Paso 3 OK:', JSON.stringify(saveResult));

    return res.json({
      ok: true,
      clientes:     resumen.stats.totalClientes,
      totalGeneral: resumen.stats.totalGeneral,
      elapsed:      Date.now() - start,
    });

  } catch (err) {
    console.error('[nubox] ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message, elapsed: Date.now() - start });
  }
});

// ── POST /sync-aguas-andinas ──────────────────────────────────────────────────
app.post('/sync-aguas-andinas', async (req, res) => {
  const start = Date.now();
  console.log('[aguas] Iniciando sincronización —', new Date().toISOString());

  // Auth
  const { secret } = req.body || {};
  if (!SECRET || secret !== SECRET) {
    console.warn('[aguas] Acceso no autorizado');
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  // Verify env
  const missing = [
    'BROWSERLESS_TOKEN',
    'AGUAS_ANDINAS_USER',
    'AGUAS_ANDINAS_PASS',
    'AGUAS_ANDINAS_DRIVE_FOLDER_ID',
    'VERCEL_UPLOAD_URL',
  ].filter(k => !process.env[k]);

  if (missing.length > 0) {
    return res.status(500).json({ ok: false, error: 'Faltan env vars: ' + missing.join(', ') });
  }

  try {
    // Step 1: Scrape portal
    console.log('[aguas] Paso 1: scraping portal Aguas Andinas...');
    const scraped = await scrapeAguasAndinas();
    console.log(`[aguas] Paso 1 OK — ${scraped.total} boletas, ${scraped.failures} fallos`);

    if (scraped.results.length === 0) {
      return res.status(200).json({
        ok:      false,
        warning: 'No se descargaron boletas',
        failures: scraped.failureList,
        elapsed: Date.now() - start,
      });
    }

    // Step 2: Upload to Drive
    console.log('[aguas] Paso 2: subiendo PDFs a Google Drive...');
    const driveResult = await uploadBoletas(scraped.results);
    console.log(
      `[aguas] Paso 2 OK — ${driveResult.uploaded.length} subidos, ` +
      `${driveResult.errors.length} errores Drive`
    );

    return res.json({
      ok:             true,
      scraped:        scraped.total,
      scrapeFailures: scraped.failures,
      uploaded:       driveResult.uploaded.length,
      uploadErrors:   driveResult.errors.length,
      uploadedFiles:  driveResult.uploaded.map(u => ({ name: u.filename, skipped: u.skipped || false })),
      elapsed:        Date.now() - start,
    });

  } catch (err) {
    console.error('[aguas] ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message, elapsed: Date.now() - start });
  }
});

app.listen(PORT, () =>
  console.log(`[sync] Servidor patagonica-sync-v3 en puerto ${PORT}`)
);
