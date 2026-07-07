/**
 * /api/erp  — fusión de /api/odoo + /api/sii
 *
 * Parámetro selector:  ?service=odoo  (default)  →  Odoo JSON-RPC
 *                      ?service=sii               →  SII certificado digital + RCV
 *
 * Odoo:  GET /api/erp?service=odoo&empresa=dko|multi&mes=YYYY-MM[&action=test]
 * SII:   GET /api/erp?service=sii&empresa=dko|multi&mes=YYYY-MM[&action=test|cert|token|debug|debug_rcv|soap]
 */

import forge from "node-forge";
import { SignedXml } from "xml-crypto";

// ═══════════════════════════════════════════════════════════════════════════
// ODOO
// ═══════════════════════════════════════════════════════════════════════════

async function handleOdoo(req, res) {
  const { empresa = "dko", mes, action } = req.query;

  const cfg = empresa === "multi" ? {
    url:  process.env.ODOO_DKO_URL,
    db:   process.env.ODOO_MULTI_DB,
    user: process.env.ODOO_MULTI_USER,
    pass: process.env.ODOO_MULTI_PASS,
  } : {
    url:  process.env.ODOO_DKO_URL,
    db:   process.env.ODOO_DKO_DB,
    user: process.env.ODOO_DKO_USER,
    pass: process.env.ODOO_DKO_PASS,
  };

  if (!cfg.url || !cfg.db || !cfg.user || !cfg.pass) {
    return res.status(500).json({ error: "Variables de entorno Odoo no configuradas" });
  }

  try {
    const { uid, cookie } = await odooLogin(cfg);
    if (!uid) return res.status(401).json({ error: "Autenticación fallida" });

    if (action === "test") {
      return res.json({ ok: true, uid, db: cfg.db, user: cfg.user, mensaje: "Conexión exitosa" });
    }

    const [anio, mesNum] = (mes || "2026-05").split("-").map(Number);
    const fechaDesde = `${anio}-${String(mesNum).padStart(2,"0")}-01`;
    const ultimoDia = new Date(anio, parseInt(mesNum), 0).getDate();
    const fechaHasta = `${anio}-${String(mesNum).padStart(2,"0")}-${ultimoDia}`;

    const domain = [
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["invoice_date", ">=", fechaDesde],
      ["invoice_date", "<=", fechaHasta],
    ];

    const companyName = empresa === "dko" ? "dko" : "sanchez";
    const companies = await odooCall(cfg, uid, cookie, "res.company", "search_read",
      [[["name", "ilike", companyName]]], ["id", "name", "vat"]);

    if (empresa === "dko" && companies.length > 0) {
      domain.push(["company_id", "=", companies[0].id]);
    } else if (empresa === "multi") {
      const multi = companies.find(c => !c.name.toLowerCase().includes("dko"));
      if (multi) domain.push(["company_id", "=", multi.id]);
    }

    const facturas = await odooCall(cfg, uid, cookie, "account.move", "search_read", [domain], [
      "name", "partner_id", "invoice_date", "amount_untaxed", "amount_total",
      "state", "l10n_latam_document_number", "l10n_latam_document_type_id",
      "l10n_cl_dte_status", "l10n_cl_dte_acceptation_status", "company_id",
    ], 5000);

    const partnerIds = [...new Set(facturas.map(f => f.partner_id?.[0]).filter(Boolean))];
    const partners = partnerIds.length > 0
      ? await odooCall(cfg, uid, cookie, "res.partner", "search_read",
          [[["id", "in", partnerIds]]], ["id", "vat"], partnerIds.length + 10)
      : [];
    const partnerMap = Object.fromEntries(partners.map(p => [p.id, p.vat || ""]));

    return res.json({
      ok: true, empresa, mes, total: facturas.length,
      facturas: facturas.map(f => ({
        numero:      f.name,
        folio:       f.l10n_latam_document_number,
        tipo_doc:    f.l10n_latam_document_type_id?.[1] || "",
        fecha:       f.invoice_date,
        rut:         partnerMap[f.partner_id?.[0]] || "",
        cliente:     f.partner_id?.[1] || "",
        neto:        Math.round(f.amount_untaxed),
        total:       Math.round(f.amount_total),
        estado:      f.state,
        estado_sii:  f.l10n_cl_dte_status || "",
        estado_acep: f.l10n_cl_dte_acceptation_status || "",
        empresa:     f.company_id?.[1] || "",
      }))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

async function odooLogin({ url, db, user, pass }) {
  const res = await fetch(`${url}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { db, login: user, password: pass } }),
  });
  const cookie = res.headers.get("set-cookie") || "";
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return { uid: data.result?.uid, cookie };
}

async function odooCall({ url }, uid, cookie, model, method, args, fields, limit = 5000) {
  const kwargs = fields ? { fields, limit, context: { lang: "es_CL" } } : { context: { lang: "es_CL" } };
  const res = await fetch(`${url}/web/dataset/call_kw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Math.floor(Math.random()*9999), params: { model, method, args, kwargs } }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SII
// ═══════════════════════════════════════════════════════════════════════════

const RUT_MAP = {
  dko:   { rut: "77454587-5", certEnv: "SII_CERT_DKO",   passEnv: "SII_CERT_PASS_DKO" },
  multi: { rut: "77538786-6", certEnv: "SII_CERT_MULTI",  passEnv: "SII_CERT_PASS_MULTI" },
};

async function handleSii(req, res) {
  const { empresa = "multi", mes = "2026-05", action } = req.query;
  const cfg = RUT_MAP[empresa];
  if (!cfg) return res.status(400).json({ error: "Empresa desconocida" });

  const certB64 = process.env[cfg.certEnv] || process.env.SII_CERT;
  const certPass = process.env[cfg.passEnv] || process.env.SII_CERT_PASS;
  if (!certB64 || !certPass) {
    return res.status(500).json({ error: `Faltan ${cfg.certEnv} o ${cfg.passEnv}` });
  }

  try {
    const certBuf = Buffer.from(certB64, "base64");
    if (action === "test") return res.json({ ok: true, empresa, certBytes: certBuf.length });

    const { privateKeyPem, certificatePem } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      const cert = forge.pki.certificateFromPem(certificatePem);
      return res.json({ ok: true, subject: cert.subject.getField("CN")?.value, issuer: cert.issuer.getField("CN")?.value, validTo: cert.validity.notAfter });
    }

    const semilla = await getSemilla();
    const xmlFirmado = firmarSemilla(semilla, privateKeyPem, certificatePem);

    if (action === "debug") return res.json({ ok: true, semilla, xmlFirmado });

    if (action === "soap") {
      const xmlEsc = xmlFirmado.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
      const soap = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getToken><pszXml>${xmlEsc}</pszXml></getToken></soapenv:Body></soapenv:Envelope>`;
      res.setHeader("Content-Type","text/plain");
      return res.send(soap);
    }

    const token = await getToken(xmlFirmado);

    if (action === "debug_rcv") {
      const [anio2, mesNum2] = mes.split("-");
      const [rutNum2, dv2] = cfg.rut.split("-");
      const periodo2 = `${anio2}${mesNum2.padStart(2,"0")}`;
      const url2 = "https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleVentaExport";
      const body2 = JSON.stringify({ metaData: { conversationId: token, transactionId: "0", namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleVentaExport", page: null }, data: { rutEmisor: rutNum2, dvEmisor: dv2, ptributario: periodo2, operacion: "VENTA", estadoContab: "REGISTRO", codTipoDoc: "33", accionRecaptcha: "RCV_DDETV", tokenRecaptcha: "c3" } });
      const r2 = await fetch(url2, { method:"POST", headers:{"Cookie":`TOKEN=${token}`,"Content-Type":"application/json; charset=utf-8","User-Agent":"Mozilla/5.0"}, body: body2 });
      return res.json({ ok: true, status: r2.status, raw: (await r2.text()).slice(0,2000) });
    }

    if (action === "token") return res.json({ ok: true, empresa, token: token.slice(0,15)+"...", mensaje: "✓ Autenticación SII exitosa" });

    const [anio, mesNum] = mes.split("-");
    const registros = await getRCV(token, cfg.rut, anio, mesNum.padStart(2,"0"));
    return res.json({ ok: true, empresa, rut: cfg.rut, mes, total: registros.length, registros });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

function extractFromPfx(pfxBuf, password) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary")));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const privateKeyForge = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  if (!privateKeyForge) throw new Error("No se encontró clave privada en el PFX");
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificate = certBags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!certificate) throw new Error("No se encontró certificado en el PFX");
  return { privateKeyPem: forge.pki.privateKeyToPem(privateKeyForge), certificatePem: forge.pki.certificateToPem(certificate) };
}

async function getSemilla() {
  const r = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getSeed/></soapenv:Body></soapenv:Envelope>` });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getSeedReturn[^>]*>([\s\S]+?)<\/getSeedReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const m = xml.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) throw new Error("No se pudo obtener semilla: " + text.slice(0,200));
  return m[1];
}

function firmarSemilla(semilla, privateKeyPem, certificatePem) {
  const xmlDoc = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
  const certClean = certificatePem.replace("-----BEGIN CERTIFICATE-----","").replace("-----END CERTIFICATE-----","").replace(/\r?\n/g,"").trim();
  const sig = new SignedXml({ privateKey: privateKeyPem, publicCert: certificatePem, signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1", canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315" });
  sig.addReference({ xpath: "/*", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"], digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1" });
  sig.computeSignature(xmlDoc, { location: { reference: "/getToken", action: "append" }, existingPrefixes: { ds: "http://www.w3.org/2000/09/xmldsig#" } });
  let signed = sig.getSignedXml();
  signed = signed.replace(/<KeyInfo>[\s\S]*?<\/KeyInfo>/, `<KeyInfo><X509Data><X509Certificate>${certClean}</X509Certificate></X509Data></KeyInfo>`);
  return `<?xml version="1.0" encoding="UTF-8"?>${signed}`;
}

async function getToken(xmlFirmado) {
  const xmlEsc = xmlFirmado.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const soap = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getToken><pszXml>${xmlEsc}</pszXml></getToken></soapenv:Body></soapenv:Envelope>`;
  const r = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: soap });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getTokenReturn[^>]*>([\s\S]+?)<\/getTokenReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const estado = xml.match(/<ESTADO>([^<]+)<\/ESTADO>/)?.[1];
  if (estado && estado !== "00") { const glosa = xml.match(/<GLOSA>([^<]+)<\/GLOSA>/)?.[1] || "Sin descripción"; throw new Error(`SII error ${estado}: ${glosa}`); }
  const m = xml.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) throw new Error("Token no encontrado: " + xml.slice(0,300));
  return m[1];
}

async function getRCV(token, rut, anio, mes) {
  const [rutNum, dv] = rut.split("-");
  const periodo = `${anio}${mes}`;
  const url = "https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleVentaExport";
  const body = JSON.stringify({ metaData: { conversationId: token, transactionId: "0", namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleVentaExport", page: null }, data: { rutEmisor: rutNum, dvEmisor: dv, ptributario: periodo, operacion: "VENTA", estadoContab: "REGISTRO", codTipoDoc: "33", accionRecaptcha: "RCV_DDETV", tokenRecaptcha: "c3" } });
  const r = await fetch(url, { method: "POST", headers: { "Cookie": `TOKEN=${token}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0", "Referer": "https://www4.sii.cl/consdcvinternetui/", "Origin": "https://www4.sii.cl" }, body });
  if (!r.ok) throw new Error(`RCV HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);
  const data = await r.json();
  const csvLines = Array.isArray(data?.data) ? data.data : [];
  if (!csvLines.length) return [];
  const header = csvLines[0].split(";");
  const col = name => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
  const iRut=col("rut cliente"), iRazon=col("razon social"), iFolio=col("folio"), iFecha=col("fecha docto"), iNeto=col("monto neto"), iTotal=col("monto total");
  return csvLines.slice(1).map(line => {
    const c = line.split(";");
    const g = (i, fb) => (c[i >= 0 ? i : fb] || "").trim();
    return { folio: g(iFolio,4), tipo: "33", rut: g(iRut,2), razon: g(iRazon,3), fecha: g(iFecha,5).split(" ")[0], neto: parseInt(g(iNeto,10))||0, total: parseInt(g(iTotal,12))||0 };
  }).filter(r => r.folio);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  const service = req.query.service || "odoo";
  if (service === "sii") return handleSii(req, res);
  return handleOdoo(req, res);
}
