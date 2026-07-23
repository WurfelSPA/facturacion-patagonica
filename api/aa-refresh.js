/**
 * POST /api/aa-refresh  (o GET vía cron de Vercel)
 * Usa la API de Khipu Open Data para consultar el estado de deuda
 * de cada cuenta de Aguas Andinas por su ClientIdentifier.
 * Actualiza aa-cache.json vía GitHub API.
 *
 * Env vars requeridas:
 *   KHIPU_API_KEY   - API key de Khipu (panel en khipu.com)
 *   GITHUB_TOKEN    - Personal Access Token con permiso repo
 *   GITHUB_REPO     - "usuario/repositorio" (ej: "WurfelSPA/facturacion-patagonica")
 *   SYNC_SECRET     - Secreto para autenticar llamadas manuales
 */

const KHIPU_URL = 'https://api.khipu.com/v1/cl/services/aguasandinas.cl/debt-status-by-client-identifier';
const GITHUB_REPO_DEFAULT = 'WurfelSPA/facturacion-patagonica';
const CACHE_FILE = 'aa-cache.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Formatear monto como "$86.650" (estilo AA) ────────────────────────────────
function fmtDeuda(amount) {
  if (!amount || amount === 0) return '$0';
  return '$' + Math.round(amount).toLocaleString('es-CL');
}

// ── Consultar deuda de una cuenta vía Khipu ───────────────────────────────────
async function fetchDeuda(clientId, apiKey) {
  const res = await fetch(KHIPU_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({ RequestData: { ClientIdentifier: clientId } })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Khipu ${res.status} para ${clientId}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.Status !== 'OK' || !data.Data?.DebtStatus) {
    throw new Error(`Khipu Status=${data.Status} para ${clientId}: ${data.Error?.Description || 'sin datos'}`);
  }
  const ds = data.Data.DebtStatus;
  return {
    deuda: fmtDeuda(ds.Debt?.TotalAmount),
    nombre: ds.HolderName || ds.ClientName || null,
    direccion: ds.Address || null,
    vencimiento: null  // Khipu no retorna fecha de vencimiento
  };
}

// ── Leer aa-cache.json desde GitHub para obtener IDs existentes ───────────────
async function readCacheFromGitHub(githubToken, repo) {
  const apiBase = `https://api.github.com/repos/${repo}/contents/${CACHE_FILE}`;
  try {
    const res = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) {
      const txt = await res.text();
      return { data: null, sha: null, readError: `GitHub ${res.status}: ${txt.slice(0,200)}` };
    }
    const json = await res.json();
    const content = Buffer.from(json.content, 'base64').toString('utf-8');
    return { data: JSON.parse(content), sha: json.sha };
  } catch(e) {
    return { data: null, sha: null, readError: e.message };
  }
}

// ── Actualizar aa-cache.json vía GitHub API ───────────────────────────────────
async function updateCacheViaGitHub(data, sha, githubToken, repo) {
  const apiBase = `https://api.github.com/repos/${repo}/contents/${CACHE_FILE}`;
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const body = {
    message: `chore: actualizar caché AA ${new Date().toISOString().slice(0, 10)}`,
    content,
    ...(sha ? { sha } : {})
  };
  const res = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${err.slice(0, 200)}`);
  }
  return await res.json();
}

// ── Handler principal ─────────────────────────────────────────────────────────
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

  const KHIPU_API_KEY = process.env.KHIPU_API_KEY;
  const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
  const GITHUB_REPO   = process.env.GITHUB_REPO || GITHUB_REPO_DEFAULT;

  if (!KHIPU_API_KEY) return res.status(500).json({ error: 'Falta KHIPU_API_KEY' });
  if (!GITHUB_TOKEN)  return res.status(500).json({ error: 'Falta GITHUB_TOKEN' });

  try {
    console.log('[aa-refresh] Leyendo IDs desde cache GitHub...');
    const { data: oldCache, sha, readError } = await readCacheFromGitHub(GITHUB_TOKEN, GITHUB_REPO);
    const existingIds = oldCache?.accounts ? Object.keys(oldCache.accounts) : [];

    if (!existingIds.length) {
      return res.status(400).json({
        error: 'aa-cache.json no tiene cuentas.',
        repo: GITHUB_REPO,
        readError: readError || null,
        oldCacheKeys: oldCache ? Object.keys(oldCache) : null
      });
    }

    console.log(`[aa-refresh] Consultando ${existingIds.length} cuentas en Khipu...`);
    const accounts = {};
    const errors = [];

    // Llamadas en lotes de 5 para no saturar la API
    for (let i = 0; i < existingIds.length; i += 5) {
      const lote = existingIds.slice(i, i + 5);
      await Promise.all(lote.map(async (id) => {
        try {
          accounts[id] = await fetchDeuda(id, KHIPU_API_KEY);
        } catch (e) {
          console.warn(`[aa-refresh] Error cuenta ${id}:`, e.message);
          errors.push({ id, error: e.message });
          // Mantener datos anteriores si existen
          if (oldCache?.accounts?.[id]) {
            accounts[id] = { ...oldCache.accounts[id], error: e.message };
          } else {
            accounts[id] = { deuda: null, error: e.message };
          }
        }
      }));
      // Pausa entre lotes
      if (i + 5 < existingIds.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const cacheData = {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: 'khipu',
      accounts
    };

    await updateCacheViaGitHub(cacheData, sha, GITHUB_TOKEN, GITHUB_REPO);
    console.log('[aa-refresh] Cache actualizado en GitHub');

    return res.status(200).json({
      ok: true,
      updatedAt: cacheData.updatedAt,
      total: existingIds.length,
      errors: errors.length,
      ...(errors.length ? { errorDetail: errors.slice(0, 5) } : {})
    });
  } catch (e) {
    console.error('[aa-refresh] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
