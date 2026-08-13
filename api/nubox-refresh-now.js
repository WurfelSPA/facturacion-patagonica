/**
 * POST /api/nubox-refresh-now
 * Disparador manual del refresh de Nubox desde el botón en Histórico Facturación.
 * No requiere secreto del cliente: reutiliza runNuboxRefresh() (mismo código que
 * corre el cron semanal) en el propio proceso, así SYNC_SECRET nunca llega al navegador.
 *
 * Protección anti-abuso: si el caché se actualizó hace menos de 10 minutos,
 * rechaza la llamada en vez de volver a scrapear (evita gastar Browserless/
 * arriesgar el login de Nubox por clics repetidos o llamadas externas al azar).
 */

import { runNuboxRefresh } from './nubox-refresh.js';

const THROTTLE_MIN = 10;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const cacheRes = await fetch(`https://${req.headers.host}/nubox-resumen-cache.json`).catch(() => null);
    if (cacheRes && cacheRes.ok) {
      const cache = await cacheRes.json().catch(() => null);
      if (cache?.updatedAt) {
        const minsAgo = (Date.now() - new Date(cache.updatedAt).getTime()) / 60000;
        if (minsAgo < THROTTLE_MIN) {
          return res.status(429).json({
            error: `Ya se actualizó hace ${Math.round(minsAgo)} min — espera ${Math.ceil(THROTTLE_MIN - minsAgo)} min antes de reintentar.`
          });
        }
      }
    }

    const result = await runNuboxRefresh();
    return res.status(200).json(result);
  } catch (e) {
    console.error('[nubox-refresh-now] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
