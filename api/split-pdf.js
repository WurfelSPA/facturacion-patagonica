import JSZip from "jszip";

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

    // Recopilar objetos de recursos en 2 niveles de profundidad
    const toProcess = [...needed];
    for (const ref of toProcess) {
      const o = getObj(ref);
      const refs2 = [...o.matchAll(/(\d+)\s+0\s+R/g)].map(r => parseInt(r[1]));
      for (const r2 of refs2) {
        if (!needed.has(r2) && objOffsets[r2] != null) needed.add(r2);
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

    // Escribir objetos de recursos (fonts, etc.)
    const resourceObjs = neededArr.filter(n => n !== pageNum && n !== contentsNum);
    for (const oldNum of resourceObjs) {
      const newNum = mapping[oldNum];
      offsets[newNum] = newPdf.length;
      let o = getObj(oldNum);
      // Remap references
      o = o.replace(/(\d+)\s+0\s+R/g, (match, n) => {
        const mapped = mapping[parseInt(n)];
        return mapped ? `${mapped} 0 R` : match;
      });
      // Fix object number
      o = o.replace(/^\d+\s+0\s+obj/, `${newNum} 0 obj`);
      newPdf += o + "\n";
    }

    // Escribir stream de contenido
    if (contentsNum && contentsObj) {
      const newNum = mapping[contentsNum];
      offsets[newNum] = newPdf.length;
      let o = contentsObj;
      o = o.replace(/^(\d+)\s+0\s+obj/, `${newNum} 0 obj`);
      newPdf += o + "\n";
    }

    // Escribir objeto página (remap referencias)
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

function extractText(pdfBuf) {
  const str = pdfBuf.toString("latin1");
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(str)) !== null) streams.push(Buffer.from(m[1], "latin1"));
  const mapping = {};
  for (const s of streams) {
    try { const d=require("zlib").inflateSync(s).toString("latin1");
      if(d.includes("beginbfchar")||d.includes("beginbfrange")) Object.assign(mapping,parseCMap(d));
    } catch {}
  }
  let text = "";
  for (const s of streams) {
    try { const d=require("zlib").inflateSync(s).toString("latin1");
      for(const[,h] of d.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)){
        const code=parseInt(h,16);
        text+=mapping[code]!==undefined?mapping[code]:(code>=32&&code<127?String.fromCharCode(code):" ");
      }
    } catch {}
  }
  return text.replace(/\s+/g," ").trim();
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
  /* Tolerante con variantes del carácter º (º, °, o, ø) y con o sin espacio */
  const m = text.match(/N[\xBA\xB0o\u00BA\u00B0]?[\s°º]*\s*(\d+)/i)
    || text.match(/N[^a-z\d]{0,3}(\d{2,6})/i);
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

  const { pdfFileId, periodo } = req.body || {};
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

    // 2. Extraer metadata de TODAS las páginas desde el PDF completo
    //    (los CMaps funcionan correctamente sobre el PDF completo)
    //    Dividir por form feed \f que separa páginas en el texto plano
    const fullText = extractText(pdfBuf);
    
    // Separar en páginas: cada página del PDF produce un bloque de texto
    // Usamos los marcadores Nº XXXXX para delimitar páginas
    const pageTexts = splitByPages(fullText);
    console.log(`Texto extraído: ${fullText.length} chars, páginas detectadas: ${pageTexts.length}`);

    // Separar páginas usando el parser puro
    const pageBufs = splitPDFPages(pdfBuf);
    if (!pageBufs || pageBufs.length === 0) {
      throw new Error("No se pudieron separar las páginas del PDF");
    }
    console.log(`Páginas separadas: ${pageBufs.length}`);

    // 3. Usar el texto del PDF completo para nombrar cada página
    const zip = new JSZip();
    const sinCod = [];
    const breakdown = {};

    for (let i = 0; i < pageBufs.length; i++) {
      // Usar texto extraído del PDF completo para esta posición de página
      const text = pageTexts[i] || "";
      const cod = detectCod(text);
      const nro = detectNro(text);

      if (!cod) {
        sinCod.push(i + 1);
        console.log(`Pág ${i+1}: sin COD — texto: "${text.slice(0,80)}"`);
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
      zip.file(`${periodo}/${cod}/${fname}`, pageBufs[i]);
      breakdown[cod] = (breakdown[cod] || 0) + 1;
      console.log(`Pág ${i+1}: ${cod} → ${fname}`);
    }

    if (sinCod.length > 0) {
      zip.file(`${periodo}/sin_cod.txt`, `Páginas sin COD: ${sinCod.join(", ")}\n`);
    }

    /* Resumen legible para verificación */
    const resumenLines = [`Período: ${periodo}`, `Total facturas: ${Object.values(breakdown).reduce((a,b)=>a+b,0)}`, ``];
    for (const [cod, cnt] of Object.entries(breakdown).sort(([a],[b])=>a.localeCompare(b))) {
      resumenLines.push(`  ${cod}: ${cnt} facturas`);
    }
    zip.file(`${periodo}/resumen.txt`, resumenLines.join("\n") + "\n");

    // 4. Generar ZIP
    const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    console.log(`ZIP: ${zipBuf.length} bytes`);

    // 5. Devolver ZIP como base64 — el frontend lo sube a Drive con el token OAuth del usuario
    const zipName = `${periodo}.zip`;
    const zipBase64 = zipBuf.toString("base64");
    const totalFacturas = Object.values(breakdown).reduce((a,b)=>a+b,0);
    return res.status(200).json({
      ok: true,
      zipName,
      zipBase64,
      totalFacturas,
      sinCod,
      breakdown: Object.entries(breakdown).sort(([a],[b])=>a.localeCompare(b)),
    });

  } catch (e) {
    console.error("split-pdf:", e);
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0,300) });
  }
}
