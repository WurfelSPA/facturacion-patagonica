/**
 * POST /api/aa-refresh
 * Dispara el workflow "aa-refresh.yml" en GitHub Actions via workflow_dispatch.
 * El workflow corre Playwright en un runner de GitHub para scrapear AA.
 *
 * También se usa como cron de Vercel (10 AM UTC = 6 AM Chile).
 *
 * Env vars requeridas:
 *   GITHUB_TOKEN  - PAT con scopes repo + workflow
 *   GITHUB_REPO   - "WurfelSPA/facturacion-patagonica"
 *   SYNC_SECRET   - Secreto para autenticar llamadas manuales
 *   CRON_SECRET   - Provisto automáticamente por Vercel en cron jobs
 */

const GITHUB_REPO_DEFAULT = 'WurfelSPA/facturacion-patagonica';
const WORKFLOW_FILE       = 'aa-refresh.yml';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Autenticación
  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const isCron = req.headers['x-vercel-cron'] === '1' ||
                 (cronSecret && authHeader === `Bearer ${cronSecret}`);
  const isAuth = isCron || (syncSecret && authHeader === `Bearer ${syncSecret}`);
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || GITHUB_REPO_DEFAULT;

  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'Falta GITHUB_TOKEN' });

  try {
    console.log('[aa-refresh] Disparando workflow_dispatch en GitHub Actions...');

    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref: 'main' })
      }
    );

    if (!ghRes.ok) {
      const err = await ghRes.text();
      throw new Error(`GitHub API ${ghRes.status}: ${err.slice(0, 200)}`);
    }

    // GitHub devuelve 204 No Content en éxito
    console.log('[aa-refresh] Workflow disparado OK');
    return res.status(200).json({
      ok: true,
      message: 'Actualización iniciada. Los datos se actualizarán en ~5 minutos.',
      triggeredAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[aa-refresh] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
