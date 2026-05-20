import JSZip from "jszip";

export const config = { api: { bodyParser: true, responseLimit: '60mb' } };

// ── Misma lógica JWT/OAuth que pdftext.js ────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const pemContents = privateKey.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey.buffer, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${signingInput}.${sigB64}`;
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/drive",  // full drive (read + write)
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const jwt = await signJWT(payload, serviceAccount.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Drive: descargar archivo ──────────────────────────────────────────────────
async function driveDownload(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive download error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Drive: subir archivo (multipart) ─────────────────────────────────────────
async function driveUpload(token, name, dataBuffer, mimeType, parentId) {
  const meta = JSON.stringify({ name, mimeType, parents: parentId ? [parentId] : [] });
  const boundary = "pat_boundary_split_pdf";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(meta),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    dataBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      body,
    }
  );
  const data = await res.json();
  if (!data.id) throw new Error("Upload error: " + JSON.stringify(data));
  return data.id;
}

// ── Parsear CMap (mismo que pdftext.js) ──────────────────────────────────────
function parseCMap(cmapText) {
  const mapping = {};
  const rangeSection = cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
  for (const section of rangeSection) {
    const matches = section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const [, s, e, d] of matches) {
      const si = parseInt(s,16), ei = parseInt(e,16), di = parseInt(d,16);
      for (let i = 0; i <= ei-si; i++) mapping[si+i] = String.fromCodePoint(di+i);
    }
  }
  const charSection = cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
  for (const section of charSection) {
    const matches = section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const [, src, dst] of matches) {
      try {
        const code = parseInt(src, 16);
        const dstBytes = Buffer.from(dst, "hex");
        mapping[code] = "";
        for (let i = 0; i < dstBytes.length; i += 2)
          mapping[code] += String.fromCodePoint(dstBytes.readUInt16BE(i));
      } catch {}
    }
  }
  return mapping;
}

// ── Extraer texto de una página PDF (buffer de 1 página) ─────────────────────
function extractPageText(pdfBuffer) {
  const str = pdfBuffer.toString("latin1");
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  const streams = [];
  let m;
  while ((m = streamRegex.exec(str)) !== null)
    streams.push(Buffer.from(m[1], "latin1"));

  const mapping = {};
  for (const s of streams) {
    try {
      const d = require("zlib").inflateSync(s).toString("latin1");
      if (d.includes("beginbfchar") || d.includes("beginbfrange"))
        Object.assign(mapping, parseCMap(d));
    } catch {}
  }

  let text = "";
  for (const s of streams) {
    try {
      const d = require("zlib").inflateSync(s).toString("latin1");
      for (const [, h] of d.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
        const code = parseInt(h, 16);
        text += mapping[code] !== undefined ? mapping[code]
              : (code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
      }
    } catch {}
  }
  return text.replace(/\s+/g, " ").trim();
}

// ── Detectar COD en texto ────────────────────────────────────────────────────
const COD_MAP = {
  "5-A":"5A","5A":"5A",
  "4-A":"4A","4A":"4A",
  "A-1":"A1","A1":"A1",
  "A-2":"A2","A2":"A2",
  "B":"B",
  "D-2":"D2","D2":"D2",
  "D-3":"D3","D3":"D3",
};

function detectCod(text) {
  const m = text.match(/COD:\s*([A-D0-9][-A-D0-9]*)/);
  if (!m) return null;
  const raw = m[1].trim().replace(/-$/,"").toUpperCase();
  return COD_MAP[raw] || null;
}

function detectNro(text) {
  const m = text.match(/N[º°]\s*(\d+)/);
  return m ? m[1] : null;
}

// ── Extraer páginas individuales de un PDF como Buffers ──────────────────────
function splitPDFPages(pdfBuffer) {
  // Parsear el PDF manualmente para extraer páginas individuales
  // Usamos una estrategia simple: buscar objetos de página y reconstruir PDFs mínimos
  // Para Vercel sin pypdf, usamos la estructura del PDF directamente
  const str = pdfBuffer.toString("latin1");
  
  // Encontrar referencias a páginas en el árbol
  // Buscar "Page" objects en el xref
  const pageBuffers = [];
  
  // Estrategia: dividir en páginas usando qué objetos pertenecen a cada página
  // Más simple: usar el stream completo y separar por patrones de página
  // Para facturas de 1 página cada una, buscamos los objetos del PDF
  
  // Encontrar el array Kids en Pages
  const kidsMatch = str.match(/\/Kids\s*\[([^\]]+)\]/);
  if (!kidsMatch) return null;
  
  const kidRefs = [...kidsMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(m => parseInt(m[1]));
  
  // Para cada página, encontrar su objeto y reconstruir un PDF mínimo
  // Usar offset del xref para localizar objetos
  const xrefMatch = str.match(/xref\s*\n\s*0\s+(\d+)\s*\n([\s\S]*?)trailer/);
  
  if (!xrefMatch) {
    // PDF con xref cross-reference streams (PDF 1.5+) - no podemos parsear fácilmente
    return null;
  }
  
  return null; // Señal para usar método alternativo
}

// ── Separar PDF usando pdfseparate o método buffer ────────────────────────────
function splitByteRanges(pdfBuffer, totalPages) {
  // Método robusto: crear un PDF de 1 página usando referencias al original
  // Buscar startxref para encontrar objetos
  const str = pdfBuffer.toString("binary");
  
  // Encontrar todos los "obj" en el PDF
  const objPattern = /(\d+)\s+0\s+obj/g;
  const objects = {};
  let match;
  while ((match = objPattern.exec(str)) !== null) {
    objects[parseInt(match[1])] = match.index;
  }
  
  return objects;
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { pdfFileId, periodo, destFolderId } = req.body || {};
  if (!pdfFileId || !periodo) return res.status(400).json({ error: "Falta pdfFileId o periodo" });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "Sin credenciales" });

  try {
    const sa = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    // 1. Descargar PDF
    console.log(`Descargando PDF ${pdfFileId}...`);
    const pdfBuffer = await driveDownload(token, pdfFileId);
    console.log(`PDF descargado: ${pdfBuffer.length} bytes`);

    // 2. Separar en páginas usando JSZip no es para PDF...
    // Usamos el método de extracción de texto por streams del PDF
    // y separamos cada página individualmente reconstruyendo PDFs mínimos

    // Encontrar todas las páginas: buscar "endobj" delimitando objetos
    const pdfStr = pdfBuffer.toString("latin1");
    
    // Extraer texto de cada página usando el extractor CMap
    // Para separar páginas físicamente, buscamos los stream de contenido
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    const allStreams = [];
    let sm;
    while ((sm = streamRegex.exec(pdfStr)) !== null) {
      allStreams.push({ pos: sm.index, raw: Buffer.from(sm[1], "latin1") });
    }

    // Identificar streams de contenido (no CMap)
    const contentStreams = [];
    for (const s of allStreams) {
      try {
        const d = require("zlib").inflateSync(s.raw).toString("latin1");
        // Es stream de contenido si tiene operadores PDF como Tj, BT, ET
        if (d.includes(" Tj") && (d.includes("BT") || d.includes("/F"))) {
          contentStreams.push({ ...s, text: d });
        }
      } catch {}
    }

    console.log(`Streams de contenido encontrados: ${contentStreams.length}`);

    // Construir CMap global una vez
    const globalMapping = {};
    for (const s of allStreams) {
      try {
        const d = require("zlib").inflateSync(s.raw).toString("latin1");
        if (d.includes("beginbfchar") || d.includes("beginbfrange"))
          Object.assign(globalMapping, parseCMap(d));
      } catch {}
    }

    // Decodificar texto de cada stream de contenido
    const pageTexts = contentStreams.map(s => {
      let text = "";
      for (const [, h] of s.text.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
        const code = parseInt(h, 16);
        text += globalMapping[code] !== undefined ? globalMapping[code]
              : (code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
      }
      return text.replace(/\s+/g, " ").trim();
    });

    // Agrupar streams por página (cada factura = 1 página = 1 stream de contenido)
    const pages = pageTexts.map((text, i) => ({
      index: i,
      text,
      cod: detectCod(text),
      nro: detectNro(text),
    }));

    console.log(`Páginas detectadas: ${pages.length}`);
    pages.forEach((p, i) => console.log(`  Pág ${i+1}: cod=${p.cod} nro=${p.nro}`));

    // 3. Separar el PDF físicamente página por página
    // Usamos qpdf via child_process si está disponible, sino PDF manual
    const { execSync, spawnSync } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-split-"));
    
    // Escribir PDF original
    const origPath = path.join(tmpDir, "original.pdf");
    fs.writeFileSync(origPath, pdfBuffer);

    // Separar con qpdf página por página
    let splitOk = false;
    try {
      execSync(`qpdf --version`, { stdio: "ignore" });
      splitOk = true;
      console.log("qpdf disponible, separando páginas...");
      for (let i = 0; i < pages.length; i++) {
        const outPath = path.join(tmpDir, `page_${i+1}.pdf`);
        execSync(`qpdf ${origPath} --pages . ${i+1} -- ${outPath}`);
        pages[i].pdfPath = outPath;
      }
    } catch (e) {
      console.log("qpdf no disponible:", e.message);
    }

    if (!splitOk) {
      // Fallback: usar pdfseparate (poppler)
      try {
        execSync(`pdfseparate ${origPath} ${path.join(tmpDir, "page_%d.pdf")}`);
        for (let i = 0; i < pages.length; i++) {
          const p = path.join(tmpDir, `page_${i+1}.pdf`);
          if (fs.existsSync(p)) { pages[i].pdfPath = p; splitOk = true; }
        }
        console.log("pdfseparate OK");
      } catch (e) {
        console.log("pdfseparate no disponible:", e.message);
      }
    }

    // Construir ZIP
    const zip = new JSZip();
    const sinCod = [];
    let totalFacturas = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page.cod) { sinCod.push(i+1); continue; }
      
      const fname = page.nro ? `F-${page.nro}.pdf` : `F-p${i+1}.pdf`;
      const zipPath = `${periodo}/${page.cod}/${fname}`;
      
      let pdfData;
      if (page.pdfPath && fs.existsSync(page.pdfPath)) {
        pdfData = fs.readFileSync(page.pdfPath);
      } else {
        // Fallback: incluir el PDF completo como placeholder
        pdfData = pdfBuffer;
        console.warn(`⚠ Sin PDF individual para página ${i+1}, usando completo`);
      }
      
      zip.file(zipPath, pdfData);
      totalFacturas++;
    }

    if (sinCod.length > 0) {
      zip.file(`${periodo}/sin_cod.txt`, `Páginas sin COD detectado: ${sinCod.join(", ")}\n`);
    }

    // Limpiar tmp
    try { execSync(`rm -rf ${tmpDir}`); } catch {}

    const zipBuffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    console.log(`ZIP generado: ${zipBuffer.length} bytes, ${totalFacturas} facturas`);

    // 4. Subir ZIP a Drive
    const zipName = `${periodo}.zip`;
    const uploadedId = await driveUpload(token, zipName, zipBuffer, "application/zip", destFolderId || null);
    console.log(`ZIP subido a Drive: ${uploadedId}`);

    // Limpiar tmp si quedó algo
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    return res.status(200).json({
      ok: true,
      zipName,
      fileId: uploadedId,
      driveUrl: `https://drive.google.com/file/d/${uploadedId}/view`,
      totalFacturas,
      sinCod,
      breakdown: Object.entries(
        pages.filter(p => p.cod).reduce((acc, p) => {
          acc[p.cod] = (acc[p.cod] || 0) + 1; return acc;
        }, {})
      ).sort(([a],[b]) => a.localeCompare(b)),
    });

  } catch (e) {
    console.error("split-pdf error:", e);
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 500) });
  }
}
