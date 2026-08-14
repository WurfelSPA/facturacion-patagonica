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
 *
 * El resultado (o el error de diagnóstico) se guarda además en
 * enel-mis-consumos-debug.json vía GitHub API, porque quien llama a este
 * endpoint es la extensión (fire-and-forget) y nadie ve la respuesta HTTP
 * directamente.
 */

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

async function guardarDebugViaGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  if (!GITHUB_TOKEN) return;

  const filePath = 'enel-mis-consumos-debug.json';
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  let sha = null;
  try {
    const getRes = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
  } catch (_) {}

  const payload = { actualizado: new Date().toISOString(), ...data };
  const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8').toString('base64');
  const body = {
    message: `chore: debug mis consumos Enel ${new Date().toISOString().slice(0, 10)}`,
    content,
    ...(sha ? { sha } : {})
  };

  await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }).catch(() => {});
}

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

    // Capturar respuestas JSON relacionadas a consumo/lectura (desde ahora, por si
    // el SPA las dispara solo al llegar, sin necesitar clic)
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

    // El área privada es un SPA: puede tardar en renderizar. En vez de esperar
    // un selector fijo (que puede no existir o llamarse distinto), sondear
    // hasta 20s buscando cualquier señal de que la cuenta/consumo ya cargó.
    let ready = false;
    for (let i = 0; i < 10 && !ready; i++) {
      ready = await page.evaluate(() => {
        const txt = document.body.innerText || '';
        return document.querySelector('.pvtArea-account-select-option') ||
               /consumo/i.test(txt) ||
               /n[uú]mero de cliente/i.test(txt);
      }).catch(() => false);
      if (!ready) await new Promise(r => setTimeout(r, 2000));
    }

    // Diagnóstico rico del estado real de la página, autenticados o no.
    const pageSnapshot = await page.evaluate(() => {
      const iframes = [...document.querySelectorAll('iframe')].map(f => f.src);
      const pvtEls = [...document.querySelectorAll('[class*="pvtArea"]')]
        .slice(0, 30)
        .map(el => ({ tag: el.tagName, cls: el.className, text: (el.textContent || '').trim().slice(0, 80) }));
      const consumoMatches = [...document.querySelectorAll('*')]
        .filter(el => el.children.length === 0 && /consumo/i.test(el.textContent || ''))
        .slice(0, 20)
        .map(el => ({ tag: el.tagName, cls: el.className, text: el.textContent.trim().slice(0, 80) }));
      return {
        title: document.title,
        url: location.href,
        totalElements: document.querySelectorAll('*').length,
        iframes,
        bodyTextSample: (document.body.innerText || '').slice(0, 3000),
        pvtEls,
        consumoMatches,
      };
    }).catch(e => ({ error: e.message }));

    const accountIds = await page.evaluate(() =>
      [...document.querySelectorAll('.pvtArea-account-select-option[data-target]')]
        .map(el => el.dataset.target)
        .filter(Boolean)
    ).catch(() => []);

    const clicked = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      const target = all.find(el => el.children.length === 0 && /mis consumos/i.test(el.textContent || ''));
      if (target) { target.click(); return true; }
      const container = all.find(el => /mis consumos/i.test(el.textContent || '') && el.textContent.trim().length < 40);
      if (container) { container.click(); return true; }
      return false;
    }).catch(() => false);

    await new Promise(r => setTimeout(r, 4000));

    const domInfo = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table')];
      return {
        tablesCount: tables.length,
        tablesHtml: tables.map(t => t.outerHTML.slice(0, 6000)),
        bodyHasError: /se ha producido un error/i.test(document.body.innerText),
        url: location.href,
      };
    }).catch(e => ({ error: e.message }));

    return {
      data: { ready, pageSnapshot, accountIds, clicked, domInfo, capturedResponses },
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
    // stealth:true + proxy residencial chileno: mismo fix ya usado en nubox-pdf.js
    // para el bloqueo de Incapsula que también afecta a enel.cl (confirmado por el
    // iframe "_Incapsula_Resource" devuelto en la primera prueba de este endpoint).
    const launchB64 = Buffer.from(JSON.stringify({ stealth: true })).toString('base64');
    const blRes = await fetch(
      `https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=120000&proxy=residential&proxyCountry=cl&proxySticky=true&launch=${launchB64}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: BROWSER_CODE, context: { cookies } })
      }
    );
    if (!blRes.ok) {
      const errText = await blRes.text();
      await guardarDebugViaGitHub({ ok: false, error: `Browserless ${blRes.status}: ${errText.slice(0, 800)}` });
      return res.status(500).json({ error: `Browserless ${blRes.status}: ${errText.slice(0, 800)}` });
    }
    const blData = await blRes.json();
    await guardarDebugViaGitHub({ ok: true, ...blData });
    return res.status(200).json(blData);
  } catch (e) {
    await guardarDebugViaGitHub({ ok: false, error: e.message });
    return res.status(500).json({ error: e.message });
  }
}
