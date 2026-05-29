/**
 * /api/nubox-pisa
 *
 * Automatiza la descarga del PDF consolidado de facturas PISA desde Nubox.
 *
 * Parámetros GET:
 *   mes  — período en formato YYYY-MM  (ej: 2026-05)
 *   utn  — token de sesión obtenido de la URL de Nubox
 *            (la parte que sigue a ?utn= en app.nubox.com/ServiFactura/paginas/dtePrincipal.aspx?utn=...)
 *
 * Respuesta exitosa:
 *   { ok: true, pdfUrl: "https://app.nubox.com/...", total: 130, mes: "2026-05" }
 *
 * Flujo interno:
 *   1. GET dtePrincipal.aspx?utn=... → establece sesión (cookies) + extrae token de página
 *   2. POST ObtenerPorFiltro con rango de fechas del mes → lista de IDs
 *   3. POST VerPDF con todos los IDs → path del PDF generado
 *   4. Devuelve URL completa del PDF
 */

export default async function handler(req, res) {
  // CORS para llamadas desde el frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { mes, utn } = req.query;

  if (!utn) {
    return res.status(400).json({ error: 'Se requiere el parámetro utn' });
  }
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ error: 'Se requiere el parámetro mes en formato YYYY-MM' });
  }

  const [year, month] = mes.split('-');
  const fechaDesde = `01/${month}/${year}`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const fechaHasta = `${String(lastDay).padStart(2, '0')}/${month}/${year}`;

  const BASE = 'https://app.nubox.com';
  const HEADERS_BASE = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'es-CL,es;q=0.9',
  };

  try {
    // ── PASO 1: Establecer sesión con utn y extraer token de página ───────────
    const principalUrl = `${BASE}/ServiFactura/paginas/dtePrincipal.aspx?utn=${encodeURIComponent(utn)}`;
    const principalRes = await fetch(principalUrl, {
      headers: HEADERS_BASE,
      redirect: 'follow',
    });

    // Recolectar cookies de sesión
    const rawCookies = principalRes.headers.getSetCookie
      ? principalRes.headers.getSetCookie()
      : (principalRes.headers.get('set-cookie') ? [principalRes.headers.get('set-cookie')] : []);
    const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

    // Cargar la página de documentos para obtener el token embebido
    const dtePage = `${BASE}/ServiFactura/paginas/dteDocumentosTributarios.aspx`;
    const dteRes = await fetch(dtePage, {
      headers: { ...HEADERS_BASE, Cookie: cookieHeader },
      redirect: 'follow',
    });

    const html = await dteRes.text();

    // Extraer token — aparece como: var token = "xxxx"  o  token: "xxxx"
    const tokenMatch =
      html.match(/var\s+token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/) ||
      html.match(/"token"\s*:\s*"([A-Za-z0-9+/=]{20,})"/) ||
      html.match(/token\s*=\s*["']([A-Za-z0-9+/=]{20,})["']/);

    if (!tokenMatch) {
      return res.status(500).json({
        error: 'No se pudo extraer el token de la página de Nubox. El utn puede haber expirado.',
        hint: 'Obtén un utn fresco desde la URL de tu sesión activa en Nubox.',
        htmlSnippet: html.substring(0, 800),
      });
    }
    const token = tokenMatch[1];

    // Extraer funcionarioId — aparece como: funcionarioId: "339708"  o similar
    const funcMatch =
      html.match(/funcionarioId\s*[=:]\s*["']?(\d{4,})["']?/) ||
      html.match(/"funcionarioId"\s*:\s*"(\d+)"/);
    const funcionarioId = funcMatch ? funcMatch[1] : '339708'; // fallback conocido

    // ── PASO 2: ObtenerPorFiltro → lista de IDs del mes ──────────────────────
    const filtroRes = await fetch(`${dtePage}/ObtenerPorFiltro`, {
      method: 'POST',
      headers: {
        ...HEADERS_BASE,
        'Content-Type': 'application/json; charset=utf-8',
        Cookie: cookieHeader,
        Referer: dtePage,
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
      return res.status(502).json({
        error: `ObtenerPorFiltro respondió ${filtroRes.status}`,
        body: await filtroRes.text(),
      });
    }

    const filtroJson = await filtroRes.json();
    const filtroInner = JSON.parse(filtroJson.d);
    const documentos = filtroInner.data || [];
    const totalDocs = filtroInner.total?.[0]?.Total ?? documentos.length;

    if (documentos.length === 0) {
      return res.status(404).json({
        error: `No se encontraron documentos para ${mes}`,
        fechaDesde,
        fechaHasta,
      });
    }

    const ids = documentos.map(d => d.Id).join(',');

    // ── PASO 3: VerPDF → genera PDF con todos los documentos ─────────────────
    const pdfRes = await fetch(`${dtePage}/VerPDF`, {
      method: 'POST',
      headers: {
        ...HEADERS_BASE,
        'Content-Type': 'application/json; charset=utf-8',
        Cookie: cookieHeader,
        Referer: dtePage,
      },
      body: JSON.stringify({ token, funcionarioId, id: ids }),
    });

    if (!pdfRes.ok) {
      return res.status(502).json({
        error: `VerPDF respondió ${pdfRes.status}`,
        body: await pdfRes.text(),
      });
    }

    const pdfJson = await pdfRes.json();
    // pdfJson.d es el path: "/ServiFactura/paginas/temp/DTE....pdf"
    const pdfPath = pdfJson.d;
    const pdfUrl = `${BASE}${pdfPath}`;

    return res.status(200).json({
      ok: true,
      pdfUrl,
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
