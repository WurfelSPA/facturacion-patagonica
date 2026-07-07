export default async function({ page }) {
  const RUT   = __RUT__;
  const CLAVE = __CLAVE__;
  const BASE  = 'https://www.aguasandinas.cl';

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CL,es;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-CL', 'es'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });

  async function waitForAny(selectors, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        try { if (await page.$(sel)) return sel; } catch(e) {}
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  try {
    await page.goto(BASE + '/web/aguasandinas/login', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));

    const afterLoginUrl = page.url();

    if (!afterLoginUrl.includes('/login')) {
      // Ya autenticado
    } else {
      const rutSel = await waitForAny([
        '#rut2',
        'input[placeholder*="RUT" i]',
        'input[placeholder*="Rut" i]',
        'input[name*="rut" i]',
        'input[id*="rut" i]',
        'form input[type="text"]',
        'input[type="text"]',
      ], 20000);

      if (!rutSel) {
        const bodyHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 1500) || 'EMPTY');
        const allInputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map(i => `[id=${i.id}][name=${i.name}][type=${i.type}]`).join(', ')
        );
        return { error: 'LOGIN_FORM_NOT_FOUND', url: afterLoginUrl, bodyHtml, allInputs };
      }

      const claveSel = await waitForAny(['#clave', 'input[type="password"]'], 5000) || 'input[type="password"]';
      const submitSel = await waitForAny(['#btn-submit-login', 'button[type="submit"]', 'input[type="submit"]'], 5000) || 'button[type="submit"]';

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
        // Capturar HTML para ver si hay CAPTCHA o error message
        await new Promise(r => setTimeout(r, 2000));
        const bodyHtml = await page.evaluate(() => document.body?.innerHTML?.slice(0, 2000) || 'EMPTY');
        const bodyText = await page.evaluate(() => document.body?.innerText?.trim()?.slice(0, 500) || 'EMPTY');
        return { error: 'LOGIN_FAILED', url: page.url(), bodyText, bodyHtml };
      }
    }

    // ── MIS CUENTAS ───────────────────────────────────────────────────────────
    await page.goto(BASE + '/web/aguasandinas/mis-cuentas', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));

    const results  = [];
    const failures = [];

    for (let pgNum = 1; pgNum <= 3; pgNum++) {
      if (pgNum > 1) {
        const clicked = await page.evaluate((pn) => {
          const link = Array.from(document.querySelectorAll('a.paginadoraa')).find(l => l.textContent.trim() === String(pn));
          if (!link) return false;
          link.click();
          return true;
        }, pgNum);
        if (!clicked) { failures.push({ page: pgNum, error: 'Pagination link not found' }); break; }
        await new Promise(r => setTimeout(r, 4000));
      }

      const boletas = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
        return rows.map((row, i) => {
          const cells = Array.from(row.querySelectorAll('td'));
          return {
            idx: i,
            nroFactura: cells[0]?.textContent?.trim() || '',
            mes: cells[1]?.textContent?.trim() || '',
            vencimiento: cells[2]?.textContent?.trim() || '',
            monto: cells[3]?.textContent?.trim() || '',
            estado: cells[4]?.textContent?.trim() || '',
          };
        }).filter(b => b.nroFactura && /\d{6,}/.test(b.nroFactura));
      });

      if (boletas.length === 0) { failures.push({ page: pgNum, error: 'No boletas found' }); continue; }

      for (const boleta of boletas) {
        try {
          const waiter = page.waitForResponse(
            r => r.url().includes('/descarga/documento') && r.request().method() === 'POST',
            { timeout: 25000 }
          );
          await page.evaluate((idx) => {
            if (typeof validaciones === 'function') validaciones(idx, false, 'descargaDocumento');
          }, boleta.idx);
          const pdfResp = await waiter;
          const buffer  = await pdfResp.buffer();
          results.push({ ...boleta, pdfBase64: buffer.toString('base64'), pdfSize: buffer.length });
          await new Promise(r => setTimeout(r, 800));
        } catch (err) {
          failures.push({ ...boleta, error: err.message.slice(0, 200) });
        }
      }
    }

    return { ok: true, total: results.length, failures: failures.length, results, failureList: failures };

  } catch (err) {
    return { error: err.message.slice(0, 500) };
  }
}
