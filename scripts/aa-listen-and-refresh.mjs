/**
 * scripts/aa-listen-and-refresh.mjs
 * Escucha en http://127.0.0.1:8934 a que la extensión "aa-extension" envíe
 * las cookies de aguasandinas.cl. Al recibirlas:
 *   1. Las guarda como sesión de Playwright en aa-session.json.
 *   2. Corre aa-scraper.js (recorre las cuentas con esa sesión).
 *   3. Si el scraper OK, hace commit + push de aa-cache.json.
 *
 * Flujo para el usuario: loguearse en aguasandinas.cl normalmente -> correr
 * este script (aa-listen-and-refresh.bat) -> hacer clic en el botón de la
 * extensión. Todo lo demás es automático.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = 8934;
const SESSION_PATH = path.join(__dirname, 'aa-session.json');
const TIMEOUT_MS = 5 * 60 * 1000;

function toStorageState(cookies) {
  return {
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.session ? -1 : (c.expirationDate || (Date.now() / 1000 + 3600)),
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite === 'no_restriction' ? 'None'
              : c.sameSite === 'lax' ? 'Lax'
              : c.sameSite === 'strict' ? 'Strict'
              : 'Lax'
    })),
    origins: []
  };
}

function runStep(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} salió con código ${code}`)));
  });
}

async function onCookiesRecibidas(cookies) {
  console.log(`[aa-listen] ${cookies.length} cookies recibidas: ${cookies.map(c => c.name).join(', ')}`);
  const criticas = ['JSESSIONID', 'reese84', 'incap_ses'];
  const faltantes = criticas.filter(nombre => !cookies.some(c => c.name.includes(nombre)));
  if (faltantes.length) console.warn(`[aa-listen] AVISO: faltan cookies críticas: ${faltantes.join(', ')}`);
  console.log('[aa-listen] Guardando sesión...');
  fs.writeFileSync(SESSION_PATH, JSON.stringify(toStorageState(cookies), null, 2), 'utf-8');

  console.log('[aa-listen] Corriendo scraper (puede tardar unos minutos)...');
  try {
    await runStep('node', ['scripts/aa-scraper.js']);
  } catch (e) {
    console.error('[aa-listen] El scraper falló:', e.message);
    console.error('[aa-listen] No se hace push (para no subir datos a medio actualizar).');
    return;
  }

  console.log('[aa-listen] Scraper OK. Haciendo commit y push...');
  try {
    await runStep('git', ['add', 'aa-cache.json']);
    await runStep('cmd', ['/c', 'git diff --staged --quiet && echo "[aa-listen] Sin cambios" || git commit -m "chore: actualizar cache AA (extension)"']);
    await runStep('git', ['push']);
    console.log('[aa-listen] Listo. Todo actualizado.');
  } catch (e) {
    console.error('[aa-listen] Error en git:', e.message);
  }
}

let atendido = false;
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  if (req.method !== 'POST' || req.url !== '/import') {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    try {
      const { cookies } = JSON.parse(body);
      if (!cookies || !cookies.length) throw new Error('Sin cookies en el body');
      res.end(JSON.stringify({ ok: true }));
      atendido = true;
      server.close();
      await onCookiesRecibidas(cookies);
    } catch (e) {
      res.end(JSON.stringify({ ok: false, error: e.message }));
      console.error('[aa-listen] Error procesando cookies:', e.message);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('======================================================================');
  console.log(' Escuchando en http://127.0.0.1:' + PORT);
  console.log(' 1. Si no lo has hecho, inicia sesión normalmente en aguasandinas.cl');
  console.log(' 2. Haz clic en el ícono de la extensión "AA Session Exporter"');
  console.log(' 3. Haz clic en el botón "Enviar sesión al scraper local"');
  console.log(' Esta ventana hará todo lo demás sola (leer cuentas + subir cambios).');
  console.log('======================================================================');
});

setTimeout(() => {
  if (!atendido) {
    console.log('[aa-listen] Timeout (5 min) sin recibir la sesión. Cerrando.');
    server.close();
    process.exit(1);
  }
}, TIMEOUT_MS);
