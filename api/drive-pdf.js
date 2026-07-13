/**
 * /api/drive-pdf  GET ?folio=14686&periodo=2026-06
 *
 * Ruta 0: busca PDF individual F-14686*.pdf en FACT_FOLDER_ID → redirect
 * Ruta 1: descarga PDF general Facturas_PISA_YYYY-MM.pdf → extrae la página
 *         exacta que contiene el folio → devuelve PDF binario de esa página
 * Ruta 2: búsqueda global en Drive → redirect
 */

import { PDFDocument, PDFName, PDFArray } from "pdf-lib";
import { inflateSync } from "zlib";

export const config = { api: { bodyParser: false, responseLimit: "20mb" } };

const FACT_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NUM = {
  Enero:"01",Febrero:"02",Marzo:"03",Abril:"04",Mayo:"05",Junio:"06",
  Julio:"07",Agosto:"08",Septiembre:"09",Octubre:"10",Noviembre:"11",Diciembre:"12",
};

function parsePeriodo(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\w+)\s+(\d{4})$/);
  if (!m) return null;
  const mes = MES_NUM[m[1]];
  return mes ? `${m[2]}-${mes}` : null;
}

// ── JWT / SA token ────────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg:"RS256", typ:"JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = privateKey.replace(/-----[^-]+-----/g,"").replace(/\s/g,"");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer,
    { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${input}.${sigB64}`;
}

async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: " + JSON.stringify(d));
  return d.access_token;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function driveGet(token, url) {
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${token}` } });
  if (!r.ok) { const t = await r.text(); throw new Error(`Drive ${r.status}: ${t.slice(0,200)}`); }
  return r.json();
}

async function driveDownload(token, fileId) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function findPdfGlobal(token, folio) {
  const q = encodeURIComponent(`name contains 'F-${folio}' and mimeType='application/pdf' and trashed=false`);
  const d = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const files = (d && d.files) || [];
  if (!files.length) return null;
  // Solo retornar si hay coincidencia exacta de folio (sin fallback a files[0]
  // que devolvería el primer PDF de Drive sin importar si corresponde al folio)
  return files.find(f => f && f.name &&
    (f.name.startsWith(`F-${folio} `) || f.name.startsWith(`F-${folio}.`) ||
     f.name === `F-${folio}.pdf` || f.name.startsWith(`FEE-${folio} `) ||
     f.name.startsWith(`FEE-${folio}.`) || f.name === `FEE-${folio}.pdf`)
  ) || null;
}

// ── Extracción de texto por página (portado de split-pdf.js) ─────────────────
function parseCMap(t) {
  const mapping = {};
  for (const sec of (t.match(/beginbfrange([\s\S]*?)endbfrange/g) || [])) {
    for (const [,s,e,d] of sec.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const si=parseInt(s,16),ei=parseInt(e,16),di=parseInt(d,16);
      for(let i=0;i<=ei-si;i++) mapping[si+i]=String.fromCodePoint(di+i);
    }
  }
  for (const sec of (t.match(/beginbfchar([\s\S]*?)endbfchar/g) || [])) {
    for (const [,src,dst] of sec.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      try {
        const code=parseInt(src,16), bytes=Buffer.from(dst,"hex");
        mapping[code]="";
        for(let i=0;i<bytes.length;i+=2) mapping[code]+=String.fromCodePoint(bytes.readUInt16BE(i));
      } catch {}
    }
  }
  return mapping;
}

function decodeStream(raw) {
  try { return inflateSync(Buffer.from(raw)).toString("latin1"); }
  catch { return Buffer.from(raw).toString("latin1"); }
}

function applyTextOps(decoded, mapping) {
  let text = "";
  for (const [,h] of decoded.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
    const code = parseInt(h,16);
    text += mapping[code] !== undefined ? mapping[code] : (code>=32&&code<127 ? String.fromCharCode(code) : " ");
  }
  for (const [,arr] of decoded.matchAll(/\[([^\]]+)\]\s*TJ/g)) {
    for (const [,h] of arr.matchAll(/<([0-9a-fA-F]+)>/g)) {
      const code = parseInt(h,16);
      text += mapping[code] !== undefined ? mapping[code] : (code>=32&&code<127 ? String.fromCharCode(code) : " ");
    }
  }
  for (const [,s] of decoded.matchAll(/\(([^)]*)\)\s*Tj/g))
    text += s.replace(/\\n/g," ").replace(/\\r/g," ") + " ";
  for (const [,arr] of decoded.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    for (const [,s] of arr.matchAll(/\(([^)]*)\)/g))
      text += s.replace(/\\n/g," ").replace(/\\r/g," ");
    text += " ";
  }
  return text;
}

function buildCMapFromDoc(srcDoc) {
  const mapping = {};
  for (const [,obj] of srcDoc.context.indirectObjects) {
    if (!obj || !obj.contents) continue;
    try {
      const decoded = decodeStream(obj.contents);
      if (decoded.includes("beginbfchar") || decoded.includes("beginbfrange"))
        Object.assign(mapping, parseCMap(decoded));
    } catch {}
  }
  return mapping;
}

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
      text += applyTextOps(decodeStream(streamObj.contents), mapping);
    }
    return text.replace(/\s+/g," ").trim();
  } catch { return ""; }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const CORS = "X-Pdf-Page, Content-Type";
  try {
    const folioRaw = Array.isArray(req.query.folio) ? req.query.folio[0] : req.query.folio;
    const folio = String(folioRaw || "").trim();
    if (!folio || !/^\d+$/.test(folio))
      return res.status(400).json({ error:"folio inválido (debe ser entero)" });

    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saRaw) return res.status(500).json({ error:"GOOGLE_SERVICE_ACCOUNT no configurada" });
    let sa;
    try { sa = JSON.parse(saRaw); } catch {
      return res.status(500).json({ error:"SA JSON inválido" });
    }

    let token;
    try { token = await getToken(sa); } catch (e) {
      return res.status(500).json({ error:"Auth: " + e.message });
    }

    const periodoRaw = Array.isArray(req.query.periodo) ? req.query.periodo[0] : req.query.periodo;
    const periodo = parsePeriodo(periodoRaw);

    // Helper: enviar PDF binario con pista de página
    function sendPdf(buf, page) {
      res.setHeader("Access-Control-Expose-Headers", CORS);
      res.setHeader("Content-Type","application/pdf");
      res.setHeader("Content-Disposition",`inline; filename="F-${folio}.pdf"`);
      res.setHeader("Cache-Control","no-store");
      res.setHeader("X-Pdf-Page", String(page));
      return res.send(Buffer.from(buf));
    }

    // ── Ruta 0: PDF individual pre-split en carpeta ──────────────────────────
    try {
      const q0 = encodeURIComponent(
        `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false` +
        ` and (name contains 'F-${folio} ' or name contains 'F-${folio}.'` +
        ` or name='F-${folio}.pdf' or name contains 'FEE-${folio} ' or name contains 'FEE-${folio}.')`
      );
      const d0 = await driveGet(token,
        `https://www.googleapis.com/drive/v3/files?q=${q0}&fields=files(id,name)&pageSize=10` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      const f0 = ((d0 && d0.files) || []).find(f => f && f.id);
      if (f0) {
        console.log(`drive-pdf R0: sirviendo ${f0.name}`);
        return sendPdf(await driveDownload(token, f0.id), 1);
      }
    } catch (e0) { console.warn("drive-pdf R0:", e0 && e0.message); }

    // ── Ruta 1: buscar folio en PDF general → servir PDF completo + X-Pdf-Page
    if (periodo) {
      try {
        const [anio, mesNum] = periodo.split("-");
        const q1 = encodeURIComponent(
          `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf'` +
          ` and trashed=false and name contains 'PISA'`
        );
        const d1 = await driveGet(token,
          `https://www.googleapis.com/drive/v3/files?q=${q1}&fields=files(id,name)&pageSize=20` +
          `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
        const all1 = (d1 && d1.files) || [];
        const genFile = all1.find(f => {
          if (!f || !f.name || !f.id) return false;
          const n = f.name.toLowerCase();
          return n.endsWith(".pdf") && n.includes("pisa") && (
            n.includes(`${anio}-${mesNum}`) || n.includes(`${mesNum}-${anio}`) ||
            n.includes(`_${mesNum}_`) || n.includes(`-${mesNum}.pdf`)
          );
        });

        if (genFile) {
          console.log(`drive-pdf R1: descargando ${genFile.name}`);
          const pdfBuf = await driveDownload(token, genFile.id);
          const srcDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption:true });
          const totalPages = srcDoc.getPageCount();
          console.log(`drive-pdf R1: ${totalPages} págs, buscando folio ${folio}`);

          const mapping = buildCMapFromDoc(srcDoc);
          let targetIdx = -1;
          // Buscar el folio con contexto específico para evitar falsos positivos
          // (ej: "14690" aparece como monto "$14.690.000" en otras páginas).
          // Se prioriza patrón "N° XXXXX" o "N°XXXXX"; si no se encuentra, se
          // acepta el número suelto SOLO si no está precedido/seguido de otro dígito.
          const folioPatterns = [
            new RegExp(`N[°°o][\\s]*${folio}(?!\\d)`),   // N° 14690 / N°14690
            new RegExp(`(?<![\\d])${folio}(?![\\d])`),         // 14690 como número aislado
          ];
          for (let i = 0; i < totalPages; i++) {
            const text = extractPageText(srcDoc, i, mapping);
            const hit = folioPatterns.some(re => re.test(text));
            if (hit) { targetIdx = i; break; }
          }

          if (targetIdx >= 0) {
            console.log(`drive-pdf R1: folio ${folio} en página ${targetIdx+1} → sirviendo PDF completo`);
            return sendPdf(pdfBuf, targetIdx + 1); // PDF original sin modificar + pista de página
          } else {
            console.warn(`drive-pdf R1: folio ${folio} no encontrado en ${genFile.name}`);
          }
        }
      } catch (e1) { console.warn("drive-pdf R1:", e1 && e1.message); }
    }

    // ── Ruta 2: búsqueda global en Drive �