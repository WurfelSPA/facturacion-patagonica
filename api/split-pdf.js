import JSZip from "jszip";
import { PDFDocument, PDFName, PDFArray } from "pdf-lib";

export const config = { api: { bodyParser: true, responseLimit: '60mb' } };

// ── JWT / OAuth ──────────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey.buffer, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${signingInput}.${sigB64}`;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }, sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token: " + JSON.stringify(data));
  return data.access_token;
}

async function driveDownload(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive download error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}


// ── PDF parser puro en JS ────────────────────────────────────────────────────
// Separar un PDF multipágina en PDFs individuales de 1 página
function splitPDFPages(buf) {
  const src = buf.toString("binary");

  // 1. Parsear xref para obtener offsets de todos los objetos
  const objOffsets = {};
  const objRe = /(\d+)\s+0\s+obj/g;
  let m;
  while ((m = objRe.exec(src)) !== null) {
    objOffsets[parseInt(m[1])] = m.index;
  }

  // Helper: leer objeto por número
  function getObj(num) {
    const off = objOffsets[num];
    if (off == null) return "";
    const end = src.indexOf("endobj", off);
    return end > off ? src.slice(off, end + 6) : src.slice(off, off + 4096);
  }

  // 2. Encontrar el objeto Pages (catálogo)
  function findPages() {
    for (const num of Object.keys(objOffsets)) {
      const o = getObj(parseInt(num));
      if (o.includes("/Type /Pages") || o.includes("/Type/Pages")) {
        const kidsM = o.match(/\/Kids\s*\[([^\]]+)\]/);
        if (kidsM) return kidsM[1].trim().split(/\s+R/).filter(s => s.trim())
          .map(s => parseInt(s.trim().split(/\s+/)[0])).filter(n => !isNaN(n));
      }
    }
    return [];
  }

  const pageNums = findPages();
  if (pageNums.length === 0) return null;

  // 3. Para cada página, construir un PDF mínimo válido
  const pages = [];
  for (const pageNum of pageNums) {
    const pageObj = getObj(pageNum);

    // Encontrar el stream de contenido referenciado por esta página
    const contentsM = pageObj.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const contentsNum = contentsM ? parseInt(contentsM[1]) : null;
    const contentsObj = contentsNum ? getObj(contentsNum) : null;

    // Recopilar todos los objetos necesarios para esta página
    // Buscar recursos: /Font, /XObject, etc.
    const needed = new Set([pageNum]);
    if (contentsNum) needed.add(contentsNum);

    // Buscar referencias de recursos en el objeto página
    const allRefs = [...pageObj.matchAll(/(\d+)\s+0\s+R/g)].map(r => parseInt(r[1]));
    for (const ref of allRefs) needed.add(ref);

    // BFS completo: seguir referencias transitivamente hasta agotar
    // (necesario para incluir FontFile2, ToUnicode CMap, etc. que están a 3+ niveles)
    const bfsQueue = [...needed];
    const bfsVisited = new Set();
    while (bfsQueue.length > 0) {
      const ref = bfsQueue.shift();
      if (bfsVisited.has(ref)) continue;
      bfsVisited.add(ref);
      const o = getObj(ref);
      /* Solo escanear el diccionario, NO el stream binario (evita falsos matches en datos comprimidos que causan OOM) */
      const streamStart = o.indexOf("stream");
      const dictPart = streamStart > 0 ? o.slice(0, streamStart) : o;
      const subRefs = [...dictPart.matchAll(/(\d+)\s+0\s+R/g)].map(r => parseInt(r[1]));
      for (const r2 of subRefs) {
        if (!needed.has(r2) && objOffsets[r2] != null) {
          needed.add(r2);
          bfsQueue.push(r2);
        }
      }
    }

    // Construir PDF mínimo
    let newPdf = "%PDF-1.4\n";
    const mapping = {}; // oldNum -> newNum
    let counter = 1;

    // Asignar nuevos números
    const neededArr = [...needed];
    for (const n of neededArr) mapping[n] = counter++;

    // Objeto 1 es el catálogo, objeto 2 es Pages, objeto 3 es la página
    const catalogNum = counter++;
    const pagesNum = counter++;

    const offsets = {};

    // Helper: remap referencias SOLO en la parte diccionario, nunca dentro del stream binario.
    // Aplicar regex sobre bytes comprimidos (FlateDecode) corrompería las fuentes.
    function remapDictOnly(objText, mapFn) {
      // Detectar inicio del stream (si existe)
      const streamMatch = objText.match(/\bstream\s*\n/);
      if (!streamMatch) {
        // Sin stream: remap todo
        return objText.replace(/(\d+)\s+0\s+R/g, mapFn);
      }
      const splitAt = objText.indexOf(streamMatch[0]);
      const dictPart = objText.slice(0, splitAt);
      const streamPart = objText.slice(splitAt); // incluye "stream\n...endstream\nendobj"
      return dictPart.replace(/(\d+)\s+0\s+R/g, mapFn) + streamPart;
    }

    // Escribir objetos de recursos (fonts, XObjects, CMaps, etc.)
    const resourceObjs = neededArr.filter(n => n !== pageNum && n !== contentsNum);
    for (const oldNum of resourceObjs) {
      const newNum = mapping[oldNum];
      offsets[newNum] = newPdf.length;
      let o = getObj(oldNum);
      // Remap referencias solo en el diccionario (no en streams binarios)
      o = remapDictOnly(o, (match, n) => {
        const mapped = mapping[parseInt(n)];
        return mapped ? `${mapped} 0 R` : match;
      });
      // Fix object number en la primera línea
      o = o.replace(/^\d+\s+0\s+obj/, `${newNum} 0 obj`);
      newPdf += o + "\n";
    }

    // Escribir stream de contenido (solo fix de número, sin remap — no tiene refs internas)
    if (contentsNum && contentsObj) {
      const newNum = mapping[contentsNum];
      offsets[newNum] = newPdf.length;
      let o = contentsObj;
      o = o.replace(/^(\d+)\s+0\s+obj/, `${newNum} 0 obj`);
      newPdf += o + "\n";
    }

    // Escribir objeto página — las páginas son diccionarios puros (sin stream), remap seguro
    const pageNewNum = mapping[pageNum];
    offsets[pageNewNum] = newPdf.length;
    let pageObjNew = pageObj;
    pageObjNew = pageObjNew.replace(/(\d+)\s+0\s+R/g, (match, n) => {
      if (parseInt(n) === pageNum) return `${pageNewNum} 0 R`;
      const mapped = mapping[parseInt(n)];
      return mapped ? `${mapped} 0 R` : match;
    });
    // Reemplazar referencia a Parent con el nuevo Pages
    pageObjNew = pageObjNew.replace(/\/Parent\s+\d+\s+0\s+R/, `/Parent ${pagesNum} 0 R`);
    pageObjNew = pageObjNew.replace(/^\d+\s+0\s+obj/, `${pageNewNum} 0 obj`);
    newPdf += pageObjNew + "\n";

    // Escribir Pages object
    offsets[pagesNum] = newPdf.length;
    newPdf += `${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNewNum} 0 R] /Count 1 >>\nendobj\n`;

    // Escribir Catalog
    offsets[catalogNum] = newPdf.length;
    newPdf += `${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`;

    // Escribir xref
    const xrefOffset = newPdf.length;
    const totalObjs = counter;
    newPdf += `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
    for (let i = 1; i < totalObjs; i++) {
      const off = offsets[i];
      newPdf += off != null ? `${String(off).padStart(10, "0")} 00000 n \n` : `0000000000 65535 f \n`;
    }
    newPdf += `trailer\n<< /Size ${totalObjs} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    pages.push(Buffer.from(newPdf, "binary"));
  }

  return pages;
}

// ── Parsear CMap y extraer texto (igual que pdftext.js) ──────────────────────
function parseCMap(t) {
  const mapping = {};
  for (const sec of (t.match(/beginbfrange([\s\S]*?)endbfrange/g) || [])) {
    for (const [, s, e, d] of sec.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const si=parseInt(s,16),ei=parseInt(e,16),di=parseInt(d,16);
      for(let i=0;i<=ei-si;i++) mapping[si+i]=String.fromCodePoint(di+i);
    }
  }
  for (const sec of (t.match(/beginbfchar([\s\S]*?)endbfchar/g) || [])) {
    for (const [, src, dst] of sec.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      try {
        const code=parseInt(src,16), bytes=Buffer.from(dst,"hex");
        mapping[code]="";
        for(let i=0;i<bytes.length;i+=2) mapping[code]+=String.fromCodePoint(bytes.readUInt16BE(i));
      } catch {}
    }
  }
  return mapping;
}

/* ── Extracción de texto usando el PDF ya parseado por pdf-lib ──────────────
   En vez de regex sobre bytes crudos, usamos los objetos ya parseados en
   srcDoc.context. Esto es O(streams de la página), no O(tamaño del PDF).
   Garantiza alineación: misma página lógica que pageBufs[i].
*/

function decodeStreamContent(rawBytes) {
  try {
    return require("zlib").inflateSync(Buffer.from(rawBytes)).toString("latin1");
  } catch {
    return Buffer.from(rawBytes).toString("latin1");
  }
}

function applyTextOps(decoded, mapping) {
  let text = "";
  for (const [, h] of decoded.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
    const code = parseInt(h, 16);
    text += mapping[code] !== undefined ? mapping[code] : (code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
  }
  for (const [, arr] of decoded.matchAll(/\[([^\]]+)\]\s*TJ/g)) {
    for (const [, h] of arr.matchAll(/<([0-9a-fA-F]+)>/g)) {
      const code = parseInt(h, 16);
      text += mapping[code] !== undefined ? mapping[code] : (code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
    }
  }
  for (const [, s] of decoded.matchAll(/\(([^)]*)\)\s*Tj/g)) {
    text += s.replace(/\\n/g, " ").replace(/\\r/g, " ") + " ";
  }
  for (const [, arr] of decoded.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    for (const [, s] of arr.matchAll(/\(([^)]*)\)/g)) {
      text += s.replace(/\\n/g, " ").replace(/\\r/g, " ");
    }
    text += " ";
  }
  return text;
}

/* Construye CMap iterando objetos ya parseados — sin regex sobre bytes crudos */
function buildCMapFromDoc(srcDoc) {
  const mapping = {};
  for (const [, obj] of srcDoc.context.indirectObjects) {
    if (!obj || !obj.contents) continue;
    try {
      const decoded = decodeStreamContent(obj.contents);
      if (decoded.includes("beginbfchar") || decoded.includes("beginbfrange")) {
        Object.assign(mapping, parseCMap(decoded));
      }
    } catch { /* ignorar streams no procesables */ }
  }
  return mapping;
}

/* Extrae texto de la página pageIndex usando content streams del PDF ya parseado.
   Es O(streams de esa página) — rápido, y garantiza alineación con pageBufs[i]. */
function extractPageText(srcDoc, pageIndex, mapping) {
  try {
    const page = srcDoc.getPage(pageIndex);
    const contentsVal = page.node.get(PDFName.of("Contents"));
    if (!contentsVal) return "";
    const refs = (contentsVal instanceof PDFArray) ? contentsVal.asArray() : [contentsVal];
    let text = "";
    for (const ref of refs) {
      const streamObj = srcDoc.context.lookup(ref);
      if (!streamObj || !streamObj.contents) continue;
      text += applyTextOps(decodeStreamContent(streamObj.contents), mapping);
    }
    return text.replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

/* Compatibilidad: mantener extractText para código que aún lo use */
function getDecodedStreams(pdfBuf) {
  const str = pdfBuf.toString("latin1");
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(str)) !== null) streams.push(Buffer.from(m[1], "latin1"));
  const decoded = [];
  for (const s of streams) {
    try { decoded.push(require("zlib").inflateSync(s).toString("latin1")); } catch {
      const raw = s.toString("latin1");
      if (raw.includes("Tj") || raw.includes("TJ")) decoded.push(raw);
    }
  }
  return decoded;
}
function buildCMap(pdfBuf) {
  const mapping = {};
  for (const d of getDecodedStreams(pdfBuf)) {
    if (d.includes("beginbfchar") || d.includes("beginbfrange")) Object.assign(mapping, parseCMap(d));
  }
  return mapping;
}
function extractText(pdfBuf) {
  const mapping = buildCMap(pdfBuf);
  let text = "";
  for (const d of getDecodedStreams(pdfBuf)) text += applyTextOps(d, mapping);
  return text.replace(/\s+/g, " ").trim();
}

// ── Dividir texto completo en bloques por página ────────────────────────────
// El PDF completo produce texto concatenado; cada factura empieza con "Nº XXXXX"
// Usamos ese patrón como delimitador de página
function splitByPages(fullText) {
  const splits = [];
  // Ancla: "FACTURA (EXENTA) ELECTRONICA" seguido de Nº y número de factura
  const pageStartRegex = /FACTURA(?:\s+EXENTA)?\s+ELECTRONICA\s*N[\xBA\xB0\u00BA\u00B0]\s*\d{2,6}/g;
  let m;
  while ((m = pageStartRegex.exec(fullText)) !== null) {
    splits.push(m.index);
  }
  if (splits.length === 0) {
    console.warn("splitByPages: no se encontraron anclas, devolviendo texto completo");
    return [fullText];
  }
  const pageTexts = [];
  for (let i = 0; i < splits.length; i++) {
    const start = splits[i];
    const end = i + 1 < splits.length ? splits[i + 1] : fullText.length;
    pageTexts.push(fullText.slice(start, end));
  }
  console.log(`splitByPages: ${pageTexts.length} páginas detectadas`);
  return pageTexts;
}

// ── Detectar COD ─────────────────────────────────────────────────────────────
const COD_MAP = {"5-A":"5A","5A":"5A","4-A":"4A","4A":"4A","A-1":"A1","A1":"A1",
  "A-2":"A2","A2":"A2","B":"B","D-2":"D2","D2":"D2","D-3":"D3","D3":"D3"};

function detectCod(text) {
  const m = text.match(/COD:\s*([A-D0-9][-A-D0-9]*)/);
  if (!m) return null;
  return COD_MAP[m[1].trim().replace(/-$/,"").toUpperCase()] || null;
}
function detectNro(text) {
  /* Tolerante con variantes del carácter º (º, °, o, ø) y con o sin espacio.
     Prioridades:
     1. "N° 14548" / "Nº14548" (patrón clásico Nubox)
     2. "F-14548" / "FEE-14548" en el texto del PDF (referencia del documento)
     3. Fallback genérico: N + hasta 4 no-alfanuméricos + 4-6 dígitos */
  const m = text.match(/N[\xBA\xB0o\u00BA\u00B0]?[\s°º]*\s*(\d{4,6})/i)
    || text.match(/F(?:EE)?-\s*(\d{4,6})/i)
    || text.match(/N[^a-zA-Z\d]{0,4}(\d{4,6})/);
  return m ? m[1] : null;
}
function detectCliente(text) {
  /* En texto CMap los campos están pegados: "Señor(es)NOMBRE CLIENTERUT59.170..." */
  const m = text.match(/Señor\(es\)\s*(.+?)\s*RUT\s*[\d]/)
    || text.match(/Senor\(es\)\s*(.+?)\s*RUT\s*[\d]/);
  if (!m) return null;
  return m[1].trim()
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 30)
    .trim();
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { pdfFileId, periodo, destFolderId, userToken } = req.body || {};
  if (!pdfFileId || !periodo) return res.status(400).json({ error: "Falta pdfFileId o periodo" });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "Sin credenciales" });

  try {
    const sa = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    // 1. Descargar PDF
    console.log(`Descargando PDF ${pdfFileId}...`);
    const pdfBuf = await driveDownload(token, pdfFileId);
    console.log(`PDF: ${pdfBuf.length} bytes`);

    // 2. Separar páginas — custom parser SIN pdf-lib en ruta principal.
    //    pdf-lib solo se carga como fallback si el parser mínimo falla.
    //    Cargar pdf-lib + splitPDFPages simultáneamente duplicaba RAM → OOM.
    let usedCustomSplit = true;
    let pageBufs = splitPDFPages(pdfBuf);
    if (!pageBufs || pageBufs.length === 0) {
      // Fallback a pdf-lib solo si el parser mínimo falla (PDF no estándar)
      console.log("splitPDFPages sin resultado, fallback a pdf-lib");
      usedCustomSplit = false;
      const srcDocFb = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
      const totalPagesFb = srcDocFb.getPageCount();
      pageBufs = [];
      for (let i = 0; i < totalPagesFb; i++) {
        const singleDoc = await PDFDocument.create();
        const [copiedPage] = await singleDoc.copyPages(srcDocFb, [i]);
        singleDoc.addPage(copiedPage);
        pageBufs.push(Buffer.from(await singleDoc.save()));
      }
    }
    if (pageBufs.length === 0) throw new Error("No se pudieron separar las páginas del PDF");
    console.log(`Páginas separadas: ${pageBufs.length} (método: ${usedCustomSplit ? "custom-minimal" : "pdf-lib-fallback"})`);

    // 3. Extraer texto de cada página via regex sobre streams binarios
    //    (sin pdf-lib: ahorra 100-200 MB RAM; extractText() usa CMap embebido en cada pageBuf)
    const zip = new JSZip();
    const sinCod = [];
    const breakdown = {};

    for (let i = 0; i < pageBufs.length; i++) {
      const text = extractText(pageBufs[i]);
      const cod = detectCod(text);
      const nro = detectNro(text);

      if (!cod) {
        if (!nro) {
          sinCod.push(i + 1);
          console.log(`Pág ${i+1}: sin COD ni NRO — texto: "${text.slice(0,80)}"`);
          continue;
        }
        // Tiene NRO pero sin COD reconocido → Serv. Adm. u otro tipo sin código de sitio
        const clienteSinCod = detectCliente(text);
        const fnameSinCod = clienteSinCod ? `F-${nro} ${clienteSinCod}.pdf` : `F-${nro}.pdf`;
        zip.file(`default/${fnameSinCod}`, pageBufs[i]);
        breakdown['default'] = (breakdown['default'] || 0) + 1;
        console.log(`Pág ${i+1}: sin COD reconocido, NRO=${nro} → default/${fnameSinCod}`);
        continue;
      }
      if (!nro) {
        console.warn(`Pág ${i+1}: sin Nº (COD=${cod}) — texto: "${text.slice(0,120)}"`);
      }

      const cliente = detectCliente(text);
      let fname;
      if (nro && cliente) fname = `F-${nro} ${cliente}.pdf`;
      else if (nro)       fname = `F-${nro}.pdf`;
      else                fname = `F-p${i+1}.pdf`;
      zip.file(`${cod}/${fname}`, pageBufs[i]);
      breakdown[cod] = (breakdown[cod] || 0) + 1;
      console.log(`Pág ${i+1}: ${cod} → ${fname}`);
    }

    if (sinCod.length > 0) {
      zip.file(`sin_cod.txt`, `Páginas sin COD: ${sinCod.join(", ")}\n`);
    }

    /* Resumen legible para verificación */
    const resumenLines = [`Período: ${periodo}`, `Total facturas: ${Object.values(breakdown).reduce((a,b)=>a+b,0)}`, ``];
    for (const [cod, cnt] of Object.entries(breakdown).sort(([a],[b])=>a.localeCompare(b))) {
      resumenLines.push(`  ${cod}: ${cnt} facturas`);
    }
    zip.file(`resumen.txt`, resumenLines.join("\n") + "\n");

    // 4. Generar ZIP
    const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    console.log(`ZIP: ${zipBuf.length} bytes`);

    // 5. Subir ZIP directo a Drive con Service Account (sin pasar por el frontend)
    const zipName = `${periodo}.zip`;
    const totalFacturas = Object.values(breakdown).reduce((a,b)=>a+b,0);

    if (destFolderId) {
      // Usar token del usuario para subir a su Drive (SA no tiene cuota de almacenamiento)
      const uploadToken = userToken || token;
      const boundary = "split_zip_boundary";
      const endPart = Buffer.from(`\r\n--${boundary}--`);

      // Buscar si ya existe un ZIP con ese nombre — usar SA token (puede ver todos los archivos)
      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${zipName}'+and+'${destFolderId}'+in+parents+and+trashed=false&fields=files(id)&pageSize=5&orderBy=modifiedTime+desc&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchJson = searchRes.ok ? await searchRes.json() : { files: [] };
      const existingIds = (searchJson.files || []).map(f => f.id);

      let uploadJson;
      if (existingIds.length > 0) {
        // Actualizar el primero y eliminar duplicados
        const [keepId, ...dupeIds] = existingIds;
        const updateRes = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${keepId}?uploadType=media`,
          { method: "PATCH", headers: { Authorization: `Bearer ${uploadToken}`, "Content-Type": "application/zip" }, body: zipBuf }
        );
        if (!updateRes.ok) {
          const err = await updateRes.text();
          return res.status(502).json({ error: `ZIP update Drive ${updateRes.status}: ${err.slice(0,200)}` });
        }
        uploadJson = await updateRes.json();
        // Eliminar duplicados silenciosamente
        for (const dupeId of dupeIds) {
          fetch(`https://www.googleapis.com/drive/v3/files/${dupeId}`, { method: "DELETE", headers: { Authorization: `Bearer ${uploadToken}` } }).catch(() => {});
        }
      } else {
        // Crear nuevo archivo
        const meta = JSON.stringify({ name: zipName, mimeType: "application/zip", parents: [destFolderId] });
        const metaPart = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`);
        const multipart = Buffer.concat([metaPart, zipBuf, endPart]);
        const createRes = await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          { method: "POST", headers: { Authorization: `Bearer ${uploadToken}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart }
        );
        if (!createRes.ok) {
          const err = await createRes.text();
          return res.status(502).json({ error: `ZIP upload Drive ${createRes.status}: ${err.slice(0,200)}` });
        }
        uploadJson = await createRes.json();
      }

      // Paso 6 eliminado: subir PDFs individuales causaba timeout (400+ llamadas Drive API).
      // El ZIP completo ya está en Drive — es suficiente para el flujo de envío de correos.
      return res.status(200).json({
        ok: true, zipName, zipFileId: uploadJson.id, totalFacturas, sinCod,
        breakdown: Object.entries(breakdown).sort(([a],[b])=>a.localeCompare(b)),
        indivUploaded: 0, indivErrors: [],
      });
    }

    // Fallback: devolver base64 si no se pasó destFolderId
    return res.status(200).json({
      ok: true, zipName, zipBase64: zipBuf.toString("base64"), totalFacturas, sinCod,
      breakdown: Object.entries(breakdown).sort(([a],[b])=>a.localeCompare(b)),
    });

  } catch (e) {
    console.error("split-pdf:", e);
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0,300) });
  }
}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          