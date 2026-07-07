export default async function({ page }) {
  const RUT   = __RUT__;
  const CLAVE = __CLAVE__;
  const BASE  = 'https://www.aguasandinas.cl';

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────────
    await page.goto(BASE + '/web/aguasandinas/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1200));

    if (!page.url().includes('/login')) {
      return { error: 'LOGIN_PAGE_NOT_FOUND: ' + page.url() };
    }

    await page.type('#rut2', RUT, { delay: 70 });
    await new Promise(r => setTimeout(r, 400));
    await page.type('#clave', CLAVE, { delay: 70 });
    await new Promise(r => setTimeout(r, 600));

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('#btn-submit-login'),
    ]);

    if (page.url().includes('/login')) {
      return { error: 'LOGIN_FAILED', url: page.url() };
    }

    // ── 2. MIS CUENTAS ────────────────────────────────────────────────────────
    await page.goto(BASE + '/web/aguasandinas/mis-cuentas', { waitUntil: 'networkidle2', timeout: 45000 });
    // Extra wait for reCAPTCHA v3 + portlet initialization
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
        // Wait for table refresh
        await new Promise(r => setTimeout(r, 4000));
      }

      // Read boleta metadata from DOM
      const boletas = await page.evaluate(() => {
        const rows  = Array.from(document.querySelectorAll('table tr')).slice(1);
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
          // Register response waiter BEFORE triggering the download
          const descargaPromise = page.waitForResponse(
            r => r.status() === 200 && (
              r.url().includes('%2Fdescarga%2Fdocumento') ||
              r.url().includes('/descarga/documento')
            ),
            { timeout: 25000 }
          );

          // Trigger download (calls validarCaptcha3 XHR, then /descarga/documento XHR)
          await page.evaluate((idx) => {
            if (typeof validaciones === 'function') {
              validaciones(idx, false, 'descargaDocumento');
            } else {
              throw new Error('validaciones() not defined on page');
            }
          }, boleta.idx);

          const resp        = await descargaPromise;
          const contentType = resp.headers()['content-type'] || '';
          const buffer      = await resp.buffer();

          if (buffer.length < 100) {
            failures.push({ boleta, error: 'Empty PDF response (len=' + buffer.length + '), captcha may have failed' });
          } else {
            results.push({
              nroFactura:  boleta.nroFactura,
              mes:         boleta.mes,
              vencimiento: boleta.vencimiento,
              monto:       boleta.monto,
              estado:      boleta.estado,
              page:        pgNum,
              contentType,
              size:        buffer.length,
              pdfBase64:   buffer.toString('base64'),
            });
          }

          // Small pause between downloads (rate limiting + reCAPTCHA)
          await new Promise(r => setTimeout(r, 2500));

        } catch (err) {
          failures.push({ boleta, error: err.message });
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    return {
      ok:       true,
      total:    results.length,
      failures: failures.length,
      results,
      failureList: failures,
    };

  } catch (topErr) {
    return {
      error: topErr.message,
      stack: topErr.stack ? topErr.stack.substring(0, 600) : '',
    };
  }
}
