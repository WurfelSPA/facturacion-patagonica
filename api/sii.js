// /api/sii.js
// Autenticación SII via certificado digital (.pfx) + descarga RCV ventas
// Implementación correcta de XMLDSig según spec SII Chile

import crypto from "crypto";
import forge from "node-forge";

const RUT_MAP = {
  dko:   { rut: "77454587-5",  razon: "Sánchez Hermanos",        certEnv: "SII_CERT_DKO",   passEnv: "SII_CERT_PASS_DKO" },
  multi: { rut: "77538786-6",  razon: "Distribuidora Sánchez 4G", certEnv: "SII_CERT_MULTI", passEnv: "SII_CERT_PASS_MULTI" },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { empresa = "dko", mes = "2026-05", action } = req.query;

  const cfg = RUT_MAP[empresa];
  if (!cfg) return res.status(400).json({ error: "Empresa desconocida. Usa: dko | multi" });

  const certB64 = process.env[cfg.certEnv] || process.env.SII_CERT;
  const certPass = process.env[cfg.passEnv] || process.env.SII_CERT_PASS;
  if (!certB64 || !certPass) {
    return res.status(500).json({ error: `Faltan variables ${cfg.certEnv} o ${cfg.passEnv}` });
  }

  try {
    const certBuf = Buffer.from(certB64, "base64");

    if (action === "test") {
      return res.json({ ok: true, empresa, rut: cfg.rut, certBytes: certBuf.length });
    }

    // Extraer clave privada y certificado del PFX
    const { privateKey, certificate, certDerB64 } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      const subject = certificate.subject.getField("CN")?.value || "N/A";
      const issuer  = certificate.issuer.getField("CN")?.value  || "N/A";
      return res.json({ ok: true, subject, issuer, validTo: certificate.validity.notAfter });
    }

    // Obtener semilla
    const semilla = await getSemilla();

    if (action === "debug") {
      const xmlFirmado = firmarSemilla(semilla, privateKey, certificate, certDerB64);
      return res.json({ ok: true, semilla, xmlFirmado });
    }

    // Construir y firmar XML con node-forge (firma XMLDSig correcta)
    const xmlFirmado = firmarSemilla(semilla, privateKey, certificate, certDerB64);

    // Obtener token
    const token = await getToken(xmlFirmado);

    if (action === "token") {
      return res.json({ ok: true, empresa, rut: cfg.rut, token: token.slice(0,15)+"...", mensaje: "Autenticación SII exitosa ✓" });
    }

    // Descargar RCV
    const [anio, mesNum] = mes.split("-");
    const registros = await getRCV(token, cfg.rut, anio, mesNum.padStart(2,"0"));
    return res.json({ ok: true, empresa, rut: cfg.rut, mes, total: registros.length, registros });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 500) });
  }
}

/* ── Extraer desde PFX con node-forge ── */
function extractFromPfx(pfxBuf, password) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary")));
  const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  if (!privateKey) throw new Error("No se encontró clave privada en el PFX");

  const certBags   = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificate = certBags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!certificate) throw new Error("No se encontró certificado en el PFX");

  // Certificado en DER base64
  const certDer    = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate));
  const certDerB64 = Buffer.from(certDer.getBytes(), "binary").toString("base64");

  return { privateKey, certificate, certDerB64 };
}

/* ── Obtener semilla SII ── */
async function getSemilla() {
  const r = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><getSeed/></soapenv:Body>
</soapenv:Envelope>`,
  });
  const text = await r.text();

  // Decodificar XML escapado dentro de getSeedReturn
  let xml = text;
  const inner = text.match(/getSeedReturn[^>]*>([\s\S]+?)<\/getSeedReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");

  const m = xml.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) throw new Error("No se pudo obtener semilla SII: " + text.slice(0, 300));
  return m[1];
}

/* ── Firmar semilla con XMLDSig usando node-forge ── */
function firmarSemilla(semilla, privateKey, certificate, certDerB64) {
  // Contenido a firmar (sin declaración XML para el digest)
  const xmlContent = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;

  // Extraer módulo y exponente RSA del certificado para RSAKeyValue
  const pubKey = certificate.publicKey;
  const nBytes = pubKey.n.toByteArray();
  const eBytes = pubKey.e.toByteArray();
  // Remover byte 0x00 de padding si existe
  const nClean = nBytes[0] === 0 ? nBytes.slice(1) : nBytes;
  const modulusB64  = Buffer.from(nClean.map(b => b < 0 ? b + 256 : b)).toString("base64");
  const exponentB64 = Buffer.from(eBytes.map(b => b < 0 ? b + 256 : b)).toString("base64");

  // 1. DigestValue: SHA1 del contenido XML (sin declaración XML)
  const md = forge.md.sha1.create();
  md.update(xmlContent, "utf8");
  const digestB64 = forge.util.encode64(md.digest().bytes());

  // 2. Construir SignedInfo (debe ser exactamente así para canonicalización)
  const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI=""><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digestB64}</DigestValue></Reference></SignedInfo>`;

  // 3. Firmar SignedInfo con RSA-SHA1 usando node-forge
  const mdSig = forge.md.sha1.create();
  mdSig.update(signedInfo, "utf8");
  const signatureBytes = privateKey.sign(mdSig);
  const signatureB64   = forge.util.encode64(signatureBytes);

  // Estructura exacta según manual SII OI2007_AUTAUTOM_MDE_1.9
  return `<?xml version="1.0" encoding="UTF-8"?><getToken><item><Semilla>${semilla}</Semilla></item><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digestB64}</DigestValue></Reference></SignedInfo><SignatureValue>${signatureB64}</SignatureValue><KeyInfo><KeyValue><RSAKeyValue><Modulus>${modulusB64}</Modulus><Exponent>${exponentB64}</Exponent></RSAKeyValue></KeyValue><X509Data><X509Certificate>${certDerB64}</X509Certificate></X509Data></KeyInfo></Signature></getToken>`;
}

/* ── Obtener token SII ── */
async function getToken(xmlFirmado) {
  const r = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getToken>
      <pszXml><![CDATA[${xmlFirmado}]]></pszXml>
    </getToken>
  </soapenv:Body>
</soapenv:Envelope>`,
  });
  const text = await r.text();

  // Decodificar XML escapado
  let xml = text;
  const inner = text.match(/getTokenReturn[^>]*>([\s\S]+?)<\/getTokenReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");

  // Verificar estado
  const estado = xml.match(/<ESTADO>([^<]+)<\/ESTADO>/)?.[1];
  if (estado && estado !== "00") {
    const desc = xml.match(/<DESCRIPCION>([^<]+)<\/DESCRIPCION>/)?.[1] || "Sin descripción";
    throw new Error(`Token SII error ${estado}: ${desc}`);
  }

  const m = xml.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) throw new Error("Token SII fallido: " + xml.slice(0, 400));
  return m[1];
}

/* ── Descargar RCV ventas tipo 33 ── */
async function getRCV(token, rut, anio, mes) {
  const [rutNum, dv] = rut.split("-");
  const params = new URLSearchParams({
    rutEmisor: rutNum,
    dvEmisor:  dv,
    periodo:   `${anio}${mes}`,
    tipoDoc:   "33",
    tipo:      "VENTA",
  });

  const r = await fetch(`https://palena.sii.cl/cgi_dte/UPL/DTEUpload?${params}`, {
    headers: {
      "Cookie":     `TOKEN=${token}`,
      "User-Agent": "Mozilla/5.0 (compatible; Patagonica/1.0)",
    },
  });

  if (!r.ok) throw new Error(`RCV HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];

  const header = lines[0].split(";").map(h => h.trim());
  const col = name => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
  const iF=col("folio"), iT=col("tipo"), iR=col("rut"), iRz=col("razon");
  const iFch=col("fecha"), iN=col("neto"), iTot=col("total");

  return lines.slice(1).map(line => {
    const c = line.split(";");
    const g = (i, fb) => (c[i >= 0 ? i : fb] || "").trim();
    return {
      folio: g(iF,5), tipo: g(iT,1), rut: g(iR,3),
      razon: g(iRz,4), fecha: g(iFch,6),
      neto:  parseInt(g(iN,11))  || 0,
      total: parseInt(g(iTot,13)) || 0,
    };
  }).filter(r => r.folio);
}
