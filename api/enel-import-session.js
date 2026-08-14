/**
 * POST /api/enel-import-session
 *
 * Recibe las cookies reales de una sesión ya autenticada en enel.cl
 * (exportadas por la extensión de Chrome) y las inyecta directamente en una
 * página de Browserless — sin intentar loguearse con usuario/clave, que es
 * lo que venía fallando de forma automatizada.
 *
 * TEMPORAL: además de autenticar, navega a "Mis consumos" y devuelve la
 * tabla resultante, para descubrir la estructura real de Lectura Anterior /
 * Lectura Actual antes de escribir la lógica definitiva.
 *
 * Body: { cookies: [...] }  (formato Puppeteer, ya generado por la extensión)
 */

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const BROWSER_CODE = `
  export default async function ({ page, context }) {
    const { cookies } = context;

    // Inyectar la sesión real ANTES de navegar
    await page.setCookie(...cookies);

    await page.goto('https://www.enel.cl/es/Ingresar.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2500));

    // Si las cookies son válidas, Enel redirige solo al área privada
    let onPrivate = page.url().includes('private-area');
    if (!onPrivate) {
      // reintento: a veces el redirect necesita una segunda navegación
      await page.goto('https://www.enel.cl/es/private-area.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      onPrivate = page.url().includes('private-area');
    }

    if (!onPrivate) {
      const diag = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        bodySnippet: (document.body.innerText || '').slice(0, 500),
      })).catch(() => null);
      throw new Error('Las cookies no autenticaron: ' + JSON.stringify(diag));
    }

    await page.waitForSelector('.pvtArea-account-select-option', { timeout: 15000 }).catch(() => {});

    const accountIds = await page.evaluate(() =>
      [...document.querySelectorAll('.pvtArea-account-select-option[data-target]')]
        .map(el => el.dataset.target)
        .filter(Boolean)
    );

    // Capturar respuestas JSON relacionadas a consumo/lectura
    const capturedResponses = [];
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        const url = resp.url();
        if (ct.includes('json') && /consum|reading|lectura/i.test(url)) {
          const body = await resp.text();
          capturedResponses.push({ url, body: body.slice(0, 6000) });
        }
      } catch (_) {}
    });

    const clicked = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      const target = all.find(el => el.children.length === 0 && /mis consumos/i.test(el.textContent || ''));
      if (target) { target.click(); return true; }
      const container = all.find(el => /mis consumos/i.test(el.textContent || '') && el.textContent.trim().length < 40);
      if (container) { container.click(); return true; }
      return false;
    });

    await new Promise(r => setTimeout(r, 4000));

    const domInfo = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table')];
      return {
        tablesCount: tables.length,
        tablesHtml: tables.map(t => t.outerHTML.slice(0, 6000)),
        bodyHasError: /se ha producido un error/i.test(document.body.innerText),
        url: location.href,
      };
    });

    return {
      data: { accountIds, clicked, domInfo, capturedResponses },
      type: 'application/json'
    };
  }
`;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cookies } = req.body || {};
  if (!Array.isArray(cookies) || !cookies.length) {
    return res.status(400).json({ error: 'Faltan cookies en el body' });
  }

  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
  if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  try {
    const blRes = await fetch(`https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: BROWSER_CODE, context: { cookies } })
    });
    if (!blRes.ok) {
      const errText = await blRes.text();
      return res.status(500).json({ error: `Browserless ${blRes.status}: ${errText.slice(0, 800)}` });
    }
    const blData = await blRes.json();
    return res.status(200).json(blData);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
