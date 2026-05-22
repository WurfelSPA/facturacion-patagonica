// /api/sii.js
// Autenticación SII via certificado digital (.pfx) + descarga RCV ventas
// Usa Node.js crypto nativo (sin binario openssl)

import crypto from "crypto";

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

    // ── 1. Extraer clave privada y certificado del PFX usando Node crypto ──
    const { privateKey, certificate } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      return res.json({ ok: true, keyType: privateKey.asymmetricKeyType, certSubject: certificate.subject });
    }

    // ── 2. Obtener semilla del SII ──
    const semilla = await getSemilla();

    // ── 3. Firmar semilla ──
    const xmlFirmado = firmarSemilla(semilla, privateKey, certificate);

    // ── 4. Obtener token ──
    const token = await getToken(xmlFirmado);

    if (action === "token") {
      return res.json({ ok: true, empresa, rut: cfg.rut, token: token.slice(0,15)+"...", mensaje: "Autenticación SII exitosa" });
    }

    // ── 5. Descargar RCV ventas tipo 33 ──
    const [anio, mesNum] = mes.split("-");
    const registros = await getRCV(token, cfg.rut, anio, mesNum.padStart(2,"0"));

    return res.json({ ok: true, empresa, rut: cfg.rut, mes, total: registros.length, registros });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

/* ── Extraer clave privada y cert del PFX usando Node.js nativo ── */
function extractFromPfx(pfxBuf, password) {
  // Node.js 15+ soporta X509Certificate y createPrivateKey con PFX
  const privateKey = crypto.createPrivateKey({
    key: pfxBuf,
    format: "der",
    type: "pkcs12",
    passphrase: password,
  });

  const cert = new crypto.X509Certificate(
    crypto.createPublicKey({ key: pfxBuf, format: "der", type: "pkcs12", passphrase: password })
      .export({ type: "pkcs1", format: "der" })
  );

  return { privateKey, certificate: cert };
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
  const m = text.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) throw new Error("No se pudo obtener semilla SII: " + text.slice(0, 300));
  return m[1];
}

/* ── Firmar XML de semilla con clave privada ── */
function firmarSemilla(semilla, privateKey, certObj) {
  const xmlBody = `<item><Semilla>${semilla}</Semilla></item>`;
  const xmlCompleto = `<getToken>${xmlBody}</getToken>`;

  // DigestValue SHA1 del contenido
  const digest = crypto.createHash("sha1").update(xmlCompleto, "utf8").digest("base64");

  const signedInfo = [
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">`,
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>`,
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>`,
    `<Reference URI="">`,
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>`,
    `<DigestValue>${digest}</DigestValue>`,
    `</Reference>`,
    `</SignedInfo>`,
  ].join("");

  // Firmar SignedInfo
  const sign = crypto.createSign("RSA-SHA1");
  sign.update(signedInfo, "utf8");
  const sigValue = sign.sign(privateKey, "base64");

  // Exportar certificado en DER → base64
  const certDer = certObj.raw
    ? certObj.raw.toString("base64")
    : Buffer.from(certObj.export({ type: "spki", format: "der" })).toString("base64");

  return `<?xml version="1.0" encoding="UTF-8"?>
<getToken>
  ${xmlBody}
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    ${signedInfo}
    <SignatureValue>${sigValue}</SignatureValue>
    <KeyInfo>
      <X509Data>
        <X509Certificate>${certDer}</X509Certificate>
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

  const iF   = col("folio");
  const iT   = col("tipo");
  const iR   = col("rut");
  const iRz  = col("razon");
  const iFch = col("fecha");
  const iN   = col("neto");
  const iTot = col("total");

  return lines.slice(1).map(line => {
    const c = line.split(";");
    const get = (i, fb) => (c[i >= 0 ? i : fb] || "").trim();
    return {
      folio: get(iF, 5),
      tipo:  get(iT, 1),
      rut:   get(iR, 3),
      razon: get(iRz, 4),
      fecha: get(iFch, 6),
      neto:  parseInt(get(iN, 11))  || 0,
      total: parseInt(get(iTot, 13)) || 0,
    };
  }).filter(r => r.folio);
}
