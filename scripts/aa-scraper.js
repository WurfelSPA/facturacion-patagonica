/**
 * scripts/aa-scraper.js
 * Scrapea Aguas Andinas con Playwright y escribe aa-cache.json.
 *
 * Login automatizado: Imperva/Incapsula bloquea el submit del formulario de
 * login incluso desde IP local (ver debug-post-login.png histórico, "Access
 * Denied Error 15"). En vez de pelear con esa detección, este script SIEMPRE
 * reutiliza una sesión ya autenticada guardada en AA_SESSION_PATH (generada
 * por scripts/aa-login-manual.mjs, donde un humano se loguea de verdad en un
 * navegador visible). Si la sesión no existe o expiró, el script falla con
 * un mensaje claro en vez de intentar loguearse solo.
 *
 * Variables de entorno:
 *   AA_SESSION_PATH  - ruta al storageState.json (default: scripts/aa-session.json)
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL     = 'https://www.aguasandinas.cl';
const ACCOUNT_PATH = '/web/aguasandinas/informacion-de-la-cuenta';
const CACHE_PATH    = path.join(__dirname, '..', 'aa-cache.json');
const SESSION_PATH  = process.env.AA_SESSION_PATH || path.join(__dirname, 'aa-session.json');

if (!fs.existsSync(SESSION_PATH)) {
  console.error(`[aa-scraper] No hay sesión guardada en ${SESSION_PATH}.`);
  console.error('[aa-scraper] Ejecuta primero: node scripts/aa-login-manual.mjs (o scripts\\aa-login-manual.bat)');
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
    storageState: SESSION_PATH,
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
    // ── 1. Verificar sesión (sin loguearse — ver cabecera del archivo) ─────────
    console.log('[aa-scraper] Verificando sesión guardada...');
    await page.goto(BASE_URL + ACCOUNT_PATH, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'debug-sesion.png', fullPage: false }).catch(() => null);

    if (page.url().includes('/login') || await page.$('input[type="password"]')) {
      console.error('[aa-scraper] La sesión guardada expiró o no es válida.');
      console.error('[aa-scraper] Ejecuta: node scripts/aa-login-manual.mjs (o scripts\\aa-login-manual.bat) para volver a loguearte.');
      throw new Error('Sesión expirada — URL: ' + page.url());
    }
    console.log('[aa-scraper] Sesión válida. URL: ' + page.url());

    // ── 2. Obtener links de cuentas (misma página cargada en el paso 1) ────────
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
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2200 + Math.random() * 1200);

        // Si a mitad de la corrida la sesión se degrada (probable rate-limit
        // por navegar demasiado rápido entre cuentas), detectarlo temprano y
        // frenar en vez de seguir escribiendo $0 falsos para el resto.
        if (page.url().includes('/login') || await page.$('input[type="password"]')) {
          throw new Error('SESION_PERDIDA_A_MITAD_DE_CORRIDA');
        }

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
        if (e.message === 'SESION_PERDIDA_A_MITAD_DE_CORRIDA') {
          throw new Error(`Sesión perdida en la cuenta ${i + 1}/${accountLinks.length} (${link.id}) — abortando sin guardar cache parcial. Vuelve a exportar la sesión.`);
        }
        console.warn(`[aa-scraper] Error ${link.id}:`, e.message);
        accounts[link.id] = existingCache.accounts?.[link.id] || { deuda: null, error: e.message };
      }

      // Cada 12 cuentas, pausa más larga para no verse como ráfaga continua.
      if ((i + 1) % 12 === 0) {
        console.log('[aa-scraper] Pausa breve...');
        await page.waitForTimeout(6000 + Math.random() * 3000);
      } else {
        await page.waitForTimeout(500);
      }
    }

    // ── 4. Guardar cache ──────────────────────────────────────────────────────
    const cacheData = {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
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
