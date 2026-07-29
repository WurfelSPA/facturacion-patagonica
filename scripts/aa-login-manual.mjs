/**
 * scripts/aa-login-manual.mjs
 * Abre un Chrome VISIBLE en la página de login de Aguas Andinas para que
 * un humano se loguee de verdad (sin automatizar el submit, que es lo que
 * Imperva bloquea — ver aa-scraper.js). Al confirmar, guarda la sesión
 * (cookies) en aa-session.json para que aa-scraper.js la reutilice sin
 * volver a pasar por el login.
 *
 * Ejecutar cuando la sesión guardada expire (aa-scraper.js avisa cuándo).
 */

import { chromium } from 'playwright';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL     = 'https://www.aguasandinas.cl';
const LOGIN_PATH    = '/web/aguasandinas/login';
const SESSION_PATH  = process.env.AA_SESSION_PATH || path.join(__dirname, 'aa-session.json');

function esperarEnter(mensaje) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(mensaje, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log('[aa-login-manual] Abriendo Chrome...');
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1366,900'] });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 850 },
    locale: 'es-CL',
    timezoneId: 'America/Santiago'
  });
  const page = await context.newPage();
  await page.goto(BASE_URL + LOGIN_PATH, { waitUntil: 'domcontentloaded' });

  console.log('');
  console.log('======================================================================');
  console.log(' Se abrió una ventana de Chrome con la página de login de Aguas Andinas.');
  console.log(' Inicia sesión ahí normalmente (RUT + contraseña, como siempre).');
  console.log(' Cuando ya estés adentro (veas la información de tu cuenta), vuelve');
  console.log(' a esta terminal y presiona ENTER para guardar la sesión.');
  console.log('======================================================================');
  console.log('');
  await esperarEnter('Presiona ENTER cuando hayas iniciado sesión... ');

  const stillOnLogin = page.url().includes('/login') || await page.$('input[type="password"]');
  if (stillOnLogin) {
    console.warn('[aa-login-manual] Aviso: la página todavía parece mostrar el login.');
    await esperarEnter('Si de verdad ya iniciaste sesión, presiona ENTER para guardar igual (o Ctrl+C para cancelar)... ');
  }

  await context.storageState({ path: SESSION_PATH });
  console.log(`[aa-login-manual] Sesión guardada en ${SESSION_PATH}`);
  await browser.close();
}

main().catch(e => {
  console.error('[aa-login-manual] Error:', e.message);
  process.exit(1);
});
