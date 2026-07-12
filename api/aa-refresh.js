/**
 * POST /api/aa-refresh  (o GET vía cron de Vercel)
 * Usa Browserless para hacer login en Aguas Andinas y scrapear
 * las deudas de todas las cuentas. Actualiza aa-cache.json vía GitHub API.
 *
 * Env vars requeridas:
 *   AGUAS_ANDINASc      - RUT de acceso al portal empresa
 *   AGUAS_ANDINAS_PASS  - Clave del portal empresa
 *   BROWSERLESS_TOKEN   - Token de api.browserless.io
 *   GITHUB_TOKEN        - Personal Access Token con permiso repo (para actualizar aa-cache.json)
 *   GITHUB_REPO         - "usuario/repositorio" (ej: "WurfelSPA/facturacion-patagonica")
 *   SYNC_SECRET         - Secreto para autenticar llamadas manuales
 */

const BASE_URL    = 'https://www.aguasandinas.cl';
const LOGIN_PATH  = '/web/aguasandinas/login';
const ACCOUNT_PATH = '/web/aguasandinas/informacion-de-la-cuenta';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Script que corre en Browserless ──────────────────────────────────────────
function buildBrowserlessScript(rut, clave) {
  return `
    async function main({ page }) {
      const BASE = '${BASE_URL}';
      const results = {};

      // 1. Navegar al login (Incapsula se resuelve automáticamente)
      await page.goto(BASE + '${LOGIN_PATH}', { waitUntil: 'networkidle2', timeout: 60000 });

      // 2. Encontrar el formulario de login y hacer submit
      await page.waitForSelector('input[name*="rut"], input[id*="rut"], input[name*="Rut"]', { timeout: 15000 });

      const rutInput = await page.$('input[name*="rut"], input[id*="rut"], input[name*="Rut"]');
      const claveInput = await page.$('input[type="password"]');
      if (!rutInput || !claveInput) throw new Error('No se encontraron campos de login');

      await rutInput.type('${rut}', { delay: 50 });
      await claveInput.type('${clave}', { delay: 50 });

      // Click en submit
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], .btn-login, [class*="login-btn"]');
      if (submitBtn) await submitBtn.click();
      else await page.keyboard.press('Enter');

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

      // 3. Verificar login exitoso
      const currentUrl = page.url();
      if (currentUrl.includes('login')) {
        const errMsg = await page.$eval('.error, .alert, [class*="error"]', el => el.textContent.trim()).catch(() => 'Login fallido');
        throw new Error('Login fallido: ' + errMsg);
      }

      // 4. Obtener todos los links de cuentas disponibles
      await page.goto(BASE + '${ACCOUNT_PATH}', { waitUntil: 'networkidle2', timeout: 30000 });

      const accountLinks = await page.evaluate(() => {
        return [...document.querySelectorAll('a')]
          .filter(a => /\\d{6,}-\\d/.test(a.textContent) && a.href.includes('cuentaRender'))
          .map(a => ({ id: (a.textContent.match(/(\\d{6,}-\\d)/) || [])[1], href: a.href }))
          .filter(l => l.id);
      });

      if (!accountLinks.length) throw new Error('No se encontraron cuentas');

      // 5. Scrapear deuda de cada cuenta con page.goto() (navegación real)
      // IMPORTANTE: fetch() siempre retorna la cuenta activa sin cambiarla.
      // Se debe navegar con page.goto() para que Liferay cambie la cuenta en sesión.
      for (const link of accountLinks) {
        try {
          await page.goto(link.href, { waitUntil: 'networkidle2', timeout: 30000 });
          const deuda = await page.$eval('span.total_deuda', el => el.textContent.trim()).catch(() => '$0');
          const divText = await page.$eval('#divmonto', el => el.innerText).catch(() => '');
          const fecha = (divText.match(/\\d{2}\\/\\d{2}\\/\\d{4}/) || [])[0] || null;
          results[link.id] = { deuda, vencimiento: fecha };
        } catch (e) {
          results[link.id] = { deuda: null, error: e.message };
        }
        // Pausa mínima entre cuentas
        await new Promise(r => setTimeout(r, 300));
      }

      return { accounts: results, total: Object.keys(results).length };
    }
  `;
}

// ── Actualizar aa-cache.json vía GitHub API ───────────────────────────────────
async function updateCacheViaGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  if (!GITHUB_TOKEN) throw new Error('Falta GITHUB_TOKEN');

  const filePath = 'aa-cache.json';
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
    message: `chore: actualizar caché AA ${new Date().toISOString().slice(0,10)}`,
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

  // Autenticación: cron de Vercel o SYNC_SECRET manual
  const authHeader = req.headers['authorization'] || '';
  const syncSecret = process.env.SYNC_SECRET;
  const isCron = req.headers['x-vercel-cron'] === '1';
  const isAuth = isCron || (syncSecret && authHeader === `Bearer ${syncSecret}`);
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  const RUT   = process.env.AGUAS_RUT || process.env.AGUAS_ANDINAS_USER || process.env.AGUAS_ANDINASc;
  const CLAVE = process.env.AGUAS_CLAVE || process.env.AGUAS_ANDINAS_PASS;
  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

  if (!RUT || !CLAVE)             return res.status(500).json({ error: 'Faltan credenciales AA' });
  if (!BROWSERLESS_TOKEN)         return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  try {
    console.log('[aa-refresh] Iniciando scraping con Browserless...');

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
    console.log(`[aa-refresh] Scraping OK: ${blData.total} cuentas`);

    const cacheData = {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: 'browserless',
      accounts: blData.accounts
    };

    // Guardar en GitHub
    await updateCacheViaGitHub(cacheData);
    console.log('[aa-refresh] Cache actualizado en GitHub');

    return res.status(200).json({
      ok: true,
      updatedAt: cacheData.updatedAt,
      total: blData.total,
      cuentasConDeuda: Object.values(blData.accounts).filter(a => a.deuda && a.deuda !== '$0').length
    });

  } catch (e) {
    console.error('[aa-refresh] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
