/**
 * render-service/index.js
 *
 * Servidor Express corriendo en Render.com
 * Endpoint principal: POST /sync-nubox
 *
 * Flujo:
 *   1. n8n llama POST /sync-nubox { mes: "YYYY-MM", secret: "..." }
 *   2. Scraper hace login en Nubox via Browserless.io -> obtiene cookies
 *   3. Intenta descargar Excel de reporteria del mes (o usa lista de docs como fallback)
 *   4. Parser convierte datos -> formato historial-facturas.json
 *   5. POST al endpoint Vercel /api/historial para guardar en Drive
 *   6. Responde con resultado { ok, stats }
 *
 * Variables de entorno (configurar en Render dashboard):
 *   PORT                  -- puerto (Render lo asigna automaticamente)
 *   SYNC_SECRET           -- token compartido para autenticar el trigger de n8n
 *   NUBOX_SESSION_COOKIES -- cookies de sesion Nubox (opcion A, recomendado)
 *   NUBOX_UTN             -- token UTN de sesion Nubox (opcion A, recomendado)
 *   NUBOX_RUT             -- RUT de login Nubox (opcion B, via Browserless)
 *   NUBOX_PASSWORD        -- Contrasena Nubox (opcion B, via Browserless)
 *   BROWSERLESS_TOKEN     -- API token de browserless.io (opcion B)
 *   VERCEL_HISTORIAL_URL  -- URL completa del endpoint historial Vercel
 */

const express = require('express');
const { scrapeNubox } = require('./nubox-scraper');
const { procesarNuboxData } = require('./excel-parser');

const app = express();
app.use(express.json());

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || '';

// -- Health check --
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'nubox-sync', ts: new Date().toISOString() });
});

// -- POST /sync-nubox --
app.post('/sync-nubox', async (req, res) => {
  const start = Date.now();
  console.log('[sync] Iniciando sincronizacion Nubox —', new Date().toISOString());

  // 1. Autenticacion
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

  // 3. Variables de entorno -- acepta cookies almacenadas O login via Browserless
  const usaCookies     = !!(process.env.NUBOX_SESSION_COOKIES && process.env.NUBOX_UTN);
  const usaBrowserless = !!(process.env.NUBOX_RUT && process.env.NUBOX_PASSWORD && process.env.BROWSERLESS_TOKEN);
  if (!usaCookies && !usaBrowserless) {
    return res.status(500).json({ ok: false, error: 'Faltan variables: configura NUBOX_SESSION_COOKIES + NUBOX_UTN o NUBOX_RUT + NUBOX_PASSWORD + BROWSERLESS_TOKEN' });
  }
  if (!process.env.VERCEL_HISTORIAL_URL) {
    return res.status(500).json({ ok: false, error: 'Falta VERCEL_HISTORIAL_URL' });
  }

  try {
    // 4. Scraping Nubox
    console.log(`[sync] Paso 1: scraping Nubox para mes ${mesTarget}`);
    const { excelBuffer, documentos } = await scrapeNubox(mesTarget);
    console.log(`[sync] Paso 1 OK -- docs: ${documentos.length}, excel: ${excelBuffer ? excelBuffer.length + ' bytes' : 'null'}`);

    // 5. Parsear datos
    console.log('[sync] Paso 2: parseando datos');
    const historial = procesarNuboxData({ excelBuffer, documentos, mes: mesTarget });
    console.log(`[sync] Paso 2 OK -- ${historial.stats.totalClientes} clientes, ${historial.stats.totalRegistros} facturas`);

    if (historial.stats.totalClientes === 0) {
      return res.status(200).json({
        ok: false,
        warning: 'No se encontraron facturas para el periodo',
        mes: mesTarget,
        periodo: historial.periodo,
        stats: historial.stats,
        elapsed: Date.now() - start,
      });
    }

    // 6. Enviar a Vercel /api/historial
    console.log('[sync] Paso 3: guardando en Vercel /api/historial');
    const payload = { anio: historial.anio, periodo: historial.periodo, data: historial.data };
    const saveResp = await fetch(process.env.VERCEL_HISTORIAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const saveText = await saveResp.text();
    let saveJson = null;
    try { saveJson = JSON.parse(saveText); } catch (_) {}

    if (!saveResp.ok) {
      console.error('[sync] Error guardando historial:', saveResp.status, saveText.slice(0, 300));
      return res.status(200).json({
        ok: false,
        error: `Vercel /api/historial respondio ${saveResp.status}: ${saveText.slice(0, 200)}`,
        stats: historial.stats,
        elapsed: Date.now() - start,
      });
    }

    console.log('[sync] Paso 3 OK -- historial guardado');
    res.json({
      ok: true,
      mes: mesTarget,
      periodo: historial.periodo,
      stats: historial.stats,
      vercel: saveJson,
      elapsed: Date.now() - start,
    });

  } catch (err) {
    console.error('[sync] Error fatal:', err.message);
    console.error(err.stack);
    res.status(500).json({ ok: false, error: err.message, elapsed: Date.now() - start });
  }
});

// -- GET /sync-nubox/status --
app.get('/sync-nubox/status', (req, res) => {
  const usaCookies     = !!(process.env.NUBOX_SESSION_COOKIES && process.env.NUBOX_UTN);
  const usaBrowserless = !!(process.env.NUBOX_RUT && process.env.NUBOX_PASSWORD && process.env.BROWSERLESS_TOKEN);
  res.json({
    ready:     usaCookies || usaBrowserless,
    auth_mode: usaCookies ? 'cookies' : (usaBrowserless ? 'browserless' : 'none'),
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

// -- Helpers --
function _mesAnterior() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const anio = d.getFullYear();
  const mes  = String(d.getMonth() + 1).padStart(2, '0');
  return `${anio}-${mes}`;
}

// -- Arranque --
app.listen(PORT, () => {
  console.log(`[server] Nubox Sync Service corriendo en puerto ${PORT}`);
  console.log(`[server] Vercel URL: ${process.env.VERCEL_HISTORIAL_URL || '(no configurado)'}`);
  console.log(`[server] Secret: ${process.env.SYNC_SECRET ? 'configurado' : 'NO configurado'}`);
});
