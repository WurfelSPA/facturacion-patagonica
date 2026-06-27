// /api/cruce.js
// Cruce automático Odoo vs SII para facturas tipo 33 y notas de crédito tipo 61
// Uso: GET /api/cruce?empresa=multi&mes=2026-05
//      GET /api/cruce?empresa=dko&mes=2026-05

import forge from "node-forge";
import { SignedXml } from "xml-crypto";

const RUT_MAP = {
  dko:   { rut: "77454587-5", certEnv: "SII_CERT_DKO",   passEnv: "SII_CERT_PASS_DKO",   odooDb: "ODOO_DKO_DB",   odooUser: "ODOO_DKO_USER",   odooPass: "ODOO_DKO_PASS" },
  multi: { rut: "77538786-6", certEnv: "SII_CERT_MULTI",  passEnv: "SII_CERT_PASS_MULTI", odooDb: "ODOO_MULTI_DB", odooUser: "ODOO_MULTI_USER", odooPass: "ODOO_MULTI_PASS" },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { empresa = "multi", mes = "2026-05" } = req.query;

  const cfg = RUT_MAP[empresa];
  if (!cfg) return res.status(400).json({ error: "Empresa desconocida" });

  // Ver compañías disponibles en Odoo
  if (req.query.action === "companies") {
    const ODOO_URL = process.env.ODOO_DKO_URL;
    const db   = process.env[cfg.odooDb];
    const user = process.env[cfg.odooUser];
    const pass = process.env[cfg.odooPass];
    const loginRes = await fetch(`${ODOO_URL}/web/session/authenticate`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:1, params:{ db, login:user, password:pass } }),
    });
    const cookie = loginRes.headers.get("set-cookie") || "";
    const companies = await odooCall(ODOO_URL, cookie, "res.company", "search_read", [[]], ["id","name","vat"]);
    return res.json({ ok:true, companies });
  }

  try {
    // Obtener token SII una sola vez (se reutiliza para tipo 33 y tipo 61)
    const siiToken = await getSIIToken(cfg);

    // Ejecutar en paralelo: Odoo facturas + SII facturas + Odoo NC + SII NC
    const [odooResult, siiResult, odooNcResult, siiNcResult] = await Promise.allSettled([
      getOdooDocumentos(cfg, mes, "out_invoice", "33"),
      getSIIDocumentos(cfg, mes, "33", siiToken),
      getOdooDocumentos(cfg, mes, "out_refund", "61"),
      getSIIDocumentos(cfg, mes, "61", siiToken),
    ]);

    if (odooResult.status === "rejected") {
      return res.status(500).json({ error: "Error Odoo facturas: " + odooResult.reason.message });
    }
    if (siiResult.status === "rejected") {
      return res.status(500).json({ error: "Error SII facturas: " + siiResult.reason.message });
    }

    const odoo   = odooResult.value;
    const sii    = siiResult.value;
    const odooNc = odooNcResult.status === "fulfilled" ? odooNcResult.value : [];
    const siiNc  = siiNcResult.status  === "fulfilled" ? siiNcResult.value  : [];

    // Cruce facturas (tipo 33)
    const cruce = cruzar(odoo, sii);

    // Cruce notas de crédito (tipo 61)
    const cruceNc = cruzar(odooNc, siiNc);

    const totalOdoo   = odoo.reduce((s, f) => s + f.total, 0);
    const totalSii    = sii.reduce((s, f) => s + f.total, 0);
    const totalNcOdoo = odooNc.reduce((s, f) => s + f.total, 0);
    const totalNcSii  = siiNc.reduce((s, f) => s + f.total, 0);

    return res.json({
      ok: true,
      empresa,
      mes,
      // Facturas tipo 33
      odoo_count:  odoo.length,
      sii_count:   sii.length,
      coinciden:   cruce.coinciden.length,
      diff_monto:  cruce.diff_monto,
      solo_odoo:   cruce.solo_odoo,
      solo_sii:    cruce.solo_sii,
      total_odoo:  totalOdoo,
      total_sii:   totalSii,
      // Notas de crédito tipo 61
      nc_odoo_count:  odooNc.length,
      nc_sii_count:   siiNc.length,
      nc_coinciden:   cruceNc.coinciden.length,
      nc_diff_monto:  cruceNc.diff_monto,
      nc_solo_odoo:   cruceNc.solo_odoo,
      nc_solo_sii:    cruceNc.solo_sii,
      total_nc_odoo:  totalNcOdoo,
      total_nc_sii:   totalNcSii,
      // Totales netos (facturas − NC)
      total_odoo_neto: totalOdoo - totalNcOdoo,
      total_sii_neto:  totalSii  - totalNcSii,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

/* ── Cruce por folio ── */
function cruzar(odoo, sii) {
  // Normalizar folios: quitar ceros iniciales y espacios para comparar
  const normFolio = f => String(f).replace(/^0+/, "").trim();
  const odooMap = Object.fromEntries(odoo.map(f => [normFolio(f.folio), f]));
  const siiMap  = Object.fromEntries(sii.map(f => [normFolio(f.folio), f]));

  const coinciden  = [];
  const diff_monto = [];
  const solo_odoo  = [];
  const solo_sii   = [];

  const todos = new Set([...Object.keys(odooMap), ...Object.keys(siiMap)]);

  for (const folio of todos) {
    const enOdoo = folio in odooMap;
    const enSII  = folio in siiMap;

    if (enOdoo && enSII) {
      const to = odooMap[folio].total;
      const ts = siiMap[folio].total;
      if (Math.abs(to - ts) <= 1) { // tolerancia $1 por redondeo
        coinciden.push({ folio, total: to });
      } else {
        diff_monto.push({
          folio,
          total_odoo: to,
          total_sii:  ts,
          diff:       to - ts,
          cliente:    odooMap[folio].cliente || siiMap[folio].razon,
          fecha:      odooMap[folio].fecha,
        });
      }
    } else if (enOdoo) {
      const f = odooMap[folio];
      solo_odoo.push({
        folio,
        total:      f.total,
        cliente:    f.cliente,
        fecha:      f.fecha,
        estado_sii: f.estado_sii,
      });
    } else {
      const f = siiMap[folio];
      solo_sii.push({
        folio,
        total: f.total,
        razon: f.razon,
        fecha: f.fecha,
      });
    }
  }

  return { coinciden, diff_monto, solo_odoo, solo_sii };
}

/* ── Obtener documentos desde Odoo (facturas out_invoice/33 o NC out_refund/61) ── */
async function getOdooDocumentos(cfg, mes, moveType, codDoc) {
  const ODOO_URL = process.env.ODOO_DKO_URL;
  const db   = process.env[cfg.odooDb];
  const user = process.env[cfg.odooUser];
  const pass = process.env[cfg.odooPass];

  // Login
  const loginRes = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:1, params:{ db, login:user, password:pass } }),
  });
  const cookie = loginRes.headers.get("set-cookie") || "";
  const loginData = await loginRes.json();
  if (!loginData.result?.uid) throw new Error("Login Odoo fallido");

  const [anio, mesNum] = mes.split("-");
  const fechaDesde = `${anio}-${mesNum}-01`;
  // Calcular último día real del mes
  const ultimoDia = new Date(parseInt(anio), parseInt(mesNum), 0).getDate();
  const fechaHasta = `${anio}-${mesNum}-${ultimoDia}`;

  // Buscar compañía por RUT (más confiable que por nombre)
  const rutSinDv = cfg.rut.replace("-","").slice(0,-1); // ej: "77538786"
  const companies = await odooCall(ODOO_URL, cookie, "res.company", "search_read",
    [[["vat", "like", rutSinDv]]], ["id","name","vat"]);

  const domain = [
    ["move_type", "=", moveType],
    ["state", "=", "posted"],
    ["invoice_date", ">=", fechaDesde],
    ["invoice_date", "<=", fechaHasta],
    ["l10n_latam_document_type_id.code", "=", codDoc],
  ];
  if (companies.length > 0) {
    domain.push(["company_id", "=", companies[0].id]);
  }

  const facturas = await odooCall(ODOO_URL, cookie, "account.move", "search_read", [domain], [
    "name", "partner_id", "invoice_date", "amount_total",
    "l10n_latam_document_number", "l10n_cl_dte_status",
  ], 5000);

  return facturas.map(f => ({
    folio:      String(f.l10n_latam_document_number || "").trim(),
    cliente:    f.partner_id?.[1] || "",
    fecha:      f.invoice_date || "",
    total:      Math.round(Math.abs(f.amount_total)), // NC en Odoo vienen negativas
    estado_sii: f.l10n_cl_dte_status || "",
  })).filter(f => f.folio);
}

async function odooCall(url, cookie, model, method, args, fields, limit = 5000) {
  const kwargs = fields ? { fields, limit, context:{ lang:"es_CL" } } : { context:{ lang:"es_CL" } };
  const res = await fetch(`${url}/web/dataset/call_kw`, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Cookie":cookie },
    body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:Math.random()*9999|0, params:{ model, method, args, kwargs } }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result;
}

/* ── Autenticación SII (token reutilizable) ── */
async function getSIIToken(cfg) {
  const certB64  = process.env[cfg.certEnv] || process.env.SII_CERT;
  const certPass = process.env[cfg.passEnv] || process.env.SII_CERT_PASS;
  if (!certB64 || !certPass) throw new Error(`Faltan ${cfg.certEnv} o ${cfg.passEnv}`);

  const certBuf = Buffer.from(certB64, "base64");
  const { privateKeyPem, certificatePem } = extractFromPfx(certBuf, certPass);

  const semilla    = await getSemilla();
  const xmlFirmado = firmarSemilla(semilla, privateKeyPem, certificatePem);
  return await getToken(xmlFirmado);
}

/* ── Obtener documentos desde SII (facturas tipo 33 o NC tipo 61) ── */
async function getSIIDocumentos(cfg, mes, codTipoDoc, token) {
  const [anio, mesNum] = mes.split("-");
  const [rutNum, dv]   = cfg.rut.split("-");
  const periodo        = `${anio}${mesNum.padStart(2,"0")}`;

  // Para NC (tipo 61) usamos operacion VENTA igualmente (NC emitidas por la empresa)
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleVentaExport", {
    method: "POST",
    headers: {
      "Cookie":       `TOKEN=${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent":   "Mozilla/5.0",
    },
    body: JSON.stringify({
      metaData: { conversationId:token, transactionId:"0", namespace:"cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleVentaExport", page:null },
      data: { rutEmisor:rutNum, dvEmisor:dv, ptributario:periodo, operacion:"VENTA", estadoContab:"REGISTRO", codTipoDoc:codTipoDoc, accionRecaptcha:"RCV_DDETV", tokenRecaptcha:"c3" },
    }),
  });

  const json = await r.json();
  const csvLines = Array.isArray(json?.data) ? json.data : [];
  if (!csvLines.length) return [];

  const header = csvLines[0].split(";");
  const col    = name => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
  const iFolio = col("folio"), iRut = col("rut cliente"), iRazon = col("razon social");
  const iFecha = col("fecha docto"), iTotal = col("monto total");

  return csvLines.slice(1).map(line => {
    const c = line.split(";");
    const g = (i, fb) => (c[i >= 0 ? i : fb] || "").trim();
    return {
      folio: g(iFolio, 4),
      rut:   g(iRut, 2),
      razon: g(iRazon, 3),
      fecha: g(iFecha, 5).split(" ")[0],
      total: Math.abs(parseInt(g(iTotal, 12)) || 0), // NC pueden venir negativas en SII
    };
  }).filter(f => f.folio);
}

/* ── Helpers SII ── */
function extractFromPfx(pfxBuf, password) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary"))), password);
  const key  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]?.cert;
  if (!key || !cert) throw new Error("Certificado o clave no encontrados en PFX");
  return { privateKeyPem: forge.pki.privateKeyToPem(key), certificatePem: forge.pki.certificateToPem(cert) };
}

async function getSemilla() {
  const r = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", {
    method:"POST", headers:{"Content-Type":"text/xml; charset=utf-8","SOAPAction":""},
    body:`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getSeed/></soapenv:Body></soapenv:Envelope>`,
  });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getSeedReturn[^>]*>([\s\S]+?)<\/getSeedReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const m = xml.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) throw new Error("No se pudo obtener semilla: " + text.slice(0,200));
  return m[1];
}

function firmarSemilla(semilla, privateKeyPem, certificatePem) {
  const certClean = certificatePem.replace("-----BEGIN CERTIFICATE-----","").replace("-----END CERTIFICATE-----","").replace(/\r?\n/g,"").trim();
  const sig = new SignedXml({
    privateKey: privateKeyPem, publicCert: certificatePem,
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });
  sig.addReference({ xpath:"/*", transforms:["http://www.w3.org/2000/09/xmldsig#enveloped-signature"], digestAlgorithm:"http://www.w3.org/2000/09/xmldsig#sha1" });
  sig.computeSignature(`<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`, { location:{ reference:"/getToken", action:"append" } });
  let signed = sig.getSignedXml().replace(/<KeyInfo>[\s\S]*?<\/KeyInfo>/,`<KeyInfo><X509Data><X509Certificate>${certClean}</X509Certificate></X509Data></KeyInfo>`);
  return `<?xml version="1.0" encoding="UTF-8"?>${signed}`;
}

async function getToken(xmlFirmado) {
  const xmlEsc = xmlFirmado.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const r = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", {
    method:"POST", headers:{"Content-Type":"text/xml; charset=utf-8","SOAPAction":""},
    body:`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getToken><pszXml>${xmlEsc}</pszXml></getToken></soapenv:Body></soapenv:Envelope>`,
  });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getTokenReturn[^>]*>([\s\S]+?)<\/getTokenReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const estado = xml.match(/<ESTADO>([^<]+)<\/ESTADO>/)?.[1];
  if (estado && estado !== "00") throw new Error(`SII token error ${estado}: ${xml.match(/<GLOSA>([^<]+)<\/GLOSA>/)?.[1]||""}`);
  const m = xml.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) throw new Error("Token no encontrado");
  return m[1];
}
