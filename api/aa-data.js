/**
 * GET /api/aa-data
 * Retorna el caché de deudas de Aguas Andinas.
 * El caché se actualiza diariamente vía /api/aa-refresh (cron 6am).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
}

export default function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cachePath = join(__dirname, '..', 'aa-cache.json');
    const raw = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(raw);
    return res.status(200).json({
      ok: true,
      updatedAt: cache.updatedAt,
      source: cache.source || 'cache',
      accounts: cache.accounts || {}
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      updatedAt: null,
      source: 'empty',
      accounts: {}
    });
  }
}
