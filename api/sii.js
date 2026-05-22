// /api/sii.js
// Autenticación SII via certificado digital (.pfx) + descarga RCV ventas
// Usa xml-crypto para firma XMLDSig correcta

import forge from "node-forge";
import { SignedXml } from "xml-crypto";

const RUT_MAP = {
  dko:   { rut: "77454587-5", certEnv: "SII_CERT_DKO",   passEnv: "SII_CERT_PASS_DKO" },
  multi: { rut: "77538786-6", certEnv: "SII_CERT_MULTI",  passEnv: "SII_CERT_PASS_MULTI" },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

    if (action === "test") {
      return res.json({ ok: true, empresa, certBytes: certBuf.length });
    }

    const { privateKeyPem, certificatePem } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      const cert = forge.pki.certificateFromPem(certificatePem);
      return res.json({
        ok: true,
        subject: cert.subject.getField("CN")?.value,
        issuer:  cert.issuer.getField("CN")?.value,
        validTo: cert.validity.notAfter,
      });
    }

    const semilla = await getSemilla();
    const xmlFirmado = firmarSemilla(semilla, privateKeyPem, certificatePem);

    if (action === "debug") {
      return res.json({ ok: true, semilla, xmlFirmado });
    }

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
      const body2 = JSON.stringify({
        metaData: { conversationId: token, transactionId: "0", namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleVentaExport", page: null },
        data: { rutEmisor: rutNum2, dvEmisor: dv2, ptributario: periodo2, operacion: "VENTA", estadoContab: "REGISTRO", codTipoDoc: "33", accionRecaptcha: "RCV_DETC", tokenRecaptcha: "c3" }
      });
      const r2 = await fetch(url2, { method:"POST", headers:{"Cookie":`TOKEN=${token}`,"Content-Type":"application/json; charset=utf-8","User-Agent":"Mozilla/5.0"}, body: body2 });
      const status2 = r2.status;
      const raw2 = await r2.text();
      return res.json({ ok: true, status: status2, raw: raw2.slice(0,2000) });
    }

    if (action === "token") {
      return res.json({ ok: true, empresa, token: token.slice(0,15)+"...", mensaje: "✓ Autenticación SII exitosa" });
    }

    const [anio, mesNum] = mes.split("-");
    const registros = await getRCV(token, cfg.rut, anio, mesNum.padStart(2,"0"));
    return res.json({ ok: true, empresa, rut: cfg.rut, mes, total: registros.length, registros });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

/* ── Extraer PEM desde PFX ── */
function extractFromPfx(pfxBuf, password) {
  const p12Asn1  = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary")));
  const p12      = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const privateKeyForge = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  if (!privateKeyForge) throw new Error("No se encontró clave privada en el PFX");

  const certBags   = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificate = certBags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!certificate) throw new Error("No se encontró certificado en el PFX");

  const privateKeyPem  = forge.pki.privateKeyToPem(privateKeyForge);
  const certificatePem = forge.pki.certificateToPem(certificate);

  return { privateKeyPem, certificatePem };
}

/* ── Obtener semilla ── */
async function getSemilla() {
  const r = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body: `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getSeed/></soapenv:Body></soapenv:Envelope>`,
  });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getSeedReturn[^>]*>([\s\S]+?)<\/getSeedReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const m = xml.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) throw new Error("No se pudo obtener semilla: " + text.slice(0,200));
  return m[1];
}

/* ── Firmar semilla con xml-crypto ── */
function firmarSemilla(semilla, privateKeyPem, certificatePem) {
  // Documento XML base (sin declaración XML)
  const xmlDoc = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;

  // Limpiar PEM del certificado para X509Certificate (sin cabeceras ni saltos)
  const certClean = certificatePem
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\r?\n/g, "")
    .trim();

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });

  sig.addReference({
    xpath: "/*",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
  });

  sig.computeSignature(xmlDoc, {
    location: { reference: "/getToken", action: "append" },
    existingPrefixes: { ds: "http://www.w3.org/2000/09/xmldsig#" },
  });

  // Reemplazar KeyInfo generado por xml-crypto con nuestro X509Certificate
  let signed = sig.getSignedXml();

  // xml-crypto genera KeyInfo con KeyValue — reemplazarlo por X509Data
  signed = signed.replace(
    /<KeyInfo>[\s\S]*?<\/KeyInfo>/,
    `<KeyInfo><X509Data><X509Certificate>${certClean}</X509Certificate></X509Data></KeyInfo>`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>${signed}`;
}

/* ── Obtener token ── */
async function getToken(xmlFirmado) {
  const xmlEsc = xmlFirmado
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const soap = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getToken><pszXml>${xmlEsc}</pszXml></getToken></soapenv:Body></soapenv:Envelope>`;

  const r = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body: soap,
  });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getTokenReturn[^>]*>([\s\S]+?)<\/getTokenReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");

  const estado = xml.match(/<ESTADO>([^<]+)<\/ESTADO>/)?.[1];
  if (estado && estado !== "00") {
    const glosa = xml.match(/<GLOSA>([^<]+)<\/GLOSA>/)?.[1] || "Sin descripción";
    throw new Error(`SII error ${estado}: ${glosa}`);
  }
  const m = xml.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) throw new Error("Token no encontrado: " + xml.slice(0,300));
  return m[1];
}

/* ── Descargar RCV ventas tipo 33 via API JSON SII ── */
async function getRCV(token, rut, anio, mes) {
  const [rutNum, dv] = rut.split("-");
  const periodo = `${anio}${mes}`;
  const url = "https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleVentaExport";

  const body = JSON.stringify({
    metaData: {
      conversationId: token,
      transactionId: "0",
      namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleVentaExport",
      page: null,
    },
    data: {
      rutEmisor: rutNum,
      dvEmisor: dv,
      ptributario: periodo,
      operacion: "VENTA",
      estadoContab: "REGISTRO",
      codTipoDoc: "33",
      accionRecaptcha: "RCV_DETC",
      tokenRecaptcha: "c3",
    }
  });

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Cookie": `TOKEN=${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://www4.sii.cl/consdcvinternetui/",
      "Origin": "https://www4.sii.cl",
    },
    body,
  });

  if (!r.ok) throw new Error(`RCV HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);
  const data = await r.json();

  // La respuesta tiene estructura { data: { detalleVentas: [...] } } o similar
  const registros = data?.data?.detalleVentas
    || data?.data?.listaVentas
    || data?.data?.registros
    || data?.registros
    || [];

  // Si viene en otro formato, retornar el data crudo para debug
  if (!Array.isArray(registros)) {
    return [{ debug: true, keys: Object.keys(data?.data || data || {}), raw: JSON.stringify(data).slice(0,500) }];
  }

  return registros.map(r => ({
    folio:  String(r.folio || r.nroDoc || r.numero || ""),
    tipo:   String(r.tipoDoc || r.tipoDte || "33"),
    rut:    String(r.rutDoc || r.rutReceptor || r.rut || ""),
    razon:  String(r.razonSocial || r.nombre || ""),
    fecha:  String(r.fechaDoc || r.fecha || ""),
    neto:   parseInt(r.montoNeto || r.neto || 0) || 0,
    total:  parseInt(r.montoTotal || r.monto || r.total || 0) || 0,
  })).filter(r => r.folio);
}
