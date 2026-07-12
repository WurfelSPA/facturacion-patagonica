/**
 * api/aguas-andinas.js
 *
 * Obtiene deuda actual y URL de la última boleta de Aguas Andinas
 * para un conjunto de IDs de cuenta.
 *
 * POST /api/aguas-andinas
 * Headers: x-sync-secret: <SYNC_SECRET>
 * Body: { cuentas: ["672977-0", "1009146-2", ...] }
 *
 * Env vars requeridas:
 *   AGUAS_RUT    - RUT de acceso al portal (ej: "12.345.678-9")
 *   AGUAS_CLAVE  - Clave del portal empresa
 *   SYNC_SECRET  - Secreto de autenticación
 */

// ── Constantes del portal ─────────────────────────────────────────────────────
const BASE         = 'https://www.aguasandinas.cl';
const INFO_PATH    = '/web/aguasandinas/informacion-de-la-cuenta';
const LOGIN_PATH   = '/web/aguasandinas/login';
const PORTLET_RES  = 'cl_aguasandinas_resumencuenta_AguasResumenCuentaPrivPortlet_INSTANCE_paQiKIWqNjaQ';
const NS_RES       = `_${PORTLET_RES}_`;
const PORTLET_HDR  = 'cl_aguasandinas_headeruser_preferences_HeaderUserPreferencesPortlet';
const NS_HDR       = `_${PORTLET_HDR}_priv_r_p_`;
const UA           = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookieHeader(raw) {
  const jar = {};
  for (const line of (Array.isArray(raw) ? raw : [raw]).filter(Boolean)) {
    const pair = line.split(';')[0].trim();
    const eq   = pair.indexOf('=');
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k) jar[k] = v;
    }
  }
  return jar;
}

function collectCookies(response) {
  // getSetCookie() es Node 18+; fallback a get('set-cookie')
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return parseCookieHeader(raw);
}

function mergeCookies(...jars) {
  return Object.assign({}, ...jars);
}

function formatCookies(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ── Fetch con manejo manual de redirects (para capturar cookies) ───────────────
async function fetchFollowingRedirects(url, opts = {}, jar = {}) {
  let current = url;
  let response;
  let redirects = 0;

  while (redirects < 8) {
    response = await fetch(current, {
      ...opts,
      headers: {
        'User-Agent': UA,
        'Cookie': formatCookies(jar),
        ...(opts.headers || {}),
      },
      redirect: 'manual',
    });

    const newCookies = collectCookies(response);
    jar = mergeCookies(jar, newCookies);

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) break;
      current = loc.startsWith('http') ? loc : `${BASE}${loc}`;
      redirects++;
      // Para GETs, limpiar body y Content-Type en el redirect
      opts = { ...opts, method: 'GET', body: undefined };
      delete (opts.headers || {})['Content-Type'];
    } else {
      break;
    }
  }

  return { response, jar };
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(rut, clave) {
  // 1. GET login page → obtener cookies iniciales + action URL
  const { response: r1, jar: jar1 } = await fetchFollowingRedirects(`${BASE}${LOGIN_PATH}`, {});
  const html1 = await r1.text();

  console.log('[aguas-andinas] Login page response:', r1.status, 'len:', html1.length,
    'hasRut:', html1.includes('LoginPortlet_rut'));

  // Extraer action URL del form de login (múltiples patrones)
  let fullAction = null;
  let pAuth = null;

  // Patrón 1: action contiene el portlet ID en la URL
  const m1 = html1.match(/action="(https?:\/\/[^"]*cl_aguasandinas_login_LoginPortlet[^"]*)"/i)
           || html1.match(/action="([^"]*cl_aguasandinas_login_LoginPortlet[^"]*)"/i);
  if (m1) {
    const url = m1[1].replace(/&amp;/g, '&');
    fullAction = url.startsWith('http') ? url : `${BASE}${url}`;
    console.log('[aguas-andinas] Action encontrado via portlet ID');
  }

  // Extraer p_auth del HTML (para construir la URL si no se encontró)
  const authM = html1.match(/["']p_auth["']\s*[=:]\s*["']([^"']{6,})/i)
             || html1.match(/name="p_auth"[^>]*value="([^"]+)"/i)
             || html1.match(/Liferay\.authToken\s*=\s*["']([^"']+)/i);
  if (authM) pAuth = authM[1];

  // Patrón 2: construir URL manualmente si tenemos p_auth
  if (!fullAction && pAuth) {
    const portletNs = '_cl_aguasandinas_login_LoginPortlet_';
    const params = new URLSearchParams({
      'p_p_id'       : 'cl_aguasandinas_login_LoginPortlet',
      'p_p_lifecycle': '1',
      'p_p_state'    : 'normal',
      'p_p_mode'     : 'view',
      'p_auth'       : pAuth,
      [`${portletNs}javax.portlet.action`]: '/login/customlogin',
    });
    fullAction = `${BASE}${LOGIN_PATH}?${params}`;
    console.log('[aguas-andinas] Action construido manualmente con p_auth');
  }

  if (!fullAction) {
    // Log del HTML para diagnóstico
    const snippet = html1.slice(0, 2000);
    throw new Error(`No se encontró el formulario de login. HTML snippet: ${snippet}`);
  }

  // 2. POST login
  const body = new URLSearchParams({
    '_cl_aguasandinas_login_LoginPortlet_rut'  : rut,
    '_cl_aguasandinas_login_LoginPortlet_clave': clave,
  });

  const { response: r2, jar: jar2 } = await fetchFollowingRedirects(fullAction, {
    method : 'POST',
    body   : body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer'     : `${BASE}${LOGIN_PATH}`,
      'Origin'      : BASE,
    },
  }, jar1);

  const html2 = await r2.text();
  console.log('[aguas-andinas] Post-login status:', r2.status, 'len:', html2.length);

  // Verificar login exitoso
  if (html2.includes('_cl_aguasandinas_login_LoginPortlet_rut')) {
    throw new Error('Login fallido: credenciales incorrectas o el portal rechazó el acceso');
  }

  // Extraer authToken y rolRender de la página post-login
  const authToken = html2.match(/Liferay\.authToken\s*[=:]\s*['"]([^'"]+)['"]/)?.[1]
                 || html2.match(/authToken["']?\s*[:=]\s*["']([^"']+)["']/)?.[1];
  const rolRender = html2.match(/_priv_r_p_rolRender[="](\d+)/)?.[1]
                 || html2.match(/rolRender[^0-9]*(\d{4,})/)?.[1]
                 || '26197';

  if (!authToken) {
    throw new Error('Login OK pero no se pudo extraer authToken. HTML len: ' + html2.length);
  }

  console.log('[aguas-andinas] authToken extraído, rolRender:', rolRender);
  return { jar: jar2, authToken, rolRender };
}

// ── Cambiar cuenta ─────────────────────────────────────────────────────────────
async function switchAccount(jar, authToken, rolRender, accountBase) {
  // accountBase = ID sin dígito verificador (ej: "672977" de "672977-0")
  const params = new URLSearchParams({
    'p_p_id'  : PORTLET_HDR,
    'p_p_lifecycle': '1',
    'p_p_mode': 'view',
    'p_p_state': 'normal',
    'p_auth'  : authToken,
    [`${NS_HDR}cuentaRender`]             : accountBase,
    [`${NS_HDR}cuentaSel`]                : 'OK',
    [`${NS_HDR}empresaRender`]            : '1',
    [`${NS_HDR}rolRender`]                : rolRender,
    [`${NS_HDR}javax.portlet.action`]     : '/cuenta/seleccion',
  });

  const { response, jar: newJar } = await fetchFollowingRedirects(
    `${BASE}${INFO_PATH}?${params}`,
    {},
    jar
  );

  const html = await response.text();
  return { jar: newJar, html };
}

// ── Parsear deuda actual ───────────────────────────────────────────────────────
function parseDeuda(html) {
  // <span class="total_deuda montoDeuda">$X.XXX</span>
  const m1 = html.match(/class="[^"]*total_deuda[^"]*"[^>]*>\s*([^<]+)/);
  if (m1) return m1[1].trim();
  // Fallback por texto
  const m2 = html.match(/(?:deuda vigente|Tu deuda)[\s\S]{0,600}(\$[\d.,]+)/i);
  if (m2) return m2[1].trim();
  return null;
}

// ── Parsear vencimiento ────────────────────────────────────────────────────────
function parseVencimiento(html) {
  const m = html.match(/Vence el\s+([^<\n]+)/i);
  return m ? m[1].trim() : null;
}

// ── Obtener lista de boletas ──────────────────────────────────────────────────
async function getBoletas(jar) {
  const url = `${BASE}${INFO_PATH}?p_p_id=${PORTLET_RES}&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_resource_id=%2FobtenerResumenBoleta&p_p_cacheability=cacheLevelPage`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent'  : UA,
      'Cookie'      : formatCookies(jar),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: '',
  });

  if (!r.ok) throw new Error(`obtenerResumenBoleta HTTP ${r.status}`);

  const json = await r.json();
  const tableHtml = json.tablaHistoricoFacturacion || '';

  // Parsear filas de la tabla (regex, sin DOM)
  const rows = [];
  for (const rowMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1];
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim());
    if (cells.length >= 4 && cells[0] && !/mes|month/i.test(cells[0])) {
      rows.push({ mes: cells[0], fecha: cells[1], monto: cells[2], estado: cells[3] });
    }
  }

  // Parsear inputs hidden: id="nroFolio_0" value="XXX"
  const inputs = {};
  for (const m of tableHtml.matchAll(/id="(\w+_\d+)"[^>]*value="([^"]+)"/gi)) {
    inputs[m[1]] = m[2];
  }

  return { rows, inputs };
}

// ── Obtener URL de boleta PDF ─────────────────────────────────────────────────
async function getBoletaUrl(jar, inputs, index = 0) {
  const url = `${BASE}${INFO_PATH}?p_p_id=${PORTLET_RES}&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_resource_id=%2FdescargaDocumento&p_p_cacheability=cacheLevelPage`;

  const nroFolio     = inputs[`nroFolio_${index}`];
  const empresa      = inputs[`empresa_${index}`];
  const tipoDoc      = inputs[`tipoDocumento_${index}`];

  if (!nroFolio) return null;

  const body = new URLSearchParams({
    [`${NS_RES}nroFolio`]      : nroFolio,
    [`${NS_RES}empresa`]       : empresa,
    [`${NS_RES}tipoDocumento`] : tipoDoc,
  });

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent'  : UA,
      'Cookie'      : formatCookies(jar),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!r.ok) return null;

  const json = await r.json();
  // { codigo: "0", urlDocumento: "https://ereceipt-cl-aguasandinas.sovos.com/...", mensaje: "..." }
  if (json.codigo === '0' && json.urlDocumento) return json.urlDocumento;
  return null;
}

// ── CORS ───────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Soporta múltiples nombres de variable para compatibilidad
  const RUT   = process.env.AGUAS_RUT || process.env.AGUAS_ANDINAS_USER || process.env.AGUAS_ANDINASc;
  const CLAVE = process.env.AGUAS_CLAVE || process.env.AGUAS_ANDINAS_PASS;
  if (!RUT || !CLAVE) {
    return res.status(500).json({
      error: 'Faltan credenciales AA. Configura AGUAS_ANDINAS_PASS y AGUAS_ANDINASc (o AGUAS_RUT/AGUAS_CLAVE) en Vercel'
    });
  }

  const { cuentas } = req.body || {};
  if (!Array.isArray(cuentas) || cuentas.length === 0) {
    return res.status(400).json({ error: 'cuentas debe ser un array no vacío de IDs' });
  }

  const results = [];
  const errors  = [];

  // Modo debug: retorna el HTML del login para diagnosticar
  if (req.body?.debug) {
    const r = await fetch(`${BASE}${LOGIN_PATH}`, { headers: { 'User-Agent': UA } });
    const html = await r.text();
    return res.status(200).json({
      status: r.status,
      htmlLen: html.length,
      htmlStart: html.slice(0, 1500),
      allActions: (html.match(/action="[^"]+"/gi) || []).slice(0, 10),
      hasRutField: html.includes('LoginPortlet_rut'),
      hasReese84: html.includes('reese84') || html.includes('Imperva'),
    });
  }

  try {
    // Login único para toda la sesión
    console.log('[aguas-andinas] Iniciando sesión...');
    const { jar: sessionJar, authToken, rolRender } = await login(RUT, CLAVE);
    console.log('[aguas-andinas] Login OK, procesando', cuentas.length, 'cuentas');

    const deudaOnly = req.body?.deudaOnly !== false; // default: true (solo deuda por ahora)

    for (const idAgua of cuentas) {
      const accountBase = String(idAgua).split('-')[0]; // "672977" de "672977-0"

      try {
        console.log(`[aguas-andinas] Cuenta ${idAgua} (base: ${accountBase})`);

        // 1. Cambiar a esta cuenta y obtener HTML de la página
        const { jar: accountJar, html: pageHtml } = await switchAccount(
          sessionJar, authToken, rolRender, accountBase
        );

        // 2. Parsear deuda del HTML de la página
        const deuda       = parseDeuda(pageHtml);
        const vencimiento = parseVencimiento(pageHtml);
        console.log(`[aguas-andinas]   Deuda: ${deuda}, Vence: ${vencimiento}`);

        const result = {
          idAgua,
          deuda:       deuda || '$0',
          vencimiento: vencimiento || null,
          ultimaBoleta: null,
        };

        // 3+4. Boleta y PDF — solo si deudaOnly=false
        if (!deudaOnly) {
          const { rows, inputs } = await getBoletas(accountJar);
          const ultimaBoleta = rows[0] || null;
          console.log(`[aguas-andinas]   Boletas: ${rows.length}`);

          let sovosUrl = null;
          if (ultimaBoleta) {
            sovosUrl = await getBoletaUrl(accountJar, inputs, 0);
          }

          result.ultimaBoleta = ultimaBoleta ? {
            mes: ultimaBoleta.mes, monto: ultimaBoleta.monto,
            estado: ultimaBoleta.estado, fecha: ultimaBoleta.fecha, sovosUrl,
          } : null;
        }

        results.push(result);

      } catch (err) {
        console.error(`[aguas-andinas] Error en cuenta ${idAgua}:`, err.message);
        errors.push({ idAgua, error: err.message });
      }
    }
  } catch (err) {
    console.error('[aguas-andinas] Error de login:', err.message);
    return res.status(502).json({ error: 'Error de login: ' + err.message });
  }

  return res.status(200).json({ ok: true, results, errors });
}
