/**
 * /api/nubox-pdf
 *
 * Automatiza el login en Nubox, descarga el PDF consolidado de facturas PISA
 * del mes indicado y lo sube a Google Drive.
 *
 * Variables de entorno requeridas (Vercel):
 *   NUBOX_PISA_USER  — RUT sin puntos con dígito verificador  (ej: 12345678-9)
 *   NUBOX_PISA_PASS  — Contraseña del usuario Nubox
 *   NUBOX_PISA_RUT   — (opcional) RUT numérico de PISA sin guión  (ej: 96673250)
 *
 * Parámetros POST (JSON):
 *   mes           — período YYYY-MM  (ej: 2026-06)
 *   googleToken   — OAuth access token con scope drive
 *   destFolderId  — ID de la carpeta en Google Drive donde guardar el PDF
 *
 * Respuesta exitosa:
 *   { ok: true, fileId, fileName, total, mes }
 *
 * Flujo interno:
 *   1. POST /Login/?Pais=CL  → cookies de sesión
 *   2. POST /Inicio/ObtenerListaClientes  → SistemasComputacionalesDeUsuario[]
 *   3. Busca el producto con ParentCode != null (Factura Electrónica PISA)
 *   4. POST /Inicio/ObtieneClienteRedirect con Idkey=<value>  → NombreTab (utn)
 *   5. GET dtePrincipal.aspx?utn=...  → cookies app.nubox.com + token interno
 *   6. POST ObtenerPorFiltro  → lista de IDs del mes
 *   7. POST VerPDF  → path del PDF
 *   8. GET PDF  → bytes
 *   9. Upload a Google Drive como Facturas_PISA_YYYY-MM.pdf
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { mes, googleToken, destFolderId } = req.body || {};

  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ error: 'Se requiere mes en formato YYYY-MM' });
  }
  if (!googleToken) {
    return res.status(400).json({ error: 'Se requiere googleToken' });
  }
  if (!destFolderId) {
    return res.status(400).json({ error: 'Se requiere destFolderId' });
  }

  const nuboxUser = process.env.NUBOX_PISA_USER;
  const nuboxPass = process.env.NUBOX_PISA_PASS;
  if (!nuboxUser || !nuboxPass) {
    return res.status(500).json({ error: 'Variables de entorno NUBOX_PISA_USER / NUBOX_PISA_PASS no configuradas' });
  }

  const [year, month] = mes.split('-');
  const fechaDesde = `01/${month}/${year}`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaHasta = `${String(lastDay).padStart(2, '0')}/${month}/${year}`;

  const WEB_BASE  = 'https://web.nubox.com';
  const APP_BASE  = 'https://app.nubox.com';
  const DTE_PAGE  = `${APP_BASE}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  /** Extrae cookies Set-Cookie y las devuelve como string para el header Cookie */
  function parseCookies(response, existing = '') {
    const setCookies = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);

    const map = {};
    for (const pair of (existing || '').split(';').map(s => s.trim()).filter(Boolean)) {
      const [k, ...v] = pair.split('=');
      if (k) map[k.trim()] = v.join('=');
    }
    for (const raw of setCookies) {
      const part = raw.split(';')[0];
      const [k, ...v] = part.split('=');
      if (k) map[k.trim()] = v.join('=');
    }
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  try {
    // ── PASO 1: Login ──────────────────────────────────────────────────────────
    const loginPageRes = await fetch(`${WEB_BASE}/Login/?Pais=CL`, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    let cookies = parseCookies(loginPageRes);
    const loginHtml = await loginPageRes.text();

    // Extraer __RequestVerificationToken si existe
    const rvtMatch = loginHtml.match(/name="__RequestVerificationToken"\s+(?:type="[^"]*"\s+)?value="([^"]+)"/);
    const rvt = rvtMatch ? rvtMatch[1] : '';

    // Campos obfuscados del formulario de login (estáticos en Nubox)
    const RUT_FIELD  = 'ae740e71936fa3eec403935de72a7aa3a68bbe7';
    const PASS_FIELD = 'd70911c2de484460cf9f927ee6c6166585718189';

    const loginBody = new URLSearchParams({
      [RUT_FIELD]: nuboxUser,
      [PASS_FIELD]: nuboxPass,
      gToken: '',
      ...(rvt ? { __RequestVerificationToken: rvt } : {}),
    });

    const loginRes = await fetch(`${WEB_BASE}/Login/?Pais=CL`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Referer': `${WEB_BASE}/Login/?Pais=CL`,
      },
      body: loginBody.toString(),
      redirect: 'follow',
    });
    cookies = parseCookies(loginRes, cookies);

    // Verificar que el login fue exitoso (debería redirigir a SistemaLogin)
    const loginFinalUrl = loginRes.url || '';
    if (!loginFinalUrl.includes('SistemaLogin') && !loginFinalUrl.includes('nubox.com')) {
      const loginText = await loginRes.text();
      // Buscar mensaje de error en HTML
      const errMatch = loginText.match(/class="[^"]*error[^"]*"[^>]*>([^<]{5,200})</i);
      return res.status(401).json({
        error: 'Login fallido. Verificar credenciales NUBOX_PISA_USER / NUBOX_PISA_PASS',
        hint: errMatch ? errMatch[1].trim() : loginText.substring(0, 400),
      });
    }

    // ── PASO 2: Obtener lista de productos ─────────────────────────────────────
    const listaRes = await fetch(`${WEB_BASE}/SistemaLogin/Inicio/ObtenerListaClientes`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookies,
        'Referer': `${WEB_BASE}/SistemaLogin/`,
      },
    });
    cookies = parseCookies(listaRes, cookies);

    if (!listaRes.ok) {
      return res.status(502).json({ error: `ObtenerListaClientes respondió ${listaRes.status}` });
    }

    const listaJson = await listaRes.json();
    if (listaJson.CodigoError !== 'E_00') {
      return res.status(401).json({
        error: 'Sesión no válida: ' + (listaJson.MensajeHumano || listaJson.CodigoError),
      });
    }

    // ── PASO 3: Buscar el producto Factura Electrónica de PISA ─────────────────
    const sistemas = listaJson.SistemasComputacionalesDeUsuario || [];
    const pisaRut = (process.env.NUBOX_PISA_RUT || '96673250').replace(/[^0-9]/g, '');

    // El producto tiene ParentCode (es hijo de la empresa) y coincide con el RUT de PISA
    let producto = sistemas.find(s => s.ParentCode && s.Rut === pisaRut);
    if (!producto) {
      producto = sistemas.find(s => s.ParentCode); // fallback: primer producto con padre
    }
    if (!producto || !producto.value) {
      return res.status(404).json({
        error: 'No se encontró el producto Factura Electrónica PISA',
        sistemas: sistemas.map(s => ({ Id: s.Id, Rut: s.Rut, ParentCode: s.ParentCode })),
      });
    }

    // ── PASO 4: Obtener utn ────────────────────────────────────────────────────
    const redirectRes = await fetch(`${WEB_BASE}/SistemaLogin/Inicio/ObtieneClienteRedirect`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookies,
        'Referer': `${WEB_BASE}/SistemaLogin/`,
      },
      body: `Idkey=${encodeURIComponent(producto.value)}&hubspot=&TagRedirect=`,
    });
    cookies = parseCookies(redirectRes, cookies);

    const redirectJson = await redirectRes.json();
    if (redirectJson.CodigoError !== 'E_00' || !redirectJson.NombreTab) {
      return res.status(502).json({
        error: 'No se pudo obtener utn: ' + (redirectJson.MensajeHumano || redirectJson.CodigoError),
      });
    }
    const utn = redirectJson.NombreTab;

    // ── PASO 5: Establecer sesión en app.nubox.com ─────────────────────────────
    const principalRes = await fetch(
      `${APP_BASE}/ServiFactura/paginas/dtePrincipal.aspx?utn=${encodeURIComponent(utn)}`,
      { headers: { 'User-Agent': UA, 'Cookie': cookies }, redirect: 'follow' }
    );
    let appCookies = parseCookies(principalRes);

    const dteRes = await fetch(DTE_PAGE, {
      headers: { 'User-Agent': UA, 'Cookie': appCookies },
      redirect: 'follow',
    });
    appCookies = parseCookies(dteRes, appCookies);
    const dteHtml = await dteRes.text();

    // Extraer token interno
    const tokenMatch =
      dteHtml.match(/var\s+token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/) ||
      dteHtml.match(/"token"\s*:\s*"([A-Za-z0-9+/=]{20,})"/) ||
      dteHtml.match(/token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/);

    if (!tokenMatch) {
      return res.status(500).json({
        error: 'No se pudo extraer el token DTE. El utn puede haber expirado.',
        utn,
        htmlSnippet: dteHtml.substring(0, 600),
      });
    }
    const token = tokenMatch[1];

    const funcMatch =
      dteHtml.match(/funcionarioId\s*[=:]\s*["']?(\d{4,})["']?/) ||
      dteHtml.match(/"funcionarioId"\s*:\s*"(\d+)"/);
    const funcionarioId = funcMatch ? funcMatch[1] : '339708';

    // ── PASO 6: ObtenerPorFiltro ───────────────────────────────────────────────
    const filtroRes = await fetch(`${DTE_PAGE}/ObtenerPorFiltro`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json; charset=utf-8',
        'Cookie': appCookies,
        'Referer': DTE_PAGE,
      },
      body: JSON.stringify({
        token,
        EstadoId: 3,
        estadoEnvio: 0,
        fechaDesde,
        fechaHasta,
        filtro: '<Terminos></Terminos>',
        folioDesde: 0,
        folioHasta: 0,
        usaFormatoImpresionEspecial: false,
      }),
    });

    if (!filtroRes.ok) {
      return res.status(502).json({ error: `ObtenerPorFiltro respondió ${filtroRes.status}` });
    }
    const filtroJson = await filtroRes.json();
    const filtroInner = JSON.parse(filtroJson.d);
    const documentos = filtroInner.data || [];
    const totalDocs = filtroInner.total?.[0]?.Total ?? documentos.length;

    if (documentos.length === 0) {
      return res.status(404).json({ error: `Sin facturas PISA para ${mes}`, fechaDesde, fechaHasta });
    }
    const ids = documentos.map(d => d.Id).join(',');

    // ── PASO 7: VerPDF ─────────────────────────────────────────────────────────
    const pdfGenRes = await fetch(`${DTE_PAGE}/VerPDF`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json; charset=utf-8',
        'Cookie': appCookies,
        'Referer': DTE_PAGE,
      },
      body: JSON.stringify({ token, funcionarioId, id: ids }),
    });

    if (!pdfGenRes.ok) {
      return res.status(502).json({ error: `VerPDF respondió ${pdfGenRes.status}` });
    }
    const pdfGenJson = await pdfGenRes.json();
    const pdfPath = pdfGenJson.d;
    if (!pdfPath) {
      return res.status(500).json({ error: 'VerPDF no devolvió path', respuesta: pdfGenJson });
    }

    // ── PASO 8: Descargar bytes del PDF ───────────────────────────────────────
    const pdfDownRes = await fetch(`${APP_BASE}${pdfPath}`, {
      headers: { 'User-Agent': UA, 'Cookie': appCookies },
    });
    if (!pdfDownRes.ok) {
      return res.status(502).json({ error: `Descarga PDF respondió ${pdfDownRes.status}` });
    }
    const pdfBuffer = Buffer.from(await pdfDownRes.arrayBuffer());
    const fileName = `Facturas_PISA_${mes}.pdf`;

    // ── PASO 9: Subir a Google Drive ───────────────────────────────────────────
    const metadata = JSON.stringify({
      name: fileName,
      mimeType: 'application/pdf',
      parents: [destFolderId],
    });
    const boundary = 'nubox_pdf_boundary_XYZ';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      pdfBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${googleToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(502).json({
        error: `Google Drive upload respondió ${uploadRes.status}`,
        detail: errText.substring(0, 400),
      });
    }

    const uploadJson = await uploadRes.json();

    return res.status(200).json({
      ok: true,
      fileId: uploadJson.id,
      fileName,
      total: totalDocs,
      mes,
      fechaDesde,
      fechaHasta,
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
}
