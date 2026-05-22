// /api/sii.js
// Autenticación SII via certificado digital (.pfx) + descarga RCV ventas
// Uso: GET /api/sii?empresa=dko&mes=2026-05
//      GET /api/sii?empresa=dko&action=test
//      GET /api/sii?empresa=dko&action=token  (prueba autenticación completa)

import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

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
    return res.status(500).json({ error: "Faltan variables SII_CERT o SII_CERT_PASS en Vercel" });
  }

  try {
    const certBuf = Buffer.from(certB64, "base64");

    if (action === "test") {
      return res.json({ ok: true, empresa, rut: cfg.rut, certBytes: certBuf.length, mensaje: "Certificado cargado correctamente" });
    }

    // ── 1. Extraer clave privada y certificado del PFX ──
    const { privateKey, certificate } = extractFromPfx(certBuf, certPass);

    if (action === "cert") {
      return res.json({ ok: true, certLines: certificate.split("\n").length, keyLines: privateKey.split("\n").length });
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
    return res.status(500).json({ error: e.message, detail: e.stderr?.toString().slice(0,300) || e.stack?.slice(0,300) });
  }
}

/* ── Extraer PEM desde PFX usando openssl ── */
function extractFromPfx(pfxBuf, password) {
  const tmpDir = os.tmpdir();
  const pfxPath = path.join(tmpDir, `sii_${Date.now()}.pfx`);
  const keyPath = path.join(tmpDir, `sii_${Date.now()}_key.pem`);
  const crtPath = path.join(tmpDir, `sii_${Date.now()}_crt.pem`);

  try {
    fs.writeFileSync(pfxPath, pfxBuf);

    execFileSync("openssl", [
      "pkcs12", "-in", pfxPath, "-nocerts", "-nodes",
      "-out", keyPath, "-password", `pass:${password}`, "-legacy"
    ]);

    execFileSync("openssl", [
      "pkcs12", "-in", pfxPath, "-nokeys", "-clcerts",
      "-out", crtPath, "-password", `pass:${password}`, "-legacy"
    ]);

    const privateKey  = fs.readFileSync(keyPath, "utf8");
    const certificate = fs.readFileSync(crtPath, "utf8");

    return { privateKey, certificate };
  } finally {
    try { fs.unlinkSync(pfxPath); } catch(e) {}
    try { fs.unlinkSync(keyPath); } catch(e) {}
    try { fs.unlinkSync(crtPath); } catch(e) {}
  }
}

/* ── Obtener semilla del SII ── */
async function getSemilla() {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><getSeed/></soapenv:Body>
</soapenv:Envelope>`;

  const r = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body,
  });
  const text = await r.text();
  const m = text.match(/<SEMILLA>(\d+)<\/SEMILLA>/);
  if (!m) throw new Error("No se pudo obtener semilla SII: " + text.slice(0,300));
  return m[1];
}

/* ── Firmar XML de semilla ── */
function firmarSemilla(semilla, privateKey, certPem) {
  const xmlBody = `<item><Semilla>${semilla}</Semilla></item>`;

  // DigestValue del contenido
  const digest = crypto.createHash("sha1")
    .update(`<getToken>${xmlBody}</getToken>`, "utf8")
    .digest("base64");

  const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI=""><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

  const sign = crypto.createSign("RSA-SHA1");
  sign.update(signedInfo, "utf8");
  const sigValue = sign.sign(privateKey, "base64");

  const certClean = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\n/g, "").trim();

  return `<?xml version="1.0" encoding="UTF-8"?>
<getToken>
  ${xmlBody}
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    ${signedInfo}
    <SignatureValue>${sigValue}</SignatureValue>
    <KeyInfo><X509Data><X509Certificate>${certClean}</X509Certificate></X509Data></KeyInfo>
  </Signature>
</getToken>`;
}

/* ── Obtener token SII ── */
async function getToken(xmlFirmado) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getToken>
      <pszXml><![CDATA[${xmlFirmado}]]></pszXml>
    </getToken>
  </soapenv:Body>
</soapenv:Envelope>`;

  const r = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body,
  });
  const text = await r.text();
  const m = text.match(/<TOKEN>([^<]+)<\/TOKEN>/);
  if (!m) {
    const err = text.match(/<DESCRIPCION>([^<]+)<\/DESCRIPCION>/);
    throw new Error("Token SII fallido: " + (err?.[1] || text.slice(0,300)));
  }
  return m[1];
}

/* ── Descargar RCV ventas tipo 33 ── */
async function getRCV(token, rut, anio, mes) {
  const [rutNum, dv] = rut.split("-");
  const periodo = `${anio}${mes}`;

  // Endpoint RCV del SII
  const url = `https://palena.sii.cl/cgi_dte/UPL/DTEUpload`;
  const params = new URLSearchParams({
    rutEmisor: rutNum,
    dvEmisor:  dv,
    periodo,
    tipoDoc:   "33",
    tipo:      "VENTA",
  });

  const r = await fetch(`${url}?${params}`, {
    headers: {
      "Cookie":     `TOKEN=${token}`,
      "User-Agent": "Mozilla/5.0 (compatible; Patagonica/1.0)",
      "Accept":     "text/plain,application/csv,*/*",
    },
  });

  if (!r.ok) throw new Error(`RCV HTTP ${r.status}: ${await r.text().then(t=>t.slice(0,200))}`);

  const text = await r.text();

  // Parsear CSV semicolon-delimited
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];

  // Primera línea = encabezados
  const header = lines[0].split(";").map(h => h.trim());
  const iF = header.indexOf("Folio");
  const iT = header.indexOf("Tipo Doc");
  const iR = header.indexOf("Rut cliente");
  const iRz = header.indexOf("Razon Social");
  const iFch = header.indexOf("Fecha Docto");
  const iN = header.indexOf("Monto Neto");
  const iTot = header.indexOf("Monto total");

  return lines.slice(1).map(line => {
    const c = line.split(";");
    return {
      folio:   (c[iF >= 0 ? iF : 5]   || "").trim(),
      tipo:    (c[iT >= 0 ? iT : 1]   || "").trim(),
      rut:     (c[iR >= 0 ? iR : 3]   || "").trim(),
      razon:   (c[iRz >= 0 ? iRz : 4] || "").trim(),
      fecha:   (c[iFch >= 0 ? iFch : 6] || "").trim(),
      neto:    parseInt((c[iN >= 0 ? iN : 11]   || "0").trim()) || 0,
      total:   parseInt((c[iTot >= 0 ? iTot : 13] || "0").trim()) || 0,
    };
  }).filter(r => r.folio);
}
