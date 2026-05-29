/**
 * /api/nubox-pdf
 *
 * Login automático en Nubox + descarga PDF consolidado PISA + sube a Google Drive.
 *
 * Variables de entorno (Vercel):
 *   NUBOX_PISA_USER  — RUT con dígito verificador  (ej: 96673250-4)
 *   NUBOX_PISA_PASS  — Contraseña
 *   NUBOX_PISA_RUT   — (opcional) RUT numérico sin guión (default: 96673250)
 *
 * POST body (JSON):
 *   mes           — YYYY-MM
 *   googleToken   — OAuth access token Drive
 *   destFolderId  — carpeta Drive destino
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { mes, googleToken, destFolderId } = req.body || {};
  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: 'Se requiere mes en formato YYYY-MM' });
  if (!googleToken) return res.status(400).json({ error: 'Se requiere googleToken' });
  if (!destFolderId) return res.status(400).json({ error: 'Se requiere destFolderId' });

  const nuboxUser = process.env.NUBOX_PISA_USER;
  const nuboxPass = process.env.NUBOX_PISA_PASS;
  if (!nuboxUser || !nuboxPass)
    return res.status(500).json({ error: 'Faltan variables NUBOX_PISA_USER / NUBOX_PISA_PASS' });

  const [year, month] = mes.split('-');
  const fechaDesde = `01/${month}/${year}`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaHasta = `${String(lastDay).padStart(2, '0')}/${month}/${year}`;

  const WEB  = 'https://web.nubox.com';
  const APP  = 'https://app.nubox.com';
  const DTE  = `${APP}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;
  const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

  // ── Manejo de cookies ─────────────────────────────────────────────────────
  // Merge cookies: las nuevas sobreescriben por nombre
  function mergeCookies(existing, setCookieHeaders) {
    const map = {};
    for (const pair of (existing || '').split(';').map(s => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq > 0) map[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    }
    for (const raw of (setCookieHeaders || [])) {
      const part = raw.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) map[part.slice(0, eq).trim()] = part.slice(eq + 1);
    }
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function getSetCookies(response) {
    if (response.headers.getSetCookie) return response.headers.getSetCookie();
    const h = response.headers.get('set-cookie');
    return h ? [h] : [];
  }

  // fetch que NO sigue redirects automáticamente — los seguimos a mano para capturar cookies
  async function fetchManual(url, options = {}, cookies = '') {
    const resp = await fetch(url, {
      ...options,
      headers: { 'User-Agent': UA, ...(options.headers || {}), Cookie: cookies },
      redirect: 'manual',
    });
    const newCookies = mergeCookies(cookies, getSetCookies(resp));
    return { resp, cookies: newCookies };
  }

  // Sigue redirects manualmente acumulando cookies en cada salto
  async function fetchFollow(url, options = {}, cookies = '') {
    let currentUrl = url;
    let currentCookies = cookies;
    let lastResp = null;

    for (let i = 0; i < 10; i++) {
      const { resp, cookies: c } = await fetchManual(currentUrl, options, currentCookies);
      currentCookies = c;
      lastResp = resp;

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) break;
        currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
        // En redirects solo GET sin body
        options = { method: 'GET', headers: options.headers ? { 'User-Agent': UA } : {} };
      } else {
        break;
      }
    }
    return { resp: lastResp, cookies: currentCookies, finalUrl: currentUrl };
  }

  try {
    // ── PASO 1: GET página de login → cookies iniciales + CSRF token ──────────
    const LOGIN_PAGE = `${WEB}/Login/Account/login`;
    const { resp: loginPageResp, cookies: c0 } = await fetchManual(LOGIN_PAGE, {});
    const loginHtml = await loginPageResp.text();
    let cookies = c0;

    // El token puede tener value= antes o después de name=, buscamos el input completo
    const rvtInputMatch = loginHtml.match(/<input[^>]*__RequestVerificationToken[^>]*>/i);
    const rvtValueMatch = rvtInputMatch ? rvtInputMatch[0].match(/value="([^"]+)"/) : null;
    const rvt = rvtValueMatch ? rvtValueMatch[1] : '';
    console.log('[nubox] rvt:', !!rvt, rvt ? rvt.substring(0,20)+'...' : 'NO ENCONTRADO');

    // ── PASO 2: POST login ─────────────────────────────────────────────────────
    const RUT_FIELD      = 'ae740e71936fa3eec403935de72a7aa3a68bbe7';
    const PASS_FIELD     = 'd70911c2de484460cf9f927ee6c6166585718189';
    const HONEYPOT_FIELD = 'c2414766d5fa42e71a24f97b559f2b1320cec4ee'; // campo invisible, debe ir vacío

    // Normalizar RUT: quitar puntos, mantener guión y DV  (ej: "96.673.250-4" → "96673250-4")
    const rutNormalizado = nuboxUser.replace(/\./g, '').trim();

    const loginBody = new URLSearchParams({
      [RUT_FIELD]: rutNormalizado,
      [PASS_FIELD]: nuboxPass,
      [HONEYPOT_FIELD]: '',
      gToken: '',
      ...(rvt ? { __RequestVerificationToken: rvt } : {}),
    }).toString();

    const { resp: loginResp, cookies: c1, finalUrl } = await fetchFollow(
      LOGIN_PAGE,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: LOGIN_PAGE },
        body: loginBody,
      },
      cookies
    );
    cookies = c1;

    // Verificar login exitoso
    if (!finalUrl.includes('SistemaLogin') && !finalUrl.includes('nubox.com/Sistema')) {
      const body = await loginResp.text();
      const errMsg = body.match(/class="[^"]*(?:error|alert|danger|warning)[^"]*"[^>]*>\s*([^<]{5,200})/i);
      // Buscar campo RUT en la página para confirmar que los field names son correctos
      const rutFieldInPage = body.match(/name="([a-f0-9]{30,})"/g);
      return res.status(401).json({
        error: 'Login fallido. Verificar NUBOX_PISA_USER y NUBOX_PISA_PASS',
        finalUrl,
        loginStatus: loginResp.status,
        nuboxUser_enviado: nuboxUser,
        rvtFound: !!rvt,
        rutFieldsEnPagina: rutFieldInPage ? rutFieldInPage.slice(0, 3) : 'ninguno',
        htmlError: errMsg ? errMsg[1].trim() : null,
        htmlSnippet: body.substring(0, 500),
      });
    }

    // ── PASO 3: Asegurar que tenemos la sesión en SistemaLogin ────────────────
    // Si no llegamos directamente a SistemaLogin, navegamos
    if (!finalUrl.includes('SistemaLogin')) {
      const { resp: slResp, cookies: c2 } = await fetchFollow(
        `${WEB}/SistemaLogin/`, {}, cookies
      );
      cookies = c2;
      await slResp.text(); // consumir body
    }

    // ── PASO 4: ObtenerListaClientes ──────────────────────────────────────────
    const { resp: listaResp, cookies: c3 } = await fetchManual(
      `${WEB}/SistemaLogin/Inicio/ObtenerListaClientes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${WEB}/SistemaLogin/`,
        },
      },
      cookies
    );
    cookies = c3;

    if (!listaResp.ok) {
      return res.status(502).json({
        error: `ObtenerListaClientes respondió ${listaResp.status}`,
        hint: 'Sesión inválida. Verificar credenciales.',
        cookies: cookies.substring(0, 200),
      });
    }

    const listaJson = await listaResp.json();
    if (listaJson.CodigoError !== 'E_00') {
      return res.status(401).json({
        error: 'Sesión rechazada: ' + (listaJson.MensajeHumano || listaJson.CodigoError),
      });
    }

    // ── PASO 5: Buscar producto Factura Electrónica PISA ──────────────────────
    const sistemas = listaJson.SistemasComputacionalesDeUsuario || [];
    const pisaRut = (process.env.NUBOX_PISA_RUT || '96673250').replace(/[^0-9]/g, '');

    let producto = sistemas.find(s => s.ParentCode && s.Rut === pisaRut);
    if (!producto) producto = sistemas.find(s => s.ParentCode);
    if (!producto || !producto.value) {
      return res.status(404).json({
        error: 'No se encontró el producto Factura Electrónica',
        sistemas: sistemas.map(s => ({ Id: s.Id, Rut: s.Rut, ParentCode: s.ParentCode })),
      });
    }

    // ── PASO 6: ObtieneClienteRedirect → utn ─────────────────────────────────
    const { resp: rdrResp, cookies: c4 } = await fetchManual(
      `${WEB}/SistemaLogin/Inicio/ObtieneClienteRedirect`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${WEB}/SistemaLogin/`,
        },
        body: `Idkey=${encodeURIComponent(producto.value)}&hubspot=&TagRedirect=`,
      },
      cookies
    );
    cookies = c4;

    const rdrJson = await rdrResp.json();
    if (rdrJson.CodigoError !== 'E_00' || !rdrJson.NombreTab) {
      return res.status(502).json({
        error: 'No se pudo obtener utn: ' + (rdrJson.MensajeHumano || rdrJson.CodigoError),
      });
    }
    const utn = rdrJson.NombreTab;

    // ── PASO 7: Establecer sesión en app.nubox.com ────────────────────────────
    const { resp: principalResp, cookies: appC0 } = await fetchFollow(
      `${APP}/ServiFactura/paginas/dtePrincipal.aspx?utn=${encodeURIComponent(utn)}`,
      {},
      ''
    );
    let appCookies = appC0;
    await principalResp.text();

    const { resp: dteResp, cookies: appC1 } = await fetchFollow(DTE, {}, appCookies);
    appCookies = appC1;
    const dteHtml = await dteResp.text();

    const tokenMatch =
      dteHtml.match(/var\s+token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/) ||
      dteHtml.match(/"token"\s*:\s*"([A-Za-z0-9+/=]{20,})"/) ||
      dteHtml.match(/token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/);

    if (!tokenMatch) {
      return res.status(500).json({
        error: 'No se pudo extraer token DTE. El utn puede haber expirado.',
        utn,
        htmlSnippet: dteHtml.substring(0, 600),
      });
    }
    const token = tokenMatch[1];
    const funcMatch = dteHtml.match(/funcionarioId\s*[=:]\s*["']?(\d{4,})["']?/);
    const funcionarioId = funcMatch ? funcMatch[1] : '339708';

    // ── PASO 8: ObtenerPorFiltro ──────────────────────────────────────────────
    const { resp: filtroResp } = await fetchManual(
      `${DTE}/ObtenerPorFiltro`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Referer: DTE },
        body: JSON.stringify({
          token, EstadoId: 3, estadoEnvio: 0,
          fechaDesde, fechaHasta,
          filtro: '<Terminos></Terminos>',
          folioDesde: 0, folioHasta: 0, usaFormatoImpresionEspecial: false,
        }),
      },
      appCookies
    );

    if (!filtroResp.ok)
      return res.status(502).json({ error: `ObtenerPorFiltro respondió ${filtroResp.status}` });

    const filtroJson = await filtroResp.json();
    const filtroInner = JSON.parse(filtroJson.d);
    const documentos = filtroInner.data || [];
    const totalDocs = filtroInner.total?.[0]?.Total ?? documentos.length;

    if (documentos.length === 0)
      return res.status(404).json({ error: `Sin facturas PISA para ${mes}`, fechaDesde, fechaHasta });

    const ids = documentos.map(d => d.Id).join(',');

    // ── PASO 9: VerPDF ────────────────────────────────────────────────────────
    const { resp: pdfGenResp } = await fetchManual(
      `${DTE}/VerPDF`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Referer: DTE },
        body: JSON.stringify({ token, funcionarioId, id: ids }),
      },
      appCookies
    );

    if (!pdfGenResp.ok)
      return res.status(502).json({ error: `VerPDF respondió ${pdfGenResp.status}` });

    const pdfGenJson = await pdfGenResp.json();
    const pdfPath = pdfGenJson.d;
    if (!pdfPath)
      return res.status(500).json({ error: 'VerPDF no devolvió path', respuesta: pdfGenJson });

    // ── PASO 10: Descargar PDF ────────────────────────────────────────────────
    const { resp: pdfDownResp } = await fetchManual(`${APP}${pdfPath}`, {}, appCookies);
    if (!pdfDownResp.ok)
      return res.status(502).json({ error: `Descarga PDF respondió ${pdfDownResp.status}` });

    const pdfBuffer = Buffer.from(await pdfDownResp.arrayBuffer());
    const fileName = `Facturas_PISA_${mes}.pdf`;

    // ── PASO 11: Subir a Google Drive ─────────────────────────────────────────
    const metadata = JSON.stringify({ name: fileName, mimeType: 'application/pdf', parents: [destFolderId] });
    const boundary = 'nubox_pdf_boundary';
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      pdfBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const uploadResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${googleToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      }
    );

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return res.status(502).json({ error: `Drive upload respondió ${uploadResp.status}`, detail: errText.substring(0, 300) });
    }

    const uploadJson = await uploadResp.json();
    return res.status(200).json({ ok: true, fileId: uploadJson.id, fileName, total: totalDocs, mes });

  } catch (err) {
    return res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
}
