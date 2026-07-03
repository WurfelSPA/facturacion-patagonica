/**
 * nubox-scraper.js v30 - Puppeteer-core con Chromium del sistema (Docker).
 * Poll hasta 180s para que SSRS renderice el reporte en el DOM.
 */
const puppeteer = require('puppeteer-core');
const CHROMIUM  = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

async function scrapeNuboxResumen() {
  const utn = process.env.NUBOX_UTN;
  if (!utn) throw new Error('Falta NUBOX_UTN');

  const targetUrl = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx' +
    '?action=Ventas&utn=' + encodeURIComponent(utn);

  let browser = null;
  try {
    console.log('[scraper] Lanzando Chromium desde', CHROMIUM);
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-gpu','--no-first-run','--no-zygote','--single-process'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    console.log('[scraper] Navegando a Nubox...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const cur = page.url();
    if (/login|account/i.test(cur)) throw new Error('UTN_EXPIRED: ' + cur);

    console.log('[scraper] Esperando que SSRS renderice (hasta 180s)...');
    let found = false; let lastTds = 0;
    const deadline = Date.now() + 180000;
    const t0 = Date.now(); let lastLog = Date.now();

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const chk = await page.evaluate(() => {
        const tds = document.querySelectorAll('td');
        let h = false;
        for (let i = 0; i < tds.length; i++) {
          if (/[A-Za-z]{3}-\d{2}/.test(tds[i].innerText || '')) { h = true; break; }
        }
        return { h, n: tds.length };
      });
      lastTds = chk.n;
      if (chk.h) { found = true; break; }
      if (Date.now() - lastLog > 15000) {
        const s = Math.round((Date.now() - t0) / 1000);
        console.log('[scraper] Esperando SSRS... ' + s + 's, tds=' + chk.n);
        lastLog = Date.now();
      }
    }

    if (!found) throw new Error('TIMEOUT_180S: reporte no aparecio en 180s (tds=' + lastTds + ')');

    console.log('[scraper] Reporte detectado — extrayendo datos...');
    const data = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td'));
      let hCell = null;
      for (let i = 0; i < allTds.length; i++) {
        if (/[A-Za-z]{3}-\d{2}/.test(allTds[i].innerText || '')) { hCell = allTds[i]; break; }
      }
      if (!hCell) return { error: 'no header cell' };

      const MESES = []; const re = /([A-Za-z]{3}-\d{2})/g; let m;
      while ((m = re.exec(hCell.innerText || '')) !== null) MESES.push(m[1]);

      const rutPat = /^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/;
      const results = []; const seen = {};
      allTds.forEach(rc => {
        const rut = (rc.innerText || '').trim();
        if (!rutPat.test(rut) || seen[rut]) return;
        seen[rut] = true;
        const row = rc.closest('tr'); if (!row) return;
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        const ri = cells.indexOf(rut); if (ri < 0) return;
        const nombre = cells[ri + 2] || cells[ri + 1] || '';
        const ms = ri + 4; const meses = {};
        for (let j = 0; j < MESES.length; j++) {
          const v = (cells[ms + j] || '').trim();
          if (v) { const n = parseInt(v.replace(/\./g, ''), 10); if (!isNaN(n) && n > 0) meses[MESES[j]] = n * 1000; }
        }
        const tot = parseInt((cells[cells.length - 1] || '').replace(/\./g, ''), 10) * 1000 || 0;
        results.push({ rut, nombre, meses, total: tot });
      });
      return { clientes: results, MESES };
    });

    if (data.error) throw new Error('EXTRACT_FAIL: ' + data.error);
    console.log('[scraper] OK - ' + data.clientes.length + ' clientes, meses: ' + data.MESES.join(', '));
    return { clientes: data.clientes, meses: data.MESES };

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { scrapeNuboxResumen };
