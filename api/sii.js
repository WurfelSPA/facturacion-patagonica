// /api/sii.js
// Autenticación SII via certificado digital (.pfx) + descarga RCV ventas

import forge from "node-forge";

const RUT_MAP = {
  dko:   { rut: "77454587-5",  razon: "Sánchez Hermanos" },
  multi: { rut: "77538786-6",  razon: "Distribuidora Sánchez 4G" },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { empresa = "dko", mes = "2026-05", action } = req.query;

  const cfg = RUT_MAP[empresa];
  if (!cfg) return res.status(400).json({ error: "Empresa desconocida. Usa: dko | multi" });

  const certB64 = process.env.SII_CERT;
  const certPass = process.env.SII_CERT_PASS;
  if (!certB64 || !certPass) {
    return res.status(500).json({ error: "Faltan variables SII_CERT o SII_CERT_PASS" });
  }

  try {
    const certBuf = Buffer.from(certB64, "base64");

    if (action === "test") {
      return res.json({ ok: true, empresa, rut: cfg.rut, certBytes: certBuf.length });
    }

    const { privateKey, certificate, certDerB64 } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      return res.json({
        ok: true,
        subject: certificate.subject.getField("CN")?.value,
        issuer:  certificate.issuer.getField("CN")?.value,
        validTo: certificate.validity.notAfter,
      });
    }

    const semilla = await getSemilla();
    const xmlFirmado = firmarSemilla(semilla, privateKey, certDerB64);

    if (action === "debug") {
      return res.json({ ok: true, semilla, xmlFirmado });
    }

    const token = await getToken(xmlFirmado);

    if (action === "token") {
      return res.json({ ok: true, empresa, rut: cfg.rut, token: token.slice(0,15)+"...", mensaje: "✓ Autenticación SII exitosa" });
    }

    const [anio, mesNum] = mes.split("-");
    const registros = await getRCV(token, cfg.rut, anio, mesNum.padStart(2,"0"));
    return res.json({ ok: true, empresa, rut: cfg.rut, mes, total: registros.length, registros });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 500) });
  }
}

function extractFromPfx(pfxBuf, password) {
  const p12Asn1  = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary")));
  const p12      = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  if (!privateKey) throw new Error("No se encontró clave privada en el PFX");

  const certBags   = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificate = certBags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!certificate) throw new Error("No se encontró certificado en el PFX");

  const certDer    = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate));
  // Sin saltos de línea — el SII requiere base64 en una sola línea
  const certDerB64 = Buffer.from(certDer.getBytes(), "binary").toString("base64").replace(/\n/g,"").replace(/\r/g,"");

  return { privateKey, certificate, certDerB64 };
}

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

function firmarSemilla(semilla, privateKey, certDerB64) {
  // El documento a firmar (sin Signature dentro — enveloped signature)
  const docToSign = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;

  // DigestValue = SHA1 del documento SIN la firma (c14n = mismo string para doc simple)
  const mdDoc = forge.md.sha1.create();
  mdDoc.update(docToSign, "utf8");
  const digestB64 = forge.util.encode64(mdDoc.digest().bytes());

  // SignedInfo — exactamente lo que se firmará
  const signedInfoXml = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">`
    + `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>`
    + `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>`
    + `<Reference URI="">`
    + `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>`
    + `<DigestValue>${digestB64}</DigestValue>`
    + `</Reference>`
    + `</SignedInfo>`;

  // Firma RSA-SHA1 sobre el SignedInfo
  const mdSig = forge.md.sha1.create();
  mdSig.update(signedInfoXml, "utf8");
  const sigB64 = forge.util.encode64(privateKey.sign(mdSig));

  // XML final con Signature enveloped
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<getToken>`
    + `<item><Semilla>${semilla}</Semilla></item>`
    + `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">`
    + signedInfoXml
    + `<SignatureValue>${sigB64}</SignatureValue>`
    + `<KeyInfo>`
    + `<X509Data><X509Certificate>${certDerB64}</X509Certificate></X509Data>`
    + `</KeyInfo>`
    + `</Signature>`
    + `</getToken>`;
}

async function getToken(xmlFirmado) {
  const r = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body: `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><getToken><pszXml><![CDATA[${xmlFirmado}]]></pszXml></getToken></soapenv:Body></soapenv:Envelope>`,
  });
  const text = await r.text();
  let xml = text;
  const inner = text.match(/getTokenReturn[^>]*>([\s\S]+?)<\/getTokenReturn/);
  if (inner) xml = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");

  const estado = xml.match(/<ESTADO>([^<]+)<\/ESTADO>/)?.[1];
  if (estado && estado !== "00") {
    const desc = xml.match(/<DESCRIPCION>([^<]+)<\/DESCRIPCION>/)?.[1] || "Sin descripción";
    throw new Error(`Token SII error ${estado}: ${desc} | GLOSA: ${xml.match(/<GLOSA>([^<]+)<\/GLOSA>/)?.[1]||""} | XML: ${xml.slice(0,500)}`);
  }
  const m = xml.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) throw new Error("Token no encontrado: " + xml.slice(0,300));
  return m[1];
}

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
