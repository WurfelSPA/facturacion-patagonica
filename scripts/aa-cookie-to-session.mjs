/**
 * scripts/aa-cookie-to-session.mjs
 * Convierte el header "Cookie" copiado desde el navegador NORMAL (no
 * automatizado) del usuario en el formato storageState.json que usa
 * Playwright, para que aa-scraper.js reutilice una sesión 100% humana
 * y nunca tenga que tocar el login (que es lo que bloquea Imperva).
 *
 * Uso:
 *   1. En tu navegador normal, inicia sesión en aguasandinas.cl.
 *   2. Abre DevTools (F12) -> pestaña Network.
 *   3. Recarga la página de "Información de la cuenta" y haz clic en esa
 *      petición en la lista.
 *   4. En "Headers" -> "Request Headers", busca "Cookie:" y copia TODO
 *      su valor (una sola línea larga con varios pares nombre=valor).
 *   5. Pega ese valor en scripts/aa-cookie-raw.txt (crea el archivo).
 *   6. Corre: node scripts/aa-cookie-to-session.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RAW_PATH     = path.join(__dirname, 'aa-cookie-raw.txt');
const SESSION_PATH = process.env.AA_SESSION_PATH || path.join(__dirname, 'aa-session.json');
const DOMAIN       = 'www.aguasandinas.cl';

if (!fs.existsSync(RAW_PATH)) {
  console.error(`[aa-cookie-to-session] No existe ${RAW_PATH}.`);
  console.error('[aa-cookie-to-session] Pega ahí el valor del header "Cookie:" copiado desde DevTools (ver instrucciones en este archivo).');
  process.exit(1);
}

const raw = fs.readFileSync(RAW_PATH, 'utf-8').trim();
if (!raw) {
  console.error('[aa-cookie-to-session] El archivo aa-cookie-raw.txt está vacío.');
  process.exit(1);
}

const cookies = raw
  .split(';')
  .map(pair => pair.trim())
  .filter(Boolean)
  .map(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return null;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    return {
      name,
      value,
      domain: DOMAIN,
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 30 días
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    };
  })
  .filter(Boolean);

if (!cookies.length) {
  console.error('[aa-cookie-to-session] No se pudo parsear ninguna cookie del archivo. ¿Copiaste el header completo?');
  process.exit(1);
}

const storageState = { cookies, origins: [] };
fs.writeFileSync(SESSION_PATH, JSON.stringify(storageState, null, 2), 'utf-8');
console.log(`[aa-cookie-to-session] ${cookies.length} cookies guardadas en ${SESSION_PATH}`);
console.log('[aa-cookie-to-session] Puedes borrar aa-cookie-raw.txt ahora si quieres (contiene la sesión en texto plano).');
