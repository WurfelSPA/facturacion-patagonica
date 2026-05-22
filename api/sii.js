// /api/sii.js
// Autenticación SII via certificado .pfx + descarga RCV ventas
// Usa node-forge para parsear PFX sin depender del binario openssl

import crypto from "crypto";
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
      return res.json({ ok: true, empresa, rut: cfg.rut, certBytes: certBuf.length, mensaje: "Certificado cargado OK" });
    }

    // ── 1. Extraer clave privada y certificado del PFX con forge ──
    const { privateKeyPem, certificatePem, certDerB64 } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      const cert = forge.pki.certificateFromPem(certificatePem);
      return res.json({
        ok: true,
        subject: cert.subject.getField("CN")?.value || "N/A",
        issuer:  cert.issuer.getField("CN")?.value  || "N/A",
        validTo: cert.validity.notAfter,
        keyType: "RSA",
      });
    }

    // ── 2. Obtener semilla del SII ──
    const semilla = await getSemilla();

    // ── 3. Firmar semilla ──
    const xmlFirmado = firmarSemilla(semilla, privateKeyPem, certDerB64);

    // ── 4. Obtener token ──
    const token = await getToken(xmlFirmado);

    if (action === "token") {
      return res.json({ ok: true, empresa, rut: cfg.rut, token: token.slice(0,15)+"...", mensaje: "Autenticación SII exitosa ✓" });
    }

    // ── 5. Descargar RCV ventas tipo 33 ──
    const [anio, mesNum] = mes.split("-");
    const registros = await getRCV(token, cfg.rut, anio, mesNum.padStart(2,"0"));

    return res.json({ ok: true, empresa, rut: cfg.rut, mes, total: registros.length, registros });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

/* ── Parsear PFX con node-forge ── */
function extractFromPfx(pfxBuf, password) {
  const p12Der  = forge.util.createBuffer(pfxBuf.toString("binary"));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  // Extraer clave privada
  const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag   = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag) throw new Error("No se encontró clave privada en el PFX");
  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);

  // Extraer certificado
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag  = certBags[forge.pki.oids.certBag]?.[0];
  if (!certBag) throw new Error("No se encontró certificado en el PFX");
  const certificatePem = forge.pki.certificateToPem(certBag.cert);

  // Certificado en DER base64 (para el XML de firma)
  const certDer    = forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert));
  const certDerB64 = Buffer.from(certDer.getBytes(), "binary").toString("base64");

  return { privateKeyPem, certificatePem, certDerB64 };
}

/* ── Obtener semilla del SII ── */
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
  // La semilla puede venir directa o dentro de XML escapado en getSeedReturn
  let m = text.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) m = text.match(/SEMILLA&gt;(\d+)&lt;\/SEMILLA/);
  if (!m) {
    // Intentar decodificar el XML escapado dentro de getSeedReturn
    const inner = text.match(/getSeedReturn[^>]*>([\s\S]+?)<\/getSeedReturn/);
    if (inner) {
      const decoded = inner[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
      m = decoded.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
    }
  }
  if (!m) throw new Error("No se pudo obtener semilla SII: " + text.slice(0, 400));
  return m[1];
}

/* ── Firmar XML de semilla ── */
function firmarSemilla(semilla, privateKeyPem, certDerB64) {
  const xmlBody    = `<item><Semilla>${semilla}</Semilla></item>`;
  const xmlContent = `<getToken>${xmlBody}</getToken>`;

  // DigestValue SHA1
  const digest = crypto.createHash("sha1").update(xmlContent, "utf8").digest("base64");

  const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI=""><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

  // Firma RSA-SHA1
  const signer = crypto.createSign("RSA-SHA1");
  signer.update(signedInfo, "utf8");
  const sigValue = signer.sign(privateKeyPem, "base64");

  return `<?xml version="1.0" encoding="UTF-8"?>
<getToken>
  ${xmlBody}
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    ${signedInfo}
    <SignatureValue>${sigValue}</SignatureValue>
    <KeyInfo>
      <X509Data>
        <X509Certificate>${certDerB64}</X509Certificate>
      </X509Data>
    </KeyInfo>
  </Signature>
</getToken>`;
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
  const m = text.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) {
    const err = text.match(/<DESCRIPCION>([^<]+)<\/DESCRIPCION>/);
    throw new Error("Token SII fallido: " + (err?.[1] || text.slice(0, 300)));
  }
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
    return { folio:g(iF,5), tipo:g(iT,1), rut:g(iR,3), razon:g(iRz,4), fecha:g(iFch,6), neto:parseInt(g(iN,11))||0, total:parseInt(g(iTot,13))||0 };
  }).filter(r => r.folio);
}
