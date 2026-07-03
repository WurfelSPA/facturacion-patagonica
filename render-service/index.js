/**
 * index.js v30 - Express con chunked streaming y heartbeats para evitar
 * el idle timeout de 100s de Render mientras Chromium trabaja.
 */
const express = require('express');
const fetch   = require('node-fetch');
const { scrapeNuboxResumen }    = require('./nubox-scraper');
const { formatearResumenNubox } = require('./excel-parser');

const app    = express();
const PORT   = process.env.PORT || 10000;
const SECRET = process.env.SYNC_SECRET || '';

app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'nubox-sync-v3', ts: new Date().toISOString() }));

app.get('/sync-nubox/status', (_req, res) => res.json({ ok: true, env: {
  NUBOX_UTN:            process.env.NUBOX_UTN            ? 'set' : 'MISSING',
  SYNC_SECRET:          process.env.SYNC_SECRET          ? 'set' : 'MISSING',
  VERCEL_HISTORIAL_URL: process.env.VERCEL_HISTORIAL_URL ? 'set' : 'MISSING',
}}));

function checkAuth(req) {
  const hdr = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const provided = hdr || (req.body || {}).secret || '';
  return SECRET && provided === SECRET;
}

app.post('/sync-nubox', async (req, res) => {
  const start = Date.now();
  console.log('[sync] POST /sync-nubox', new Date().toISOString());

  if (!checkAuth(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
  if (!process.env.NUBOX_UTN) return res.status(500).json({ ok: false, error: 'Falta NUBOX_UTN' });
  if (!process.env.VERCEL_HISTORIAL_URL) return res.status(500).json({ ok: false, error: 'Falta VERCEL_HISTORIAL_URL' });

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  const beat = setInterval(() => res.write('\n'), 30000);
  const done = p => { clearInterval(beat); res.end(JSON.stringify(p)); };

  try {
    console.log('[sync] Paso 1: scraping...');
    const scraped = await scrapeNuboxResumen();
    console.log('[sync] Paso 1 OK -', scraped.clientes.length, 'clientes');

    if (!scraped.clientes.length)
      return done({ ok: false, warning: 'Sin clientes', elapsed: Date.now() - start });

    console.log('[sync] Paso 2: formateando...');
    const resumen = formatearResumenNubox(scraped);

    console.log('[sync] Paso 3: guardando en Drive...');
    const sr = await fetch(process.env.VERCEL_HISTORIAL_URL + '?syncResumen=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': SECRET },
      body: JSON.stringify({ resumen }),
      timeout: 30000,
    });
    if (!sr.ok) throw new Error('VERCEL_ERROR: ' + sr.status + ' ' + (await sr.text()).slice(0, 200));
    const srj = await sr.json();
    console.log('[sync] Paso 3 OK:', JSON.stringify(srj));

    done({ ok: true, clientes: resumen.stats.totalClientes, totalGeneral: resumen.stats.totalGeneral,
           columnas: resumen._columnas, generado: resumen._generado, elapsed: Date.now() - start });
  } catch (err) {
    console.error('[sync] ERROR:', err.message);
    done({ ok: false, error: err.message, elapsed: Date.now() - start });
  }
});

app.get('/diag', async (_req, res) => {
  const start = Date.now();
  if (!process.env.NUBOX_UTN) return res.status(500).json({ ok: false, error: 'Falta NUBOX_UTN' });
  try {
    const r = await scrapeNuboxResumen();
    res.json({ ok: true, result: r, elapsed: Date.now() - start });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, elapsed: Date.now() - start });
  }
});

app.listen(PORT, () => console.log('[sync] nubox-sync-v3 en puerto', PORT));
