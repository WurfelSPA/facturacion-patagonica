/**
 * GET /api/enel-refresh  (vía cron de Vercel)
 * Usa Browserless para hacer login en el portal Enel Chile y consultar
 * la deuda de cada cuenta via la API interna AccountInfoChileThreadCommand.
 * Actualiza enel-cache.json vía GitHub API.
 *
 * Env vars requeridas:
 *   ENEL_USER           - RUT de acceso al portal Enel (ej: 12345678-9)
 *   ENEL_PASS           - Clave del portal Enel
 *   BROWSERLESS_TOKEN   - Token de api.browserless.io
 *   GITHUB_TOKEN        - Personal Access Token con permiso repo
 *   GITHUB_REPO         - "usuario/repositorio" (ej: "WurfelSPA/facturacion-patagonica")
 *   CRON_SECRET         - Secreto para autenticar llamadas de cron de Vercel
 *   SYNC_SECRET         - Secreto para autenticar llamadas manuales
 *
 * Cuentas scrapeadas: las que estén vinculadas al RUT en el portal Enel.
 * Si se agregan cuentas nuevas al portal, se tomarán automáticamente.
 */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Script que corre en Browserless ──────────────────────────────────────────
// Flujo:
//   1. Login en portal Enel (WSO2 IS)
//   2. Leer IDs de cuenta desde el DOM (.pvtArea-account-select-option[data-target])
//   3. Obtener CSRF token desde /libs/granite/csrf/token.json
//   4. Para cada cuenta: POST AccountInfoChileThreadCommand.html → supplyBalance + expiryDate
//   5. Refrescar token cada 30 cuentas para evitar expiración
function buildBrowserlessScript(rut, clave) {
  return `
    export default async function ({ page }) {
      const PORTAL = 'https://www.enel.cl';

      // 1. Login ───────────────────────────────────────────────────────────────
      await page.goto(PORTAL + '/es/Ingresar.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

      await Promise.race([
        page.waitForSelector('#username', { timeout: 20000 }),
        page.waitForSelector('.pvtArea-account-select-option', { timeout: 20000 }),
      ]).catch(() => {});

      // Diagnóstico: cada fase reporta su nombre + URL actual si falla, para
      // saber exactamente dónde se destruye el contexto sin adivinar a ciegas.
      async function withPhase(phase, fn) {
        try {
          return await fn();
        } catch (e) {
          let url = 'desconocida';
          try { url = page.url(); } catch (_) {}
          throw new Error('[fase:' + phase + '] ' + e.message + ' | url=' + url);
        }
      }

      // El portal tiene marcado duplicado (desktop/mobile); filtramos por
      // bounding box para quedarnos solo con el elemento realmente visible.
      async function firstVisible(selector) {
        for (const handle of await page.$$(selector)) {
          try {
            if (await handle.boundingBox()) return handle;
          } catch (_) {}
        }
        return null;
      }

      await withPhase('login', async () => {
        const usernameInput = await firstVisible('#username');
        if (usernameInput) {
          await usernameInput.click({ clickCount: 3 });
          await usernameInput.type('${rut}', { delay: 60 });

          const passInput = await firstVisible('#password, input[type="password"]');
          if (!passInput) throw new Error('Campo de clave no encontrado');
          await passInput.click({ clickCount: 3 });
          await passInput.type('${clave}', { delay: 60 });

          const submitBtn = await firstVisible('button[type="submit"], input[type="submit"]');

          // El submit dispara una navegación completa; si no se espera en
          // paralelo, el click puede pisar el contexto de CDP y tirar
          // "Cannot find context with specified id".
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
            submitBtn ? submitBtn.click() : passInput.press('Enter')
          ]);

          // El login de Enel (WSO2 IS) puede encadenar más de un redirect;
          // damos tiempo a que se asiente y reintentamos si un redirect
          // intermedio destruye el contexto justo cuando consultamos el DOM.
          await new Promise(r => setTimeout(r, 2000));
          let ready = false;
          for (let attempt = 0; attempt < 3 && !ready; attempt++) {
            try {
              await page.waitForSelector('.pvtArea-account-select-option', { timeout: 10000 });
              ready = true;
            } catch (_) {
              await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      });

      if (!page.url().includes('private-area')) {
        throw new Error('Login fallido: URL actual = ' + page.url());
      }

      // 2. Obtener IDs de cuenta desde el DOM ──────────────────────────────────
      const accountIds = await withPhase('accountIds', () => page.evaluate(() =>
        [...document.querySelectorAll('.pvtArea-account-select-option[data-target]')]
          .map(el => el.dataset.target)
          .filter(Boolean)
      ));

      if (!accountIds.length) throw new Error('No se encontraron cuentas Enel en el portal');

      // 3. Helper: obtener CSRF token fresco ────────────────────────────────────
      async function getCsrfToken() {
        return page.evaluate(async () => {
          const r = await fetch('/libs/granite/csrf/token.json', { credentials: 'include' });
          const bodyText = await r.text();
          if (!r.ok) throw new Error('CSRF fetch HTTP ' + r.status + ': ' + bodyText.slice(0, 200));
          let j;
          try { j = JSON.parse(bodyText); } catch (e) {
            throw new Error('CSRF respuesta no-JSON: ' + bodyText.slice(0, 200));
          }
          if (!j.token) throw new Error('CSRF JSON sin campo token: ' + bodyText.slice(0, 200));
          return j.token;
        });
      }

      // 4. Consultar deuda de cada cuenta via API ───────────────────────────────
      const results = {};
      let token = await withPhase('csrf-inicial', getCsrfToken);
      if (!token) throw new Error('No se pudo obtener CSRF token inicial');

      for (let i = 0; i < accountIds.length; i++) {
        const id = accountIds[i];

        // Refrescar token cada 30 cuentas
        if (i > 0 && i % 30 === 0) {
          token = await getCsrfToken();
        }

        try {
          const data = await page.evaluate(async (supplyCode, csrfToken) => {
            const params = new URLSearchParams({
              ':cq_csrf_token': csrfToken,
              supplyCode
            });
            const r = await fetch('/es/private-area.mdwedgeohl.AccountInfoChileThreadCommand.html', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'CSRF-Token': csrfToken
              },
              body: params
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
          }, id, token);

          const bal = data.supplyBalance;
          results[id] = {
            deuda: (bal && bal !== '0') ? '$' + bal : '$0',
            vencimiento: data.expiryDate || null
          };
        } catch (e) {
          results[id] = { deuda: null, error: e.message };
        }

        // Pausa entre llamadas
        await new Promise(r => setTimeout(r, 300));
      }

      return {
        data: {
          accounts: results,
          total: accountIds.length,
          conDeuda: Object.values(results).filter(v => v.deuda && v.deuda !== '$0').length
        },
        type: 'application/json'
      };
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
    // El login SSO de Enel (WSO2 IS + SAML) es intermitente cuando se
    // automatiza: en pruebas fallo con 3 errores transitorios distintos
    // (stale DOM node, CSRF vacío, timeout) en 3 intentos consecutivos, sin
    // que ninguno se repitiera. Reintentamos el flujo completo antes de
    // rendirnos, en vez de perseguir cada síntoma como si fuera un bug fijo.
    const MAX_ATTEMPTS = 3;
    let blData = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !blData; attempt++) {
      console.log(`[enel-refresh] Intento ${attempt}/${MAX_ATTEMPTS} con Browserless...`);
      try {
        // timeout=150000: sesión de Browserless por defecto es 60s si no se
        // especifica — el login SSO de Enel (WSO2 + SAML) suma ~125s en el
        // peor caso entre goto() inicial + waitForSelector/waitForNavigation
        // internos, así que 60s quedaba corto (aviso de Browserless 2026-08-20:
        // sesiones cortándose por timeout).
        const blRes = await fetch(`https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=150000`, {
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

        blData = await blRes.json();
      } catch (e) {
        lastError = e;
        console.warn(`[enel-refresh] Intento ${attempt} falló:`, e.message);
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!blData) throw lastError || new Error('Browserless falló sin detalle');

    console.log(`[enel-refresh] Scraping OK: ${blData.total} cuentas, ${blData.conDeuda} con deuda`);

    const cacheData = {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: 'enel',
      accounts: blData.accounts
    };

    await updateCacheViaGitHub(cacheData);
    console.log('[enel-refresh] Cache actualizado en GitHub');

    return res.status(200).json({
      ok: true,
      updatedAt: cacheData.updatedAt,
      source: 'enel',
      total: blData.total,
      conDeuda: blData.conDeuda
    });

  } catch (err) {
    console.error('[enel-refresh] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
