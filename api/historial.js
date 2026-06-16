/**
 * /api/historial
 *
 * GET  ?anio=2026                       → devuelve historial-facturas.json del año
 * GET  ?ls=FOLDER_ID                    → lista archivos en carpeta Drive (SA)
 * GET  ?fileId=FILE_ID                  → proxy descarga de archivo Drive (SA)
 * GET  ?listPeriodos=1                  → lista períodos con ZIP en carpeta facturación
 * GET  ?cliente=X&periodo=Y             → facturas de un cliente en el ZIP del período
 * POST                                  → guarda/fusiona datos de un período en el JSON
 *   Body: { anio, periodo, data: { "CLIENTE": { arriendo:"12345", servAdm:"12346" } } }
 */

import JSZip from "jszip";

export const config = { api: { bodyParser: true, responseLimit: "15mb" } };

const PDF_FOLDER       = process.env.DRIVE_PDF_FACTURAS_ID || "";
const HIST_NAME        = "historial-facturas.json";
const FACT_FOLDER_ID   = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NOM = {
  "01":"Enero","02":"Febrero","03":"Marzo","04":"Abril","05":"Mayo","06":"Junio",
  "07":"Julio","08":"Agosto","09":"Septiembre","10":"Octubre","11":"Noviembre","12":"Diciembre",
};
const MES_NUM = {
  "Enero":"01","Febrero":"02","Marzo":"03","Abril":"04","Mayo":"05","Junio":"06",
  "Julio":"07","Agosto":"08","Septiembre":"09","Octubre":"10","Noviembre":"11","Diciembre":"12",
};

// ── JWT / SA ──────────────────────────────────────────────────────────────────
async function signJWT(payload, privateKey) {
  const header = { alg:"RS256", typ:"JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = privateKey.replace(/-----[^-]+-----/g,"").replace(/\s/g,"");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c=>c.charCodeAt(0)).buffer,
    { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${input}.${sigB64}`;
}
async function getToken(sa) {
  const now = Math.floor(Date.now()/1000);
  const jwt = await signJWT({
    iss: sa.client_email, scope:"https://www.googleapis.com/auth/drive",
    aud:"https://oauth2.googleapis.com/token", iat:now, exp:now+3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: "+JSON.stringify(d));
  return d.access_token;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function findFile(token, name, folderId) {
  const q = encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers:{ Authorization:`Bearer ${token}` } });
  const d = await r.json();
  return d.files?.[0]?.id || null;
}
async function createJsonFile(token, name, folderId, content) {
  const boundary = "PAT_HIST_" + Date.now();
  const meta = JSON.stringify({ name, parents:[folderId], mimeType:"application/json" });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":`multipart/related; boundary="${boundary}"` }, body }
  );
  const d = await r.json();
  if (!d.id) throw new Error("Create file error: "+JSON.stringify(d));
  return d.id;
}
async function updateJsonFile(token, fileId, content) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    { method:"PATCH", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body:content }
  );
  if (!r.ok) throw new Error(`Update file ${r.status}`);
}
async function downloadFile(token, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers:{ Authorization:`Bearer ${token}` } });
  if (!r.ok) return null;
  return r.text();
}
async function listFolder(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=name`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`List folder ${r.status}`);
  return r.json();
}
async function driveFiles(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=100`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  const d = await r.json();
  return d.files || [];
}

// ── PDF text extraction ───────────────────────────────────────────────────────
function parseCMap(t) {
  const m = {};
  for (const sec of (t.match(/beginbfrange([\s\S]*?)endbfrange/g)||[])) {
    for (const [,s,e,d] of sec.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const si=parseInt(s,16),ei=parseInt(e,16),di=parseInt(d,16);
      for(let i=0;i<=ei-si;i++) m[si+i]=String.fromCodePoint(di+i);
    }
  }
  for (const sec of (t.match(/beginbfchar([\s\S]*?)endbfchar/g)||[])) {
    for (const [,src,dst] of sec.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      try {
        const code=parseInt(src,16), bytes=Buffer.from(dst,"hex");
        m[code]="";
        for(let i=0;i<bytes.length;i+=2) m[code]+=String.fromCodePoint(bytes.readUInt16BE(i));
      } catch {}
    }
  }
  return m;
}
function extractText(pdfBuf) {
  const str = pdfBuf.toString("latin1");
  const streams=[];
  const re=/stream\r?\n([\s\S]*?)endstream/g; let match;
  while((match=re.exec(str))!==null) streams.push(Buffer.from(match[1],"latin1"));
  const decoded=[];
  for(const s of streams){
    try{ decoded.push(require("zlib").inflateSync(s).toString("latin1")); }
    catch{ const raw=s.toString("latin1"); if(raw.includes("Tj")||raw.includes("TJ")) decoded.push(raw); }
  }
  const mapping={};
  for(const d of decoded) if(d.includes("beginbfchar")||d.includes("beginbfrange")) Object.assign(mapping,parseCMap(d));
  let text="";
  for(const d of decoded){
    for(const [,h] of d.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)){const c=parseInt(h,16);text+=mapping[c]!==undefined?mapping[c]:(c>=32&&c<127?String.fromCharCode(c):" ");}
    for(const [,arr] of d.matchAll(/\[([^\]]+)\]\s*TJ/g)) for(const [,h] of arr.matchAll(/<([0-9a-fA-F]+)>/g)){const c=parseInt(h,16);text+=mapping[c]!==undefined?mapping[c]:(c>=32&&c<127?String.fromCharCode(c):" ");}
    for(const [,s] of d.matchAll(/\(([^)]*)\)\s*Tj/g)) text+=s.replace(/\\n/g," ")+" ";
    for(const [,arr] of d.matchAll(/\[([^\]]*)\]\s*TJ/g)){for(const [,s] of arr.matchAll(/\(([^)]*)\)/g)) text+=s.replace(/\\n/g," ");text+=" ";}
  }
  return text.replace(/\s+/g," ").trim();
}

// ── PDF consolidado: extrae facturas por RUT ─────────────────────────────────
// Retorna { arriendo:[{nro,uf,total},...], servAdm:[...], habilitacion:[...] }
// Puede haber múltiples facturas del mismo tipo cuando el cliente tiene varios sitios.
function extractFacturasForRut(text, rutNorm) {
  const facturas = {};  // tipo → [{nro,uf,total}]
  const t = (text||"").replace(/\s+/g," ");

  const nros = [];
  const nroRe = /(?:[Nn][ºo°]\s*|(?:F(?:EE)?-))\s*(\d{4,6})/g;
  let m;
  while ((m = nroRe.exec(t)) !== null) {
    const nro = m[1], pos = m.index;
    if (!nros.length || pos - nros[nros.length-1].pos > 20 || nros[nros.length-1].nro !== nro)
      nros.push({ nro, pos });
  }
  if (!nros.length) return facturas;

  const seenNros = new Set();
  const rutRe = /\d{1,2}[.\s]\d{3}[.\s]\d{3}-[\dkK]/g;
  while ((m = rutRe.exec(t)) !== null) {
    if (normRut(m[0]) !== rutNorm) continue;
    const rutPos = m.index;
    let prevNro = null;
    for (let i = nros.length-1; i >= 0; i--) {
      if (nros[i].pos <= rutPos) { prevNro = nros[i]; break; }
    }
    if (!prevNro || seenNros.has(prevNro.nro)) continue;
    seenNros.add(prevNro.nro);
    const nextNro = nros.find(n => n.pos > rutPos);
    const section = t.slice(prevNro.pos, nextNro ? nextNro.pos : t.length);
    const tipo = detectTipo(section);
    if (!tipo) continue;
    const nro = `${tipo === "servAdm" ? "FEE" : "F"}-${prevNro.nro}`;
    const wideUF = t.slice(prevNro.pos, prevNro.pos + 3000);
    const total = _extractTotal(t, prevNro.pos);
    const uf = _extractUF(section) ?? _extractUF(wideUF) ?? _derivarUFdePrecio(wideUF, total);
    if (!facturas[tipo]) facturas[tipo] = [];
    facturas[tipo].push({ nro, uf, total });
  }
  return facturas;
}

// Selecciona el candidato cuya UF sea más cercana al valor esperado.
// Si no hay candidatos con UF o no se pasa expected, retorna el primero.
function _pickByUF(candidates, expectedUF) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1 || !(expectedUF > 0)) return candidates[0];
  let best = candidates[0], bestDiff = Infinity;
  for (const c of candidates) {
    if (c.uf == null) continue;
    const diff = Math.abs(c.uf - expectedUF);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best;
}

// Convierte el resultado multi-candidato a objeto simple {tipo:{nro,uf,total}}
// usando ufArr/ufSrv para seleccionar el correcto cuando hay múltiples.
function _resolveFacturas(multiFacturas, ufArr, ufSrv) {
  const UFExp = { arriendo: ufArr, servAdm: ufSrv, habilitacion: null };
  const result = {};
  for (const [tipo, candidates] of Object.entries(multiFacturas)) {
    const picked = _pickByUF(candidates, UFExp[tipo]);
    if (picked) result[tipo] = picked;
  }
  return result;
}
function _derivarUFdePrecio(s, total) {
  // Fallback matemático: cuando el texto no permite extraer la cantidad UF directamente,
  // calculamos: uf_qty = Monto_Total / 1.19 / precio_por_UF
  // El precio por UF aparece marcado como "AF" (Ajuste de Factor) en las facturas FEE-.
  // Formatos posibles: "40.695,38 AF", "40695,38 AF", "40,695.38 AF", "40695 AF"
  if (!total || total < 10000) return null;
  const patterns = [
    /(\d{2}[.,]\d{3}[.,]\d{1,2})\s*A\s*F\b/i,  // "40.695,38 AF" o "40,695.38 AF"
    /(\d{5,6}(?:[.,]\d{1,2})?)\s*A\s*F\b/i,      // "40695,38 AF" o "40695 AF"
    /\bA\s*F\b\s*(\d{2}[.,]\d{3}[.,]\d{1,2})/i,  // "AF 40.695,38"
    /\bA\s*F\b\s*(\d{5,6}(?:[.,]\d{1,2})?)/i,    // "AF 40695,38"
  ];
  for (const pat of patterns) {
    const m = s.match(pat);
    if (!m) continue;
    let raw = m[1];
    // Normalizar a número: si tiene dos separadores, el último es el decimal
    const commas = (raw.match(/,/g)||[]).length;
    const dots   = (raw.match(/\./g)||[]).length;
    if (commas === 1 && dots === 1) {
      // Ambos presentes → el último es decimal
      raw = raw.lastIndexOf(',') > raw.lastIndexOf('.')
        ? raw.replace('.','').replace(',','.')   // "40.695,38" → "40695.38"
        : raw.replace(',','');                   // "40,695.38" → "40695.38"
    } else {
      raw = raw.replace(/[.,](\d{1,2})$/, '.$1').replace(/[.,]/g,'');
    }
    const precio = parseFloat(raw);
    if (!precio || precio < 20000 || precio > 150000) continue; // precio UF plausible
    const uf = (total / 1.19) / precio;
    if (uf >= 0.1 && uf < 500) return Math.round(uf * 100) / 100;
  }
  return null;
}
function _extractUF(s) {
  // P0 (patrón PISA): "12,8 UF 40.695,38 AF" — número + UF + precio 5 dígitos
  // Idéntico al patrón exitoso de pdftext.js. No usa \b para no romper con "UF40".
  // Captura la CANTIDAD de UF (izquierda), no el precio (derecha).
  const m0 = s.match(/([\d]{1,3}[,.][\d]{1,3})\s*U\s*F\s*\d{2}/i);
  if (m0) { const v=parseFloat(m0[1].replace(",",".")); if(v>=0.1&&v<500) return Math.round(v*10000)/10000; }

  // P1: UF + número — arriendo: "UF 106,64 x 40186"
  const m1 = s.match(/U\s*F\s*([\d]{1,3}[,.][\d]{1,3})(?![.,\d])/i);
  if (m1) { const v=parseFloat(m1[1].replace(",",".")); if(v>=0.1&&v<500) return Math.round(v*10000)/10000; }

  // P2: búsqueda por proximidad — solo coma-decimal, terminador no-numérico
  const ufPos = s.search(/U\s*F/i);
  if (ufPos >= 0) {
    // ANTES del UF
    const winBefore = s.slice(Math.max(0, ufPos - 300), ufPos);
    const bMatches = [...winBefore.matchAll(/([\d]{1,3},[\d]{1,3})(?![.,\d])/g)];
    for (const m of bMatches.reverse()) {
      const v = parseFloat(m[1].replace(",", "."));
      if (v >= 0.1 && v < 500) return Math.round(v * 10000) / 10000;
    }
    // DESPUÉS del UF
    const winAfter = s.slice(ufPos + 2, Math.min(s.length, ufPos + 60));
    const mA = winAfter.match(/^\s*([\d]{1,3},[\d]{1,3})(?![.,\d])/);
    if (mA) { const v=parseFloat(mA[1].replace(",",".")); if(v>=0.1&&v<500) return Math.round(v*10000)/10000; }
  }
  return null;
}
function _extractTotal(s, fromPos = 0) {
  // Busca "Monto Total XXXXXXX" desde fromPos en adelante
  const text = fromPos > 0 ? s.slice(fromPos) : s;
  const m = text.match(/[Mm]onto\s*[Tt]otal[\s:]*([\d.]+)/i)
          || text.match(/[Tt]otal[\s:]*([\d]+(?:\.\d{3})+)/i);
  if (!m) return null;
  const v = parseInt(m[1].replace(/\./g, ""), 10);
  return isNaN(v) || v < 10000 ? null : v;
}

// ── Historial-cliente helpers ─────────────────────────────────────────────────
function norm(s){
  return (s||"").toLowerCase()
    .replace(/&/g," ")
    .normalize("NFD").replace(/[̀-ͯ]/g,"")
    .replace(/[^a-z0-9 ]/g,"")
    .replace(/\s+/g," ").trim();
}
function clienteMatch(fromFile, query) {
  const a=norm(fromFile), b=norm(query);
  if(!a||!b) return false;
  if(a===b) return true;
  // Substring: solo si la cadena contenida tiene ≥4 chars (evita falsos positivos por "spa", "cia", etc.)
  if(b.length>=4&&a.includes(b)) return true;
  if(a.length>=3&&b.includes(a)) return true;
  // Palabras distintivas: ignorar prefijos genéricos para evitar confundir "Comercial Granja" con "Comercial Industrial"
  const GENERIC=new Set(["comercial","sociedad","empresa","servicios","industria","distribuidora",
    "corporacion","consultora","inversiones","laboratorio","importadora","exportadora","agencia","compania"]);
  const sigWords=s=>s.split(" ").filter(w=>w.length>=4&&!GENERIC.has(w));
  const wA=sigWords(a); const wB=sigWords(b);
  if(!wA.length||!wB.length) return false;
  // Al menos 1 palabra distintiva en común (si solo hay 1 en cada uno) o 2 (si hay varias)
  const setA=new Set(wA);
  const common=wB.filter(w=>setA.has(w));
  return common.length>=Math.min(2,wA.length,wB.length);
}
function detectTipo(text) {
  /* Primera aparición de cada keyword — evita falsos positivos de pie de página.
     Múltiples variantes para cubrir diferentes encodings de PDF. */
  const t = (text||"").replace(/\s+/g," ");
  const hits = [];
  const add = (tipo, needle) => { const i=t.indexOf(needle); if(i>=0) hits.push({tipo,i}); };
  // Habilitación
  add("habilitacion","Habilitaci");
  // Serv. Admin — variantes con/sin punto, con/sin espacio, COD de descripción
  add("servAdm","Serv. Adm.");
  add("servAdm","Serv.Adm.");
  add("servAdm","Serv. Adm ");   // sin punto final
  add("servAdm","COD: S-A");     // código de concepto en facturas PISA
  add("servAdm","COD:S-A");
  // Arriendo — variantes
  add("arriendo","Arriendo");
  add("arriendo","ARRIENDO");
  if(!hits.length) return null;
  hits.sort((a,b)=>a.i-b.i);
  return hits[0].tipo;
}
function extractClienteFromText(text) {
  const m=text.match(/Se[ñn]or\(es\)\s*(.+?)\s*RUT\s*[\d]/);
  return m?m[1].trim().replace(/\s+/g," ").slice(0,40):null;
}
function normRut(r){ return (r||"").replace(/\./g,"").replace(/\s/g,"").toLowerCase(); }
function extractRutFromText(text) {
  /* Busca todos los RUTs en el texto, devuelve el primero que NO sea el de Patagónica */
  const ruts=[...(text||"").matchAll(/\d{1,2}[.\s]\d{3}[.\s]\d{3}-[\dkK]/g)].map(m=>m[0]);
  return ruts.find(r=>normRut(r)!=="966732504")||null;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error:"GOOGLE_SERVICE_ACCOUNT no configurada" });
  const sa = JSON.parse(saJson);

  try {
    const token = await getToken(sa);

    // ── GET ?ls=FOLDER_ID ── lista carpeta Drive ───────────────────────────
    if (req.method === "GET" && req.query.ls) {
      const folderId = req.query.ls;
      if (!/^[\w-]+$/.test(folderId)) return res.status(400).json({ error:"ID inválido" });
      const data = await listFolder(token, folderId);
      return res.status(200).json(data);
    }

    // ── GET ?fileId=FILE_ID ── proxy descarga ──────────────────────────────
    if (req.method === "GET" && req.query.fileId) {
      const fileId = req.query.fileId;
     