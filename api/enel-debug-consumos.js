/**
 * TEMPORAL — reconocimiento de la sección "Mis Consumos" del portal Enel.
 * Reutiliza el login exacto de enel-refresh.js. Para UNA sola cuenta (la
 * primera del selector), expande "Mis consumos" y devuelve la tabla
 * resultante (HTML crudo + intento de parseo) para ver la estructura real
 * antes de escribir la lógica definitiva. Se borra una vez que sirvió.
 */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

const BROWSER_CODE = `
  export default async function ({ page, context }) {
    const PORTAL = 'https://www.enel.cl';
    await page.goto(PORTAL + '/es/Ingresar.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

    await Promise.race([
      page.waitForSelector('#username', { timeout: 20000 }),
      page.waitForSelector('.pvtArea-account-select-option', { timeout: 20000 }),
    ]).catch(() => {});

    async function firstVisible(selector) {
      for (const handle of await page.$$(selector)) {
        try { if (await handle.boundingBox()) return handle; } catch (_) {}
      }
      return null;
    }

    const usernameInput = await firstVisible('#username');
    if (usernameInput) {
      await usernameInput.click({ clickCount: 3 });
      await usernameInput.type(context.rut, { delay: 60 });
      const passInput = await firstVisible('#password, input[type="password"]');
      await passInput.click({ clickCount: 3 });
      await passInput.type(context.clave, { delay: 60 });
      const submitBtn = await firstVisible('button[type="submit"], input[type="submit"]');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
        submitBtn ? submitBtn.click() : passInput.press('Enter')
      ]);
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

    if (!page.url().includes('private-area')) {
      throw new Error('Login fallido: URL actual = ' + page.url());
    }

    // Capturar cualquier respuesta JSON que se dispare al expandir "Mis consumos"
    const capturedResponses = [];
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        const url = resp.url();
        if (ct.includes('json') && (url.toLowerCase().includes('consum') || url.toLowerCase().includes('reading') || url.toLowerCase().includes('lectura'))) {
          const body = await resp.text();
          capturedResponses.push({ url, body: body.slice(0, 5000) });
        }
      } catch (_) {}
    });

    // Buscar y hacer clic en "Mis consumos"
    const clicked = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      const target = all.find(el =>
        el.children.length === 0 &&
        /mis consumos/i.test(el.textContent || '')
      );
      if (target) { target.click(); return true; }
      // fallback: buscar contenedor clicable con ese texto
      const container = all.find(el => /mis consumos/i.test(el.textContent || '') && el.textContent.trim().length < 40);
      if (container) { container.click(); return true; }
      return false;
    });

    await new Promise(r => setTimeout(r, 4000));

    const domInfo = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table')];
      const tablesHtml = tables.map(t => t.outerHTML.slice(0, 4000));
      const bodyHasError = /se ha producido un error/i.test(document.body.innerText);
      const lecturaMatches = (document.body.innerText.match(/.{0,80}lectura.{0,80}/gi) || []).slice(0, 20);
      return { tablesCount: tables.length, tablesHtml, bodyHasError, lecturaMatches, url: location.href };
    });

    return {
      data: { clicked, domInfo, capturedResponses },
      type: 'application/json'
    };
  }
`;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Variable de entorno desechable creada solo para este endpoint temporal
  // (evita depender de SYNC_SECRET, que quedó marcado como Sensitive en Vercel
  // y ya no se puede leer desde el dashboard).
  const debugKey = process.env.ENEL_DEBUG_KEY;
  if (!debugKey || req.query.debugkey !== debugKey) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const RUT = process.env.ENEL_USER || process.env.ENEL_RUT;
  const CLAVE = process.env.ENEL_PASS || process.env.ENEL_CLAVE;
  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
  if (!RUT || !CLAVE) return res.status(500).json({ error: 'Faltan credenciales Enel' });
  if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  try {
    const blRes = await fetch(`https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: BROWSER_CODE, context: { rut: RUT, clave: CLAVE } })
    });
    if (!blRes.ok) {
      const errText = await blRes.text();
      return res.status(500).json({ error: `Browserless ${blRes.status}: ${errText.slice(0, 500)}` });
    }
    const blData = await blRes.json();
    return res.status(200).json(blData);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
