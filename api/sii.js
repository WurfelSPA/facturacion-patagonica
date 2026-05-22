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
    transforms: [],
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

/* ── Descargar RCV ventas tipo 33 ── */
async function getRCV(token, rut, anio, mes) {
  const [rutNum, dv] = rut.split("-");
  const params = new URLSearchParams({ rutEmisor:rutNum, dvEmisor:dv, periodo:`${anio}${mes}`, tipoDoc:"33", tipo:"VENTA" });
  const r = await fetch(`https://palena.sii.cl/cgi_dte/UPL/DTEUpload?${params}`, {
    headers: { "Cookie":`TOKEN=${token}`, "User-Agent":"Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`RCV HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const text = await r.text();
  const lines = text.split(/\r?\n/).filter(l=>l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(";").map(h=>h.trim());
  const col = name => header.findIndex(h=>h.toLowerCase().includes(name.toLowerCase()));
  const iF=col("folio"),iT=col("tipo"),iR=col("rut"),iRz=col("razon"),iFch=col("fecha"),iN=col("neto"),iTot=col("total");
  return lines.slice(1).map(line=>{
    const c=line.split(";");
    const g=(i,fb)=>(c[i>=0?i:fb]||"").trim();
    return { folio:g(iF,5),tipo:g(iT,1),rut:g(iR,3),razon:g(iRz,4),fecha:g(iFch,6),neto:parseInt(g(iN,11))||0,total:parseInt(g(iTot,13))||0 };
  }).filter(r=>r.folio);
}
