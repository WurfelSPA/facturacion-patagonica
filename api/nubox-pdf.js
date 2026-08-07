/**
 * POST /api/nubox-pdf
 * Descarga el PDF consolidado y el ZIP de XML de facturas PISA para un mes
 * desde Nubox usando Browserless, y los sube a Google Drive.
 *
 * Env vars:
 *   NUBOX_API_USER          — RUT de acceso a Nubox (ej: 96673250-4)
 *   NUBOX_API_PASS          — Clave de Nubox
 *   BROWSERLESS_TOKEN       — Token de production-sfo.browserless.io
 *   GOOGLE_SERVICE_ACCOUNT  — JSON de Service Account con acceso Drive (fallback si no hay userToken)
 *
 * POST body: { mes: "YYYY-MM", destFolderId: "<Drive folder id>", userToken?: "<OAuth token>" }
 * Returns:   { ok, fileId, fileName, xmlFileId, xmlFileName, xmlError, total, mes }
 */

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

// ── JWT / Service Account ────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey.buffer, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${signingInput}.${sigB64}`;
}
async function getSAToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT(
    { iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 },
    sa.private_key
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("SA token error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Script Browserless ───────────────────────────────────────────────────────
// CAMBIO CLAVE: Usa waitUntil:'load' en vez de 'networkidle2' para evitar
// timeout en el SPA de Nubox (que tiene polling de red continuo).
const BROWSER_CODE = `
export default async function main({ page, context }) {
  const { rut, clave, year, month } = context;

  // Un elemento está realmente visible si ocupa espacio y no está oculto por
  // CSS. Los campos/botones señuelo (honeypot) anti-bot suelen estar en el
  // DOM pero con display:none, visibility:hidden o tamaño 0.
  async function esVisible(handle) {
    return handle.evaluate(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    }).catch(() => false);
  }

  // Busca el botón/input de submit del login: por texto o value que sugiera
  // ingresar/entrar, revisando tanto <button> como <input type=button|submit>.
  // Se excluyen candidatos no visibles (señuelos) y el ícono de mostrar clave.
  async function findSubmitButton(page) {
    const candidatos = [
      ...(await page.$$('button')),
      ...(await page.$$('input[type="button"], input[type="submit"]'))
    ];
    for (const b of candidatos) {
      const info = await b.evaluate(el => ({
        text: (el.textContent || '').trim().toLowerCase(),
        value: (el.value || '').trim().toLowerCase(),
        cls: (el.className || '').toLowerCase()
      })).catch(() => null);
      if (!info) continue;
      if (info.cls.includes('eye-password')) continue;
      const etiqueta = info.text || info.value;
      if (/ingres|entrar|iniciar|login|acceder/.test(etiqueta) && await esVisible(b)) return b;
    }
    return null;
  }

  const lastDay    = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaDesde = '01/' + month + '/' + year;
  const fechaHasta = String(lastDay).padStart(2, '0') + '/' + month + '/' + year;

  // ── 1. Login Nubox ────────────────────────────────────────────────────────
  const LOGIN_URL = 'https://web.nubox.com/Login/Account/Login?ReturnUrl=%2FSistemaLogin';
  let navError = null;
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) {
    navError = e.message;
  }
  await new Promise(r => setTimeout(r, 2000));
  await Promise.race([
    page.waitForSelector('#treeGrid', { timeout: 8000 }),
    page.waitForSelector('input[type="password"]', { timeout: 8000 }),
  ]).catch(() => {});

  if (navError) {
    const debugInfo = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      htmlLen: document.documentElement.outerHTML.length,
      snippet: (document.body ? document.body.innerText : 'NO_BODY').slice(0, 400)
    })).catch(e => ({ evalError: e.message }));
    throw new Error('Nav goto fallo: ' + navError + ' | debug=' + JSON.stringify(debugInfo));
  }

  const alreadyLogged = await page.$('#treeGrid');
  if (!alreadyLogged) {
    const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    let rutInput = null, passInput = null;
    for (const inp of allInputs) {
      const t = await inp.evaluate(el => el.type);
      if (t === 'checkbox') continue;
      if (!(await esVisible(inp))) continue; // salta campos señuelo (honeypot) ocultos
      if (t === 'password' && !passInput) { passInput = inp; }
      else if (t !== 'password' && !rutInput) { rutInput = inp; }
    }
    if (!rutInput || !passInput) throw new Error('Campos de login no encontrados en: ' + page.url());
    await rutInput.click({ clickCount: 3 });
    await rutInput.type(rut, { delay: 40 });
    await passInput.click({ clickCount: 3 });
    await passInput.type(clave, { delay: 40 });
    const submitBtn = await findSubmitButton(page);
    if (submitBtn) {
      await submitBtn.evaluate(el => new Promise(resolve => {
        if (!el.disabled) return resolve();
        const obs = new MutationObserver(() => { if (!el.disabled) { obs.disconnect(); resolve(); } });
        obs.observe(el, { attributes: true, attributeFilter: ['disabled'] });
        setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
      })).catch(() => {});
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      submitBtn ? submitBtn.click() : passInput.press('Enter')
    ]);
    const afterUrl = page.url();
    if (afterUrl.toLowerCase().includes('/login/') || afterUrl.toLowerCase().includes('/account/')) {
      const errMsg = await page.$eval('.alert, .validation-summary-errors, [class*="error"]',
        el => el.textContent.trim()).catch(() => 'Sin mensaje de error visible');
      throw new Error('Login fallido: ' + errMsg + ' | URL: ' + afterUrl);
    }
  }

  // ── 2. Obtener UTN (igual que nubox-refresh.js) ────────────────────────────
  await page.waitForFunction(
    () => typeof $ !== 'undefined' && document.getElementById('treeGrid') && document.getElementById('row1treeGrid'),
    { timeout: 30000, polling: 500 }
  );
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.evaluate(() => {
      try { $('#treeGrid').jqxTreeGrid('selectRow', '2'); }
      catch (_) {
        const row = document.getElementById('row1treeGrid');
        if (row) row.click();
      }
    })
  ]);
  const navUrl  = page.url();
  const utnMatch = navUrl.match(/[?&]utn=([^&]+)/);
  if (!utnMatch) throw new Error('UTN no encontrado en URL: ' + navUrl.substring(0, 150));
  const utn = utnMatch[1];

  // ── 3. Navegar a Ventas Electrónicas (dteDocumentosTributarios) ────────────
  const DTE_BASE = 'https://app.nubox.com/ServiFactura/paginas/dteDocumentosTributarios.aspx';
  await page.goto(DTE_BASE + '?utn=' + encodeURIComponent(utn), {
    waitUntil: 'domcontentloaded', timeout: 30000
  });

  // Esperar que cargue el token en la página
  await page.waitForFunction(
    () => {
      if (typeof token !== 'undefined' && token) return true;
      const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '').join(' ');
      return /token\\s*=\\s*["'][A-Za-z0-9+\\/=]{20,}/.test(scripts);
    },
    { timeout: 25000, polling: 500 }
  ).catch(() => null);

  // ── 4. Listar documentos del período y descargar PDF (AJAX dentro del browser)
  const result = await page.evaluate(async ({ fechaDesde, fechaHasta, DTE_BASE }) => {
    let pageToken = null, pageFuncId = null;
    // 'token' puede resolver a un elemento del DOM (id="token" auto-expuesto como
    // global) en vez de al string real; en ese caso hay que leer su .value.
    try {
      if (typeof token !== 'undefined' && token) {
        pageToken = (typeof token === 'string') ? token : (token.value || null);
      }
    } catch(_) {}
    try {
      if (typeof funcionarioId !== 'undefined' && funcionarioId) {
        pageFuncId = (typeof funcionarioId === 'string' || typeof funcionarioId === 'number')
          ? String(funcionarioId) : (funcionarioId.value ? String(funcionarioId.value) : null);
      }
    } catch(_) {}

    if (!pageToken) {
      const allScripts = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\\n');
      const tm = allScripts.match(/var\\s+token\\s*=\\s*["']([A-Za-z0-9+\\/=]{20,})["']/) ||
                 allScripts.match(/token\\s*=\\s*["']([A-Za-z0-9+\\/=]{20,})["']/);
      if (tm) pageToken = tm[1];
      const fm = allScripts.match(/funcionarioId\\s*[=:]\\s*["']?(\\d{4,})["']?/);
      if (fm) pageFuncId = fm[1];
    }
    // Última red de seguridad: input hidden id/name="token" en el DOM.
    if (!pageToken) {
      const el = document.getElementById('token') || document.querySelector('input[name="token"]');
      if (el && el.value) pageToken = el.value;
    }

    if (!pageToken || typeof pageToken !== 'string') {
      return { error: 'Token no encontrado o no es string en la página DTE. typeofToken=' + typeof pageToken + ' URL: ' + location.href };
    }

    try {
      const filtroRes = await fetch(DTE_BASE + '/ObtenerPorFiltro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          token: pageToken, EstadoId: 3, estadoEnvio: 0,
          fechaDesde, fechaHasta,
          filtro: '',
          folioDesde: 0, folioHasta: 0,
          usaFormatoImpresionEspecial: false
        })
      });
      if (!filtroRes.ok) {
        const bodyText = await filtroRes.text().catch(() => '');
        return { error: 'ObtenerPorFiltro HTTP ' + filtroRes.status + ' | tokenLen=' + (pageToken ? pageToken.length : 0) + ' | fechaDesde=' + fechaDesde + ' fechaHasta=' + fechaHasta + ' | body=' + bodyText.slice(0, 400) };
      }

      const filtroRaw = await filtroRes.json();
      let filtroData;
      try { filtroData = JSON.parse(filtroRaw.d); } catch(_) { filtroData = filtroRaw; }
      const docs = filtroData.data || filtroData.Data || [];

      if (!docs.length) return { error: 'Sin documentos para ' + fechaDesde + ' - ' + fechaHasta };

      const ids = docs.map(d => d.Id || d.id).filter(Boolean).join(',');
      const total = docs.length;

      function toBase64(buf) {
        const u8 = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < u8.length; i += 8192) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
        }
        return { b64: btoa(bin), size: u8.length };
      }

      const pdfRes = await fetch(DTE_BASE + '/VerPDF', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ token: pageToken, funcionarioId: pageFuncId || '339708', id: ids })
      });
      if (!pdfRes.ok) return { error: 'VerPDF HTTP ' + pdfRes.status };

      const pdfRaw = await pdfRes.json();
      const pdfPath = pdfRaw.d || pdfRaw.url || pdfRaw;
      if (!pdfPath || typeof pdfPath !== 'string') {
        return { error: 'VerPDF no retornó ruta: ' + JSON.stringify(pdfRaw).slice(0, 200) };
      }

      const pdfUrl = pdfPath.startsWith('http') ? pdfPath : ('https://app.nubox.com' + pdfPath);
      const dlRes = await fetch(pdfUrl, { credentials: 'include' });
      if (!dlRes.ok) return { error: 'Descarga PDF HTTP ' + dlRes.status + ' url: ' + pdfUrl };

      const ct = dlRes.headers.get('content-type') || '';
      if (!ct.includes('pdf') && !ct.includes('octet')) {
        const preview = await dlRes.text();
        return { error: 'Respuesta no es PDF (' + ct + '): ' + preview.slice(0, 300) };
      }

      const pdf = toBase64(await dlRes.arrayBuffer());

      // ── XML (botón "Descargar XML" de Ventas Electrónicas) ────────────────
      let xmlBase64 = null, xmlSize = null, xmlError = null;
      try {
        const arrayId = docs.map(d => ({ idDocs: parseInt(d.Id || d.id, 10), formato: 'SII' }));
        const xmlListRes = await fetch(DTE_BASE + '/DescargarXML', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ token: pageToken, funcionarioId: pageFuncId || '339708', arrayId: JSON.stringify(arrayId) })
        });
        if (!xmlListRes.ok) throw new Error('DescargarXML HTTP ' + xmlListRes.status);
        const xmlRaw = await xmlListRes.json();
        const xmlPath = xmlRaw.d || xmlRaw.url || xmlRaw;
        if (!xmlPath || typeof xmlPath !== 'string') throw new Error('DescargarXML no retornó ruta: ' + JSON.stringify(xmlRaw).slice(0, 200));
        const xmlUrl = xmlPath.startsWith('http') ? xmlPath : ('https://app.nubox.com' + xmlPath);
        const xmlDlRes = await fetch(xmlUrl, { credentials: 'include' });
        if (!xmlDlRes.ok) throw new Error('Descarga XML HTTP ' + xmlDlRes.status + ' url: ' + xmlUrl);
        const xmlB64 = toBase64(await xmlDlRes.arrayBuffer());
        xmlBase64 = xmlB64.b64; xmlSize = xmlB64.size;
      } catch (e) {
        xmlError = e.message;
      }

      return { pdfBase64: pdf.b64, pdfSize: pdf.size, xmlBase64, xmlSize, xmlError, total };

    } catch(e) {
      return { error: e.message };
    }
  }, { fechaDesde, fechaHasta, DTE_BASE });

  if (result.error) throw new Error(result.error);
  return result;
}
`;

// ── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { mes, destFolderId, userToken } = req.body || {};
  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: 'Se requiere mes en formato YYYY-MM' });
  if (!destFolderId)
    return res.status(400).json({ error: 'Se requiere destFolderId' });

  const RUT               = process.env.NUBOX_API_USER;
  const CLAVE             = process.env.NUBOX_API_PASS;
  const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

  if (!RUT || !CLAVE)     return res.status(500).json({ error: 'Faltan NUBOX_API_USER / NUBOX_API_PASS' });
  if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'Falta BROWSERLESS_TOKEN' });

  const [year, month] = mes.split('-');

  try {
    console.log(`[nubox-pdf] Descargando facturas ${mes} via Browserless...`);

    // stealth:true patchea fingerprints de automatización (navigator.webdriver, etc.)
    // — el login intermitente que redirige a Login/?Pais=CL parece el mismo tipo de
    // bloqueo que Incapsula aplicaba a AA/Enel antes de este fix.
    const launchB64 = Buffer.from(JSON.stringify({ stealth: true })).toString('base64');

    const blRes = await fetch(
      `https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=120000&proxy=residential&proxyCountry=cl&proxySticky=true&launch=${launchB64}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: BROWSER_CODE, context: { rut: RUT, clave: CLAVE, year, month } })
      }
    );

    if (!blRes.ok) {
      const errText = await blRes.text();
      throw new Error(`Browserless ${blRes.status}: ${errText.slice(0, 500)}`);
    }

    const blData = await blRes.json();
    if (!blData.pdfBase64) {
      throw new Error('No se recibio PDF: ' + JSON.stringify(blData).slice(0, 500));
    }

    console.log(`[nubox-pdf] PDF recibido — ${blData.total} docs, ${Math.round((blData.pdfSize||0)/1024)} KB`);

    // La Service Account no tiene cuota de almacenamiento propia para crear
    // archivos en carpetas de Mi Unidad (solo en Unidades Compartidas), así que
    // la subida usa el token del usuario cuando está disponible (mismo patrón
    // que split-pdf.js).
    const uploadToken = userToken || await getSAToken();
    const saToken = await getSAToken();

    // Elimina cualquier archivo previo con ese nombre exacto en la carpeta antes de
    // subir el nuevo — evita quedar con copias viejas/duplicadas cuando se vuelve a
    // descargar el mismo mes (ej. botón "Forzar descarga desde Nubox").
    async function eliminarSiExiste(fileName) {
      try {
        const q = `name='${fileName.replace(/'/g, "\\'")}' and '${destFolderId}' in parents and trashed=false`;
        const searchRes = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`,
          { headers: { Authorization: `Bearer ${saToken}` } }
        );
        const searchJson = searchRes.ok ? await searchRes.json() : { files: [] };
        for (const f of (searchJson.files || [])) {
          await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?supportsAllDrives=true`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${uploadToken}` } }).catch(() => {});
        }
        if (searchJson.files?.length) console.log(`[nubox-pdf] Eliminado(s) ${searchJson.files.length} archivo(s) previo(s): ${fileName}`);
      } catch (e) { console.error(`[nubox-pdf] Error eliminando duplicados de ${fileName}:`, e.message); }
    }

    async function subirADrive(buffer, fileName, mimeType) {
      await eliminarSiExiste(fileName);
      const boundary  = 'nubox_pdf_boundary';
      const metadata  = JSON.stringify({ name: fileName, mimeType, parents: [destFolderId] });
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--`)
      ]);
      const uploadRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${uploadToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipart
        }
      );
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Drive upload ${uploadRes.status}: ${errText.slice(0, 300)}`);
      }
      return uploadRes.json();
    }

    // ── PDF ───────────────────────────────────────────────────────────────────
    const fileName   = `Facturas_PISA_${mes}.pdf`;
    const uploadData = await subirADrive(Buffer.from(blData.pdfBase64, 'base64'), fileName, 'application/pdf');
    console.log(`[nubox-pdf] Guardado en Drive: ${fileName} (id: ${uploadData.id})`);

    // ── XML (best-effort: si falla, el PDF igual se entrega) ────────────────
    let xmlFileId = null, xmlFileName = null;
    if (blData.xmlBase64) {
      xmlFileName = `Facturas XML_PISA_${mes}.zip`;
      try {
        const xmlUploadData = await subirADrive(Buffer.from(blData.xmlBase64, 'base64'), xmlFileName, 'application/zip');
        xmlFileId = xmlUploadData.id;
        console.log(`[nubox-pdf] Guardado en Drive: ${xmlFileName} (id: ${xmlFileId})`);
      } catch (e) {
        console.error('[nubox-pdf] Error subiendo XML:', e.message);
        blData.xmlError = blData.xmlError || e.message;
      }
    } else if (blData.xmlError) {
      console.error('[nubox-pdf] DescargarXML falló:', blData.xmlError);
    }

    return res.status(200).json({
      ok: true, fileId: uploadData.id, fileName, total: blData.total, mes,
      xmlFileId, xmlFileName, xmlError: blData.xmlBase64 ? null : blData.xmlError
    });

  } catch (err) {
    console.error('[nubox-pdf] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
