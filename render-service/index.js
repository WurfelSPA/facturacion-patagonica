/**
 * render-service/index.js
 *
 * Servidor Express en Render.com — sincronización mensual Nubox → Drive.
 *
 * Variables de entorno requeridas:
 *   PORT                 — asignado automáticamente por Render
 *   SYNC_SECRET          — token compartido con n8n y con Vercel
 *   NUBOX_UTN            — token UTN de sesión Nubox
 *   VERCEL_HISTORIAL_URL — URL del endpoint /api/historial en Vercel
 *
 * Endpoints:
 *   GET  /                       — health check
 *   GET  /sync-nubox/status      — estado de env vars
 *   POST /sync-nubox             — sincronización completa (requiere secret)
 */

const express = require('express');
const fetch   = require('node-fetch');
const { scrapeNuboxResumen }  = require('./nubox-scraper');
const { formatearResumenNubox } = require('./excel-parser');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || '';

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'nubox-sync-v2', ts: new Date().toISOString() });
});

// ── Status ────────────────────────────────────────────────────────────────────
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

// ── POST /sync-nubox ──────────────────────────────────────────────────────────
app.post('/sync-nubox', async (req, res) => {
  const start = Date.now();
  console.log('[sync] Iniciando sincronización Nubox —', new Date().toISOString());

  // 1. Autenticación
  const { secret } = req.body || {};
  if (!SECRET || secret !== SECRET) {
    console.warn('[sync] Acceso no autorizado');
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  // 2. Verificar env vars
  if (!process.env.NUBOX_UTN) {
    return res.status(500).json({ ok: false, error: 'Falta NUBOX_UTN' });
  }
  if (!process.env.VERCEL_HISTORIAL_URL) {
    return res.status(500).json({ ok: false, error: 'Falta VERCEL_HISTORIAL_URL' });
  }

  try {
    // 3. Scraping Nubox con Puppeteer
    console.log('[sync] Paso 1: scraping Nubox (Puppeteer)...');
    const scraped = await scrapeNuboxResumen();
    console.log(`[sync] Paso 1 OK — ${scraped.clientes.length} clientes, meses: ${scraped.meses.join(', ')}`);

    if (scraped.clientes.length === 0) {
      return res.status(200).json({
        ok: false,
        warning: 'No se encontraron clientes en el Resumen de Ventas',
        elapsed: Date.now() - start,
      });
    }

    // 4. Formatear datos
    console.log('[sync] Paso 2: formateando datos...');
    const resumen = formatearResumenNubox(scraped);
    console.log(
      `[sync] Paso 2 OK — ${resumen.stats.totalClientes} clientes, ` +
      `total: $${resumen.stats.totalGeneral.toLocaleString('es-CL')}`
    );

    // 5. Guardar en Drive vía endpoint Vercel
    console.log('[sync] Paso 3: guardando en Drive...');
    const saveUrl = process.env.VERCEL_HISTORIAL_URL + '?syncResumen=1';
    const saveResp = await fetch(saveUrl, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-sync-secret':  SECRET,
      },
      body: JSON.stringify({ resumen }),
      timeout: 30000,
    });

    if (!saveResp.ok) {
      const errText = await saveResp.text();
      throw new Error(`VERCEL_ERROR: ${saveResp.status} — ${errText.slice(0, 200)}`);
    }

    const saveResult = await saveResp.json();
    console.log('[sync] Paso 3 OK:', JSON.stringify(saveResult));

    return res.json({
      ok: true,
      clientes:     resumen.stats.totalClientes,
      totalGeneral: resumen.stats.totalGeneral,
      columnas:     resumen._columnas,
      generado:     resumen._generado,
      elapsed:      Date.now() - start,
    });

  } catch (err) {
    console.error('[sync] ERROR:', err.message);
    return res.status(500).json({
      ok:      false,
      error:   err.message,
      elapsed: Date.now() - start,
    });
  }
});

app.listen(PORT, () =>
  console.log(`[sync] Servidor nubox-sync-v2 en puerto ${PORT}`)
);
