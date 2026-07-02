/**
 * render-service/nubox-scraper.js
 *
 * Usa Puppeteer (Chromium headless) para navegar al Dashboard Nubox y
 * extraer los datos del "Resumen de Ventas" directamente desde el DOM.
 *
 * Flujo:
 *   1. Lanzar Chrome headless
 *   2. Navegar a Dashboard.aspx?action=Ventas&utn=TOKEN
 *   3. Esperar a que el ReportViewer cargue los datos (detectar celdas con RUT)
 *   4. Extraer meses dinámicamente del encabezado + valores por cliente
 *   5. Retornar { clientes, meses }
 */

const puppeteer = require('puppeteer');

const DASHBOARD = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas';

async function scrapeNuboxResumen() {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN en env vars');

  const url = `${DASHBOARD}&utn=${encodeURIComponent(utn)}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

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
    // El ReportViewer de Nubox puede tardar hasta 30s en renderizar
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
      // 1. Detectar columnas de meses dinámicamente desde el encabezado
      const allTds = document.querySelectorAll('td');

      // El encabezado tiene "Cliente", meses como "Ene-26", y "Total" en el mismo texto
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

      // 2. Extraer filas de clientes (celdas con patrón RUT)
      const rutPattern = /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/;
      const rutCells = Array.from(allTds).filter(td =>
        rutPattern.test(td.innerText.trim())
      );

      const results = [];
      const seen = new Set();

      rutCells.forEach(rutCell => {
        const rut = rutCell.innerText.trim();
        if (seen.has(rut)) return; // RUT duplicado por rendering del ReportViewer
        seen.add(rut);

        const row = rutCell.closest('tr');
        if (!row) return;

        // Estructura de la fila: [vacío, RUT, RUT, Nombre, Nombre, m1..m12, Total]
        const cells = Array.from(row.querySelectorAll('td')).map(c =>
          c.innerText.trim()
        );
        const rutIdx = cells.indexOf(rut);
        if (rutIdx < 0) return;

        // Nombre está 2 posiciones después (skip RUT duplicado)
        const nombre = cells[rutIdx + 2] || cells[rutIdx + 1] || '';

        // Los meses empiezan 4 posiciones después del RUT
        const monthStart = rutIdx + 4;

        const meses = {};
        for (let i = 0; i < MESES.length; i++) {
          const val = (cells[monthStart + i] || '').trim();
          if (val !== '') {
            const num = parseInt(val.replace(/\./g, ''), 10);
            // L