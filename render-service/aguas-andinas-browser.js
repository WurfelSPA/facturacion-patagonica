export default async function({ page }) {
  const RUT   = __RUT__;
  const CLAVE = __CLAVE__;
  const BASE  = 'https://www.aguasandinas.cl';

  // Helper: probar múltiples selectores hasta encontrar uno
  async function waitForAny(selectors, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        if (await page.$(sel)) return sel;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────────
    await page.goto(BASE + '/web/aguasandinas/login', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2000));

    const afterLoginUrl   = page.url();
    const afterLoginTitle = await page.title();

    // Si ya redirigió a página autenticada, está logueado
    if (!afterLoginUrl.includes('/login')) {
      // Posiblemente ya hay sesión activa — ir directo a mis-cuentas
      console.log('[aguas] Ya autenticado, URL:', afterLoginUrl);
    } else {
      // Buscar el campo RUT con selectores alternativos
      const rutSel = await waitForAny([
        '#rut2',
        'input[placeholder*="RUT" i]',
        'input[placeholder*="Rut" i]',
        'input[name*="rut" i]',
        'input[id*="rut" i]',
        'form input[type="text"]:first-of-type',
        'input[type="text"]',
      ], 15000);

      if (!rutSel) {
        // Devolver diagnóstico
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500));
        return { error: `LOGIN_FORM_NOT_FOUND. URL: ${afterLoginUrl}. Title: ${afterLoginTitle}. Body: ${bodyText}` };
      }

      console.log('[aguas] Selector RUT encontrado:', rutSel);

      // Campo contraseña
      const claveSel = await waitForAny([
        '#clave',
        'input[type="password"]',
        'input[placeholder*="contraseña" i]',
        'input[placeholder*="clave" i]',
      ], 5000) || 'input[type="password"]';

      // Submit
      const submitSel = await waitForAny([
        '#btn-submit-login',
        'button[type="submit"]',
        'input[type="submit"]',
        'button:contains("INGRESAR")',
      ], 5000) || 'button[type="submit"]';

      await page.click(rutSel);
      await page.type(rutSel, RUT, { delay: 70 });
      await new Promise(r => setTimeout(r, 400));

      await page.click(claveSel);
      await page.type(claveSel, CLAVE, { delay: 70 });
      await new Promise(r => setTimeout(r, 600));

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.click(submitSel),
      ]);

      if (page.url().includes('/login')) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300));
        return { error: 'LOGIN_FAILED. URL: ' + page.url() + '. Body: ' + bodyText };
      }
    }

    // ── 2. MIS CUENTAS ────────────────────────────────────────────────────────
    await page.goto(BASE + '/web/aguasandinas/mis-cuentas', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 4000));

    const results  = [];
    const failures = [];

    // ── 3. ITERATE 3 PAGES ────────────────────────────────────────────────────
    for (let pgNum = 1; pgNum <= 3; pgNum++) {
      if (pgNum > 1) {
        const clicked = await page.evaluate((pn) => {
          const links = Array.from(document.querySelectorAll('a.paginadoraa'));
          const link  = links.find(l => l.textContent.trim() === String(pn));
          if (!link) return false;
          link.click();
          return true;
        }, pgNum);

        if (!clicked) {
          failures.push({ page: pgNum, error: 'Pagination link not found' });
          break;
        }
        await new Promise(r => setTimeout(r, 4000));
      }

      // Read boleta metadata from DOM
      const boletas = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
        return rows.map((row, i) => {
          const cells = Array.from(row.querySelectorAll('td'));
          return {
            idx:         i,
            nroFactura:  cells[0]?.textContent?.trim() || '',
            mes:         cells[1]?.textContent?.trim() || '',
            vencimiento: cells[2]?.textContent?.trim() || '',
            monto:       cells[3]?.textContent?.trim() || '',
            estado:      cells[4]?.textContent?.trim() || '',
          };
        }).filter(b => b.nroFactura && /\d{6,}/.test(b.nroFactura));
      });

      if (boletas.length === 0) {
        failures.push({ page: pgNum, error: 'No boletas found in table' });
        continue;
      }

      // Download each boleta
      for (const boleta of boletas) {
        try {
          let pdfBase64 = null;

          const waiter = page.waitForResponse(
            r => r.url().includes('/descarga/documento') && r.request().method() === 'POST',
            { timeout: 25000 }
          );

          await page.evaluate((idx) => {
            if (typeof validaciones === 'function') {
              validaciones(idx, false, 'descargaDocumento');
            }
          }, boleta.idx);

          const pdfResp = await waiter;
          const buffer  = await pdfResp.buffer();
          pdfBase64     = buffer.toString('base64');

          results.push({ ...boleta, pdfBase64, pdfSize: buffer.length });
          await new Promise(r => setTimeout(r, 800));

        } catch (err) {
          failures.push({ ...boleta, error: err.message.slice(0, 200) });
        }
      }
    }

    return {
      ok:          true,
      total:       results.length,
      failures:    failures.length,
      results,
      failureList: failures,
    };

  } catch (err) {
    return { error: err.message.slice(0, 500) };
  }
}
