/**
 * render-service/index.js
 *
 * Servidor Express corriendo en Render.com
 * Endpoint principal: POST /sync-nubox
 *
 * Flujo:
 *   1. n8n llama POST /sync-nubox { mes: "YYYY-MM", secret: "..." }
 *   2. Scraper hace login en Nubox via Browserless.io → obtiene cookies
 *   3. Intenta descargar Excel de reportería del mes (o usa lista de docs como fallback)
 *   4. Parser convierte datos → formato historial-facturas.json
 *   5. POST al endpoint Vercel /api/historial para guardar en Drive
 *   6. Responde con resultado { ok, stats }
 *
 * Variables de entorno requeridas (configurar en Render dashboard):
 *   PORT                  — puerto (Render lo asigna automáticamente)
 *   SYNC_SECRET           — token compartido para autenticar el trigger de n8n
 *   NUBOX_RUT             — RUT de login Nubox, ej: "12.345.678-9"
 *   NUBOX_PASSWORD        — Contraseña Nubox
 *   BROWSERLESS_TOKEN     — API token de browserless.io
 *   VERCEL_HISTORIAL_URL  — URL completa del endpoint, ej: "https://facturacion-patagonica.vercel.app/api/historial"
 */

const express = require('express');
const { scrapeNubox } = require('./nubox-scraper');
const { procesarNuboxData } = require('./excel-parser');

const app = express();
app.use(express.json());

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || '';

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'nubox-sync', ts: new Date().toISOString() });
});

// ── POST /sync-nubox ──────────────────────────────────────────────────────────
app.post('/sync-nubox', async (req, res) => {
  const start = Date.now();
  console.log('[sync] Iniciando sincronización Nubox —', new Date().toISOString());

  // 1. Autenticación
  const { secret, mes } = req.body || {};
  if (!SECRET || secret !== SECRET) {
    console.warn('[sync] Acceso no autorizado');
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  // 2. Validar mes
  const mesTarget = mes || _mesAnterior();
  if (!/^\d{4}-\d{2}$/.test(mesTarget)) {
    return res.status(400).json({ ok: false, error: 'mes debe ser "YYYY-MM"' });
  }

  // 3. Variables de entorno — acepta cookies almacenadas O login via Browserless
  const usaCookies = !!(process.env.NUBOX_SESSION_COOKIES && process.env.NUBOX_UTN);
  const usaBrowserless = !!(process.env.NUBOX_RUT && process.env.NUBOX_PASSWORD && process.env.BROWSERLESS_TOKEN);
  if (!usaCookies && !usaBrowserless) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno: configura NUBOX_SESSION_COOKIES + NUBOX_UTN (recomendado) o NUBOX_RUT + NUBOX_PASSWORD + BROWSERLESS_TOKEN' });
  }
  if (!process.env.VERCEL_HISTORIAL_URL) {
    return res.status(500).json({ ok: false, error: 'Falta VERCEL_HISTORIAL_URL' });
  }

  try {
    // 4. Scraping Nubox
    console.log(`[sync] Paso 1: scraping Nubox para mes ${mesTarget}`);
    const { excelBuffer, documentos } = await scrapeNubox(mesTarget);

    console.log(`[sync] Paso 1 OK — docs: ${documentos.length}, excel: ${excelBuffer ? excelBuffer.length + ' bytes' : 'null'}`);

    // 5. Parsear datos
    console.log('[sync] Paso 2: parseando datos');
    const historial = procesarNuboxData({ excelBuffer, documentos, mes: mesTarget });

    console.log(`[sync] Paso 2 OK — ${historial.stats.totalClientes} clientes, ${historial.stats.totalRegistros} facturas`);
    console.log('[sync] Período:', historial.periodo);

    if (historial.stats.totalClientes === 0) {
      return res.status(200).json({
        ok: false,
        warning: 'No se encontraron facturas para el período',
        mes: mesTarget,
        periodo: historial.periodo,
        stats: historial.stats,
        elapsed: Date.now() - start,
      });
    }

    // 6. Enviar a Vercel /api/historial
    console.log('[sync] Paso 3: guardando en Vercel /api/historial');
    const payload = {
      anio:    historial.anio,
      periodo: historial.periodo,
      data:    historial.data,
    };

    const saveResp = await fetch(process.env.VERCEL_HISTORIAL_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const saveText = await saveResp.text();
    let saveJson = null;
    try { saveJson = JSON.parse(saveText); } catch(_) {}

    if (!saveResp.ok) {
      console.error('[sync] Error guardando historial:', saveResp.status, saveText.slice(0, 300));
      return res.status(200).json({
        ok: false,
        error: `Vercel /api/historial respondió ${saveResp.status}: ${saveText.slice(0,200)}`,
        stats: historial.stats,
        elapsed: Date.now() - start,
      });
    }

    console.log('[sync] Paso 3 OK — historial guardado');

    // 7. Responder éxito
    res.json({
      ok:      true,
      mes:     mesTarget,
      periodo: historial.periodo,
      stats:   historial.stats,
      vercel:  saveJson,
      elapsed: Date.now() - start,
    });

  } catch (err) {
    console.error('[sync] Error fatal:', err.message);
    console.error(err.stack);
    res.status(500).json({
      ok:      false,
      error:   err.message,
      elapsed: Date.now() - start,
    });
  }
});

// ── GET /sync-nubox/status ─────────────────────────────────────────────────────
// Para verificar desde n8n que el servicio está vivo antes de ejecutar
app.get('/sync-nubox/status', (req, res) => {
  const usaCookies     = !!(process.env.NUBOX_SESSION_COOKIES && process.env.NUBOX_UTN);
  const usaBrowserless = !!(process.env.NUBOX_RUT && process.env.NUBOX_PASSWORD && process.env.BROWSERLESS_TOKEN);
  res.json({
    ready:      usaCookies || usaBrowserless,
    auth_mode:  usaCookies ? 'cookies' : (usaBrowserless ? 'browserless' : 'none'),
    env: {
      session_cookies: !!process.env.NUBOX_SESSION_COOKIES,
      nubox_utn:       !!process.env.NUBOX_UTN,
      nubox_rut:       !!process.env.NUBOX_RUT,
      nubox_password:  !!process.env.NUBOX_PASSWORD,
      browserless:     !!process.env.BROWSERLESS_TOKEN,
      vercel_url:      !!process.env.VERCEL_HISTORIAL_URL,
      secret:          !!process.env.SYNC_SECRET,
    },
    ts: new Date().toISOString(),
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Devuelve el mes anterior en formato "YYYY-MM" */
function _mesAnterior() {
  const d = new Date();
 