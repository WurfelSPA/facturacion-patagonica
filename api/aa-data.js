/**
 * GET /api/aa-data
 * Retorna el caché de deudas de Aguas Andinas.
 * El caché se actualiza diariamente vía /api/aa-refresh (cron 6am).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
}

export default function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Intentar leer el archivo desde varias rutas posibles
  const paths = [
    resolve(process.cwd(), 'aa-cache.json'),
    resolve(process.cwd(), '..', 'aa-cache.json'),
    '/var/task/aa-cache.json',
  ];

  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      const cache = JSON.parse(raw);
      return res.status(200).json({
        ok: true,
        updatedAt: cache.updatedAt,
        source: cache.source || 'cache',
        accounts: cache.accounts || {}
      });
    } catch (_) { /* intentar siguiente */ }
  }

  // Sin caché disponible — devolver vacío (la app mostrará — en lugar de error)
  return res.status(200).json({ ok: true, updatedAt: null, source: 'empty', accounts: {} });
}
