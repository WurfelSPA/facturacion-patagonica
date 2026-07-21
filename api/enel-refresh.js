/**
 * POST /api/enel-refresh  (o GET vía cron de Vercel)
 * Usa Browserless para hacer login en el portal de Enel Chile y scrapear
 * las deudas de todas las cuentas. Actualiza enel-cache.json vía GitHub API.
 *
 * Env vars requeridas:
 *   ENEL_USER           - RUT de acceso al portal Enel (o ENEL_RUT)
 *   ENEL_PASS           - Clave del portal Enel (o ENEL_CLAVE)
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

// ── Script que corre en Browserless ──────────────────────────────────────────
// Selectores confirmados inspeccionando el portal en sesión activa (julio 2026):
//   - Login:    #username  /  #password  (WSO2 IS)
//   - Cuentas:  .pvtArea-account-select-option[data-target]  → data-target = ID
//   - Deuda:    #saldoVigenteText  → "Deuda actual: $2.540.774"  → regex \$[\d.]+
//   - Navegación: /es/private-area.html?supplyCode=<ID>
function buildBrowserlessScript(rut, clave) {
  return `
    async function main({ page }) {
      const PORTAL  = 'https://www.enel.cl';
      const results = {};

      // 1. Login ──────────────────────────────────────────────────────────────
      await page.goto(PORTAL + '/es/Ingresar.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Esperar: formulario de login O redirección directa al área privada
      await Promise.race([
        page.waitForSelector('#username', { timeout: 20000 }),
        page.waitForSelector('.pvtArea-account-select-option', { timeout: 20000 }),
      ]).catch(() => {});

      const usernameInput = await page.$('#username');
      if (usernameInput) {
        // Ingresa RUT (sin puntos, con guion: ej. 12345678-9)
        await usernameInput.click({ clickCount: 3 });
        await usernameInput.type('${rut}', { delay: 60 });

        const passInput = await page.$('#password, input[type="password"]');
        if (!passInput) throw new Error('Campo de clave no encontrado');
        await passInput.click({ clickCount: 3 });
        await passInput.type('${clave}', { delay: 60 });

        // Submit
        const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) await submitBtn.click();
        else await passInput.press('Enter');

        // Esperar redirección al área privada
        await page.waitForSelector('.pvtArea-account-select-option', { timeout: 30000 });
      }

      // Verificar que estamos en el área privada
      if (!page.url().includes('private-area')) {
        throw new Error('Login fallido: URL actual = ' + page.url());
      }

      // 2. Obtener todos los IDs de cuenta disponibles ─────────────────────────
      const accountIds = await page.evaluate(() =>
        [...document.querySelectorAll('.pvtArea-account-select-option[data-target]')]
          .map(el => el.dataset.target)
          .filter(Boolean)
      );

      if (!accountIds.length) throw new Error('No se encontraron cuentas Enel en el portal');

      // 3. Scrapear deuda de cada cuenta ────────────────────────────────────────
      // Usa page.goto() con supplyCode para cambiar de cuenta (AJAX no funciona sin navegación)
      for (const id of accountIds) {
        try {
          await page.goto(
            PORTAL + '/es/private-area.html?supplyCode=' + id,
            { waitUntil: 'domcontentloaded', timeout: 30000 }
          );

          // Esperar el label de deuda (se carga dinámicamente con el saldo)
          await page.waitForSelector('#saldoVigenteText', { timeout: 15000 });

          const texto = await page.$eval('#saldoVigenteText', el => el.textContent.trim());
          // Ej: "Deuda actual: $2.540.774"  →  "$2.540.774"
          const deuda = texto.includes('$') ? '$' + texto.split('$')[1].trim() : '$0';

          results[id] = { deuda };
        } catch (e) {
          results[id] = { deuda: null, error: e.message };
        }
        await new Promise(r => setTimeout(r, 200));
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

  const RUT   = process.env.ENEL_USER || process.env.ENEL_RUT;
  const CLAVE = process.env.ENEL_PASS || process.env.ENEL_CLAVE;
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
