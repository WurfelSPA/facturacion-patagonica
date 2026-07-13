/**
 * POST /api/nubox-refresh  (o GET vía cron de Vercel)
 * Usa Browserless para hacer login en Nubox, navegar a Resumen de Ventas,
 * descargar el Excel y actualizar nubox-resumen-cache.json vía GitHub API.
 *
 * Env vars requeridas:
 *   NUBOX_API_USER     - RUT de acceso a Nubox (ej: 96673250-4)
 *   NUBOX_API_PASS     - Clave de Nubox
 *   BROWSERLESS_TOKEN  - Token de production-sfo.browserless.io
 *   GITHUB_TOKEN       - Personal Access Token con permiso repo
 *   GITHUB_REPO        - "usuario/repositorio"
 *   SYNC_SECRET        - Secreto para autenticar llamadas manuales
 */

import XLSX from 'xlsx';

// ── Mapa de abreviaciones de mes a nombre completo ────────────────────────────
const MES_MAP = {
  'Ene':'Enero','Feb':'Febrero','Mar':'Marzo','Abr':'Abril',
  'May':'Mayo','Jun':'Junio','Jul':'Julio','Ago':'Agosto',
  'Sep':'Septiembre','Oct':'Octubre','Nov':'Noviembre','Dic':'Diciembre'
};

// ── Parseo del Excel de Nubox (formato Resumen de Ventas) ─────────────────────
function parseNuboxExcel(buffer) {
  const wb   = XLSX.read(buffer, { type: 'buffer' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const rutRe   = /^\d{1,2}[.\s]?\d{3}[.\s]?\d{3}-[\dkK]$/;
  const monthRe = /^[A-Z][a-z]{2}-\d{2}$/;

  // Normalizar RUT a formato XX.XXX.XXX-X
  function normRut(r) {
    const clean = String(r).replace(/\./g,'').replace(/\s/g,'');
    const dash  = clean.indexOf('-');
    if (dash < 1) return String(r);
    const num = clean.slice(0, dash);
    const dv  = clean.slice(dash + 1).toUpperCase();
    return num.replace(/\B(?=(\d{3})+(?!\d))/g,'.') + '-' + dv;
  }

  // Buscar fila de encabezado que contenga meses (Ago-25, Sep-25 …)
  let headerIdx = -1;
  let monthCols = [];   // [{ abbrev: 'Ago-25', idx: N }, ...]

  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].map(c => String(c).trim());
    const mths  = cells.reduce((acc, c, j) => {
      if (monthRe.test(c)) acc.push({ abbrev: c, idx: j });
      return acc;
    }, []);
    if (mths.length >= 6) { headerIdx = i; monthCols = mths; break; }
  }

  if (headerIdx === -1) {
    // Diagnóstico: primeras filas para debug
    const sample = rows.slice(0, 10).map((r, i) => `[${i}] ${r.slice(0,6).join(' | ')}`).join('\n');
    throw new Error('No se encontró encabezado de meses en el Excel.\nPrimeras filas:\n' + sample);
  }

  const columnas = monthCols.map(m => {
    const [mon, yr] = m.abbrev.split('-');
    return `${MES_MAP[mon] || mon} 20${yr}`;
  });

  const clientes = [];
  const seen     = new Set();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;

    // Buscar la primera celda con formato RUT chileno en la fila
    let rutIdx = -1;
    for (let j = 0; j < row.length; j++) {
      if (rutRe.test(String(row[j]).trim())) { rutIdx = j; break; }
    }
    if (rutIdx === -1) continue;

    const rut = normRut(String(row[rutIdx]).trim());
    if (seen.has(rut)) continue;
    seen.add(rut);

    // El nombre está en la columna siguiente (o la anterior si el orden varía)
    const nombre = String(row[rutIdx + 1] || row[rutIdx - 1] || '').trim();

    // Montos mensuales (miles de pesos → pesos)
    const meses = {};
    for (const { abbrev, idx } of monthCols) {
      const val = row[idx];
      const num = typeof val === 'number'
        ? val
        : parseFloat(String(val || '').replace(/\./g,'').replace(',','.'));
      if (!isNaN(num) && num > 0) {
        const [mon, yr] = abbrev.split('-');
        meses[`${MES_MAP[mon] || mon} 20${yr}`] = Math.round(num * 1000);
      }
    }

    // Total: columna después del último mes (o suma de meses como fallback)
    const lastIdx  = monthCols[monthCols.length - 1].idx;
    const totalRaw = row[lastIdx + 1];
    let total = typeof totalRaw === 'number'
      ? Math.round(totalRaw * 1000)
      : parseFloat(String(totalRaw || '').replace(/\./g,'').replace(',','.')) * 1000;
    if (!total || isNaN(total)) {
      total = Object.values(meses).reduce((s, v) => s + v, 0);
    }

    clientes.push({ rut, nombre, meses, total: total || 0 });
  }

  return { columnas, clientes };
}

// ── Código que corre en el browser de Browserless ─────────────────────────────
// Las credenciales se reciben por `context` (campo JSON de la petición).
const BROWSER_CODE = `
export default async function main({ page, context }) {
  const { rut, clave } = context;
  const LOGIN_URL = 'https://web.nubox.com/Login/Account/Login?ReturnUrl=%2FSistemaLogin';

  // 1. Navegar al login
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 45000 });

  // 2. Verificar si ya está autenticado (tiene el jqxTreeGrid visible)
  const alreadyLogged = await page.$('#treeGrid');
  if (!alreadyLogged) {
    // Buscar inputs visibles: primero text (RUT), luego password
    const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    let rutInput = null, passInput = null;
    for (const inp of allInputs) {
      const t = await inp.evaluate(el => el.type);
      if (t === 'password' && !passInput) { passInput = inp; }
      else if (t !== 'password' && t !== 'checkbox' && !rutInput) { rutInput = inp; }
    }
    if (!rutInput || !passInput) {
      throw new Error('Campos de login no encontrados en: ' + page.url());
    }
    await rutInput.click({ clickCount: 3 });
    await rutInput.type(rut, { delay: 40 });
    await passInput.type(clave, { delay: 40 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }),
      passInput.press('Enter')
    ]);

    // Verificar login exitoso (no debe redirigir de vuelta al login)
    const afterUrl = page.url();
    if (afterUrl.toLowerCase().includes('/login/') || afterUrl.toLowerCase().includes('/account/')) {
      const errMsg = await page.$eval('.alert, .validation-summary-errors, [class*="error"]',
        el => el.textContent.trim()).catch(() => 'Sin mensaje de error visible');
      throw new Error('Login fallido: ' + errMsg + ' | URL: ' + afterUrl);
    }
  }

  // 3. Esperar que el jqxTreeGrid cargue con la fila "Factura Electrónica"
  await page.waitForFunction(
    () => typeof $ !== 'undefined'
       && document.getElementById('treeGrid')
       && document.getElementById('row1treeGrid'),
    { timeout: 25000, polling: 500 }
  );

  // 4. Seleccionar "Factura Electrónica" → redirige con UTN en la URL
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }),
    page.evaluate(() => {
      try { $('#treeGrid').jqxTreeGrid('selectRow', '2'); }
      catch (_) {
        const row = document.getElementById('row1treeGrid');
        if (row) row.click();
      }
    })
  ]);

  // 5. Extraer UTN de la URL resultante
  const navUrl  = page.url();
  const utnMatch = navUrl.match(/[?&]utn=([^&]+)/);
  if (!utnMatch) {
    throw new Error('UTN no encontrado en URL: ' + navUrl.substring(0, 150));
  }
  const utn = utnMatch[1];

  // 6. Navegar directamente al Resumen de Ventas con el UTN
  const reportUrl = 'https://app.nubox.com/ServiFactura/paginas/Dashboard.aspx?action=Ventas&utn='
    + encodeURIComponent(utn);
  await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 70000 });

  // 7. Esperar que el ReportViewer SSRS cargue
  await page.waitForSelector('#ReportViewer1_fixedTable', { timeout: 35000 });

  // 8. Descargar el Excel completo vía POST al mismo form (btnImprimirXLS)
  const excelBase64 = await page.evaluate(async () => {
    const form = document.querySelector('form');
    if (!form) throw new Error('Formulario SSRS no encontrado');

    const fd = new FormData(form);
    fd.set('btnImprimirXLS', 'Exportar');

    const resp = await fetch(form.action, {
      method: 'POST',
      body: fd,
      credentials: 'include'
    });

    if (!resp.ok) throw new Error('Error descargando Excel: HTTP ' + resp.status);

    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('excel') && !ct.includes('spreadsheet') && !ct.includes('octet')) {
      const preview = await resp.text();
      throw new Error('Respuesta no es Excel (' + ct + '): ' + preview.substring(0, 200));
    }

    const buf = await resp.arrayBuffer();
    const u8  = new Uint8Array(buf);
    let   bin = '';
    for (let i = 0; i < u8.length; i += 8192) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
    }
    return btoa(bin);
  });

  return { excelBase64 };
}
`;

// ── Actualizar nubox-resumen-cache.json vía GitHub API ────────────────────────
async function updateCacheViaGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || 'WurfelSPA/facturacion-patagonica';
  if (!GITHUB_TOKEN) throw new Error('Falta GITHUB_TOKEN');

  const filePath = 'nubox-resumen-cache.json';
  const apiBase  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  // Obtener SHA actual
  let sha = null;
  try {
    const getRes = await fetch(apiBase, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
  } catch (_) {}

  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const body    = {
    message: `chore: actualizar caché Nubox Resumen ${new Date().toISOString().slice(0,10)}`,
    content,
    ...(sha ? { sha } : {})
  };

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub API error ${putRes.status}: ${err.slice(0, 200)}`);
  }
  return await putRes.json();
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Autenticación: cron de Vercel o SYNC_SECRET manual
  const authHeader = req.headers['authorization'] || '';
  const syncSecret = process.env.SYNC_SECRET;
  const isCron     = req.headers['x-vercel-cron'] === '1';
  const isAuth     = isCron || (syncSecret && authHeader === `Bearer ${syncSecret}`);
  if (!isAuth) return res.status(401).json({ error: 'No autorizado' });

  const RUT               = process.env.NUBOX_API_USER;
  const CLAVE             = process.env.NUBOX_API_PASS;
  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

  if (!RUT || !CLAVE)         return res.status(500).json({ error: 'Faltan NUBOX_API_USER / NUBOX_API_PASS' });
  if (!BROWSERLESS_TOKEN)     return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  try {
    console.log('[nubox-refresh] Iniciando scraping Nubox Resumen de Ventas...');

    // Llamar a Browserless
    const blRes = await fetch(
      `https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code:    BROWSER_CODE,
          context: { rut: RUT, clave: CLAVE }
        })
      }
    );

    if (!blRes.ok) {
      const errText = await blRes.text();
      throw new Error(`Browserless ${blRes.status}: ${errText.slice(0, 300)}`);
    }

    const blData = await blRes.json();
    if (!blData.excelBase64) {
      throw new Error('No se recibió Excel de Browserless: ' + JSON.stringify(blData).slice(0, 200));
    }

    console.log('[nubox-refresh] Excel recibido, parseando...');

    // Parsear Excel
    const excelBuffer        = Buffer.from(blData.excelBase64, 'base64');
    const { columnas, clientes } = parseNuboxExcel(excelBuffer);

    console.log(`[nubox-refresh] ${clientes.length} clientes, meses: ${columnas.join(', ')}`);

    if (clientes.length < 10) {
      throw new Error(`Solo ${clientes.length} clientes encontrados — posible error de parseo`);
    }

    // Construir cache
    const cacheData = {
      ok:        true,
      updatedAt: new Date().toISOString(),
      source:    'browserless-excel',
      columnas,
      clientes
    };

    // Subir a GitHub → dispara redeploy automático en Vercel
    await updateCacheViaGitHub(cacheData);
    console.log('[nubox-refresh] nubox-resumen-cache.json actualizado en GitHub');

    return res.status(200).json({
      ok:       true,
      updatedAt: cacheData.updatedAt,
      clientes:  clientes.length,
      columnas:  columnas.length,
      meses:     columnas
    });

  } catch (e) {
    console.error('[nubox-refresh] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
