/**
 * scripts/aa-scraper.js
 * Scrapea Aguas Andinas con Playwright y escribe aa-cache.json.
 * Variables de entorno: AGUAS_RUT, AGUAS_CLAVE
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL     = 'https://www.aguasandinas.cl';
const LOGIN_PATH   = '/web/aguasandinas/login';
const ACCOUNT_PATH = '/web/aguasandinas/informacion-de-la-cuenta';
const CACHE_PATH   = path.join(__dirname, '..', 'aa-cache.json');

const RUT   = process.env.AGUAS_RUT;
const CLAVE = process.env.AGUAS_CLAVE;

if (!RUT || !CLAVE) {
  console.error('Faltan AGUAS_RUT o AGUAS_CLAVE');
  process.exit(1);
}

function fmtDeuda(text) {
  if (!text) return '$0';
  const s = text.trim().replace(/\s/g, '');
  if (!s || s === '$0' || s === '0') return '$0';
  return s.startsWith('$') ? s : '$' + s;
}

async function main() {
  console.log('[aa-scraper] Iniciando Playwright...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'es-CL',
    timezoneId: 'America/Santiago'
  });

  // Ocultar webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-CL', 'es'] });
  });

  const page = await context.newPage();

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────────
    console.log('[aa-scraper] Navegando al login...');
    await page.goto(BASE_URL + LOGIN_PATH, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Verificar si hay challenge de Incapsula
    const bodyHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 300) || '');
    if (bodyHtml.includes('_Incapsula_Resource') || bodyHtml.includes('incapsula')) {
      console.log('[aa-scraper] Detectado challenge Incapsula, esperando...');
      await page.waitForTimeout(5000);
    }

    await page.waitForSelector('input', { timeout: 30000 });

    const rutInput = await page.$(
      'input[name*="rut"], input[id*="rut"], input[name*="Rut"], ' +
      'input[placeholder*="RUT"], input[placeholder*="rut"], ' +
      'input[name*="usuario"], input[type="text"]'
    );
    const claveInput = await page.$('input[type="password"]');

    if (!rutInput || !claveInput) {
      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map(i => ({ type: i.type, name: i.name, id: i.id }))
      );
      throw new Error('Campos login no encontrados. Inputs: ' + JSON.stringify(inputs).slice(0, 300));
    }

    await rutInput.fill(RUT);
    await page.waitForTimeout(500);
    await claveInput.fill(CLAVE);
    await page.waitForTimeout(500);

    const submitBtn = await page.$('button[type="submit"], input[type="submit"], .btn-login, button[class*="login"]');
    if (submitBtn) await submitBtn.click();
    else await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });

    if (page.url().includes('login')) {
      throw new Error('Login fallido — verificar credenciales. URL: ' + page.url());
    }
    console.log('[aa-scraper] Login OK. URL: ' + page.url());

    // ── 2. Obtener links de cuentas ───────────────────────────────────────────
    await page.goto(BASE_URL + ACCOUNT_PATH, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const accountLinks = await page.evaluate(() =>
      [...document.querySelectorAll('a')]
        .filter(a => /\d{6,}-\d/.test(a.textContent) && a.href.includes('cuentaRender'))
        .map(a => ({
          id: (a.textContent.match(/(\d{6,}-\d)/) || [])[1],
          href: a.href
        }))
        .filter(l => l.id)
    );

    if (!accountLinks.length) {
      throw new Error('No se encontraron cuentas en ' + page.url());
    }
    console.log(`[aa-scraper] ${accountLinks.length} cuentas encontradas`);

    // ── 3. Scrapear cada cuenta ───────────────────────────────────────────────
    const accounts = {};
    const existingCache = fs.existsSync(CACHE_PATH)
      ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
      : { accounts: {} };

    for (let i = 0; i < accountLinks.length; i++) {
      const link = accountLinks[i];
      try {
        await page.goto(link.href, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000);

        const deudaRaw = await page.$eval('span.total_deuda', el => el.textContent.trim()).catch(() => '$0');
        const divText  = await page.$eval('#divmonto', el => el.innerText).catch(() => '');
        const fecha    = (divText.match(/\d{2}\/\d{2}\/\d{4}/) || [])[0] || null;

        const nombre = await page.evaluate(() => {
          const sels = ['.nombre-cuenta', '.nombre_cliente', '#nombre-cliente',
                        '.razon-social', '#razon-social', '.cuenta-nombre', '.client-name'];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el && el.textContent.trim()) return el.textContent.trim();
          }
          for (const tr of [...document.querySelectorAll('tr')]) {
            const cells = [...tr.querySelectorAll('td,th')];
            for (let j = 0; j < cells.length - 1; j++) {
              const lbl = cells[j].textContent.trim().toLowerCase();
              if (lbl.includes('razón social') || lbl.includes('razon social') || lbl === 'nombre') {
                const val = cells[j + 1].textContent.trim();
                if (val) return val;
              }
            }
          }
          return null;
        }).catch(() => null);

        accounts[link.id] = { deuda: fmtDeuda(deudaRaw), vencimiento: fecha, nombre };
        console.log(`[aa-scraper] ${i + 1}/${accountLinks.length} ${link.id}: ${fmtDeuda(deudaRaw)}`);
      } catch (e) {
        console.warn(`[aa-scraper] Error ${link.id}:`, e.message);
        accounts[link.id] = existingCache.accounts?.[link.id] || { deuda: null, error: e.message };
      }

      await page.waitForTimeout(300);
    }

    // ── 4. Guardar cache ──────────────────────────────────────────────────────
    const cacheData = {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: 'github-actions',
      accounts
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2), 'utf-8');
    console.log(`[aa-scraper] Cache guardado: ${Object.keys(accounts).length} cuentas`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('[aa-scraper] Error fatal:', e.message);
  process.exit(1);
});
