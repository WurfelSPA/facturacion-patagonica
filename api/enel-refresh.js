/**
 * POST /api/enel-refresh  (o GET vía cron de Vercel)
 * Usa Browserless para hacer login en el portal de Enel Chile y scrapear
 * las deudas de todas las cuentas. Actualiza enel-cache.json vía GitHub API.
 *
 * Env vars requeridas:
 *   ENEL_RUT            - RUT de acceso al portal Enel
 *   ENEL_CLAVE          - Clave del portal Enel
 *   BROWSERLESS_TOKEN   - Token de api.browserless.io
 *   GITHUB_TOKEN        - Personal Access Token con permiso repo (para actualizar enel-cache.json)
 *   GITHUB_REPO         - "usuario/repositorio" (ej: "WurfelSPA/facturacion-patagonica")
 *   CRON_SECRET         - Secreto para autenticar llamadas de cron de Vercel
 *   SYNC_SECRET         - Secreto para autenticar llamadas manuales
 */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Cuentas Enel a scrapear ───────────────────────────────────────────────────
// Se llenará con los IDs de cliente Enel una vez explorado el portal
const cuentas = [
  // Ejemplo: { id: '123456789', nombre: 'Nombre Cliente' }
];

// ── Script que corre en Browserless ──────────────────────────────────────────
function buildBrowserlessScript(rut, clave) {
  return `
    async function main({ page }) {
      const results = {};

      /* TODO: implementar scraping Enel
       *
       * Pasos a implementar (explorar el portal para confirmar los selectores):
       *
       * 1. Navegar al login del portal Enel Chile
       *    - URL base a confirmar: https://www.enel.cl o portal empresas
       *    - Esperar el formulario de login (selector a confirmar)
       *
       * 2. Ingresar credenciales
       *    - Campo RUT: selector a confirmar
       *    - Campo clave: input[type="password"]
       *    - Botón submit: selector a confirmar
       *
       * 3. Verificar login exitoso
       *    - Comprobar que la URL no incluya "login"
       *    - Capturar mensaje de error si falla
       *
       * 4. Iterar sobre las cuentas (IDs de cliente Enel)
       *    - Para cada cuenta, navegar a la página de deuda/boleta
       *    - Extraer monto de deuda: selector a confirmar
       *    - Extraer fecha de vencimiento: selector a confirmar
       *    - Guardar resultado en results[idCuenta]
       *
       * 5. Retornar resultados
       */

      // Cuentas a consultar (se pasan desde el contexto)
      const cuentas = ${JSON.stringify(cuentas)};

      for (const cuenta of cuentas) {
        try {
          // TODO: navegar a la página de la cuenta y scrapear deuda/vencimiento
          results[cuenta.id] = { deuda: '$0', vencimiento: null };
        } catch (e) {
          results[cuenta.id] = { deuda: null, error: e.message };
        }
        await new Promise(r => setTimeout(r, 300));
      }

      return { accounts: results, total: Object.keys(results).length };
    }
  `;
}

// ── Actualizar enel-cache.json vía GitHub API ─────────────────────────────────
async function updateCacheViaGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  if (!GITHUB_TOKEN) throw new Error('Falta GITHUB_TOKEN');

  const filePath = 'enel-cache.json';
  const apiBase  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  // Obtener SHA actual del archivo
  let sha = null;
  try {
    const getRes = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
  } catch (_) {}

  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const body = {
    message: `chore: actualizar caché Enel ${new Date().toISOString().slice(0, 10)}`,
    content,
    ...(sha ? { sha } : {})
  };

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub API error ${putRes.status}: ${err.slice(0, 200)}`);
  }
  return await putRes.json();
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Autenticación: cron de Vercel (CRON_SECRET) o llamada manual (SYNC_SECRET)
  // Vercel envía: Authorization: Bearer <CRON_SECRET> con User-Agent vercel-cron/1.0
  const authHeader = req.headers['authorization'] || '';
  const cronSecret  = process.env.CRON_SECRET;
  const syncSecret  = process.env.SYNC_SECRET;
  const isCron = req.headers['x-vercel-cron'] === '1' ||
                 (cronSecret && authHeader === `Bearer ${cronSecret}`);
  const isAuth = isCron || (syncSecret && authHeader === `Bearer ${syncSecret}`);
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  const RUT   = process.env.ENEL_RUT;
  const CLAVE = process.env.ENEL_CLAVE;
  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

  if (!RUT || !CLAVE)         return res.status(500).json({ error: 'Faltan credenciales Enel' });
  if (!BROWSERLESS_TOKEN)     return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  try {
    console.log('[enel-refresh] Iniciando scraping con Browserless...');

    // Llamar a Browserless
    const blRes = await fetch(`https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: buildBrowserlessScript(RUT, CLAVE),
        context: {}
      })
    });

    if (!blRes.ok) {
      const errText = await blRes.text();
      throw new Error(`Browserless error ${blRes.status}: ${errText.slice(0, 300)}`);
    }

    const blData = await blRes.json();
    console.log(`[enel-refresh] Scraping OK: ${blData.total} cuentas`);

    const cacheData = {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: 'enel',
      accounts: blData.accounts
    };

    // Guardar en GitHub
    await updateCacheViaGitHub(cacheData);
    console.log('[enel-refresh] Cache actualizado en GitHub');

    return res.status(200).json({
      ok: true,
      updatedAt: cacheData.updatedAt,
      source: 'enel',
      total: blData.total
    });

  } catch (err) {
    console.error('[enel-refresh] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
