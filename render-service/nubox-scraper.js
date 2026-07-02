/**
 * render-service/nubox-scraper.js
 *
 * Usa puppeteer-core conectado a Browserless.io para navegar al Dashboard
 * de Nubox y extraer los datos del "Resumen de Ventas" desde el DOM.
 *
 * Browserless.io corre Chrome en la nube — no se necesita Chrome local.
 * La conexión se hace vía WebSocket usando BROWSERLESS_TOKEN.
 *
 * Flujo:
 *   1. Conectar a Browserless.io
 *   2. Navegar a Dashboard.aspx?action=Ventas&utn=TOKEN
 *   3. Esperar a que el ReportViewer cargue (aparecen celdas con RUT)
 *   4. Extraer meses dinámicamente del encabezado + valores por cliente
 *   5. Retornar { clientes, meses }
 */

const puppeteer = require('puppeteer-core');

const DASHBOARD = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas';

// Endpoints de Browserless.io (probar SFO primero, LON como fallback)
const BROWSERLESS_ENDPOINTS = [
  'wss://production-sfo.browserless.io',
  'wss://production-lon.browserless.io',
];

async function scrapeNuboxResumen() {
  const utn   = process.env.NUBOX_UTN;
  const token = process.env.BROWSERLESS_TOKEN;

  if (!utn)   throw new Error('Falta NUBOX_UTN en env vars');
  if (!token) throw new Error('Falta BROWSERLESS_TOKEN en env vars');

  const url = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  // Intentar cada endpoint de Browserless hasta que funcione
  let browser = null;
  let lastErr  = null;

  for (const endpoint of BROWSERLESS_ENDPOINTS) {
    try {
      const wsEndpoint = `${endpoint}?token=${token}`;
      console.log(`[scraper] Conectando a Browserless: ${endpoint}...`);
      browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
      });
      console.log('[scraper] Conectado a Browserless OK');
      break;
    } catch (err) {
      console.warn(`[scraper] ${endpoint} falló: ${err.message}`);
      lastErr = err;
      browser = null;
    }
  }

  if (!browser) {
    throw new Error('No se pudo conectar a Browserless.io: ' + (lastErr?.message || 'desconocido'));
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log('[scraper] Navegando a Dashboard.aspx...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Verificar que no redirigió a login
    const currentUrl = page.url();
    if (
      currentUrl.toLowerCase().includes('login') ||
      currentUrl.toLowerCase().includes('account')
    ) {
      throw new Error('UTN_EXPIRED: redirigido a ' + currentUrl);
    }

    console.log('[scraper] Página cargada, esperando tabla de reporte...');

    // Esperar hasta que aparezcan celdas con patrón RUT (XX.XXX.XXX-X)
    await page.waitForFunction(
      () => {
        const tds = document.querySelectorAll('td');
        return Array.from(tds).some(td =>
          /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/.test(td.innerText.trim())
        );
      },
      { timeout: 30000 }
    );

    console.log('[scraper] Tabla cargada, extrayendo datos...');

    const resultado = await page.evaluate(() => {
      const allTds = document.querySelectorAll('td');

      // 1. Detectar columnas de meses dinámicamente desde el encabezado
      const headerCell = Array.from(allTds).find(td => {
        const text = td.innerText;
        return (
          text.includes('Cliente') &&
          text.includes('Total') &&
          /[A-Z][a-z]{2}-\d{2}/.test(text)
        );
      });

      let MESES = [];
      if (headerCell) {
        const mesPattern = /([A-Z][a-z]{2}-\d{2})/g;
        MESES = [...headerCell.innerText.matchAll(mesPattern)].map(m => m[1]);
      }

      if (MESES.length === 0) {
        return {
          error: 'No se encontraron columnas de meses en el encabezado del reporte',
          MESES: [],
          clientes: [],
        };
      }

      // 2. Extraer filas de clientes
      const rutPattern = /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/;
      const rutCells   = Array.from(allTds).filter(td =>
        rutPattern.test(td.innerText.trim())
      );

      const results = [];
      const seen    = new Set();

      rutCells.forEach(rutCell => {
        const rut = rutCell.innerText.trim();
        if (seen.has(rut)) return; // RUT duplicado por rendering del ReportViewer
        seen.add(rut);

        const row = rutCell.closest('tr');
        if (!row) return;

        // Estructura