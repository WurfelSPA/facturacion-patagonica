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
import { readFileSync } from "fs";
import { join } from "path";

export const config = { api: { bodyParser: true, responseLimit: "15mb" } };

// Pre-carga del JSON del Excel embebido en el bundle de la función (includeFiles en vercel.json)
// Esto elimina la dependencia de Drive para el JSON y garantiza datos siempre actualizados al deploy.
let _EXCEL_EMBEDDED = null;
let _EXCEL_EMBEDDED_PATH = null;
const _JSON_FNAME = "historial-excel-2026.json";
// Intenta varios paths porque process.cwd() varía entre entornos Vercel
for (const candidate of [
  join(process.cwd(), _JSON_FNAME),
  join(process.cwd(), "api", _JSON_FNAME),
  "/var/task/" + _JSON_FNAME,
]) {
  try {
    const raw = readFileSync(candidate, "utf8");
    _EXCEL_EMBEDDED = JSON.parse(raw);
    _EXCEL_EMBEDDED_PATH = candidate;
    break;
  } catch(_) { /* no disponible en este path, probar siguiente */ }
}

const PDF_FOLDER       = process.env.DRIVE_PDF_FACTURAS_ID || "";
const HIST_NAME        = "historial-facturas.json";
const EXCEL_JSON_NAME  = "historial-excel-2026.json";
const FACT_FOLDER_ID   = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";
// ID directo del JSON generado desde el Excel (evita búsqueda por nombre con findFile)
const EXCEL_JSON_ID    = "1sL_qOK9QsGjgtoaLIdhA37nN0I566M1t";

// Caché en memoria del JSON del Excel (se invalida cada hora)
let _excelCache = null;
let _excelCacheTs = 0;
let _rutMapCache = null;
let _rutMapCacheTs = 0;
const EXCEL_CACHE_TTL = 3600 * 1000;

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
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers:{ Authorization:`Bearer ${token}` } });
  const d = await r.json();
  return d.files?.[0]?.id || null;
}
async function createJsonFile(token, name, folderId, content) {
  const boundary = "PAT_HIST_" + Date.now();
  const meta = JSON.stringify({ name, parents:[folderId], mimeType:"application/json" });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":`multipart/related; boundary="${boundary}"` }, body }
  );
  const d = await r.json();
  if (!d.id) throw new Error("Create file error: "+JSON.stringify(d));
  return d.id;
}
async function updateJsonFile(token, fileId, content) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
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



// ── XML DTE parser ────────────────────────────────────────────────────────────
/** Extrae campos clave de un DTE XML individual */
function parseXmlDTE(xml) {
  const g = tag => { const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ""; };
  const items = [];
  const detRe = /<Detalle>([\s\S]*?)<\/Detalle>/g;
  let dm;
  while ((dm = detRe.exec(xml)) !== null) {
    const d = dm[1];
    const gi = t => { const m = d.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? m[1].trim() : ""; };
    items.push({ nmb: gi("NmbItem"), dsc: gi("DscItem"), qty: gi("QtyItem"), umd: gi("UnmdItem"), cod: gi("VlrCodigo") });
  }
  return { folio: g("Folio"), tipoDTE: g("TipoDTE"), rut: g("RUTRecep"), total: parseInt(g("MntTotal")) || null, items };
}
/** Extrae cantidad UF de un ítem: por QtyItem+UnmdItem='UF' o por texto en DscItem */
function _ufFromXmlItem(item) {
  if (item.umd === "UF") {
    const v = parseFloat(item.qty);
    if (v >= 0.1 && v < 500) return Math.round(v * 10000) / 10000;
  }
  // Patrón 1: "UF  106,64 x 40186,79" / "UF 61,74 x" / "UF  90 x" (con prefijo UF; decimal opcional)
  const m = item.dsc.match(/UF\s+([\d]{1,3}(?:[,.][ \d]{0,1}[\d]{1,3})?)(?:\s*x|\s*$|\s+\d)/i);
  if (m) { const v = parseFloat(m[1].replace(",", ".")); if (v >= 0.1 && v < 500) return Math.round(v * 10000) / 10000; }
  // Patrón 2: "41,92 x 39747,15" (qty_UF × precio_UF sin prefijo "UF")
  const m2 = item.dsc.match(/\b(\d{1,3}[.,]\d{2})\s+x\s+\d{4,}/);
  if (m2) { const v = parseFloat(m2[1].replace(",", ".")); if (v >= 0.1 && v < 500) return Math.round(v * 10000) / 10000; }
  return null;
}
/** Clasifica tipo según NmbItem — cubre variantes con y sin "de": "Serv. de Adm.", "Serv. Adm." */
function _detectTipoFromNmb(nmb) {
  const n = (nmb || "").toLowerCase();
  if (n.includes("habilitaci")) return "habilitacion";
  if (n.includes("serv. de adm") || n.includes("serv.de adm") || n.includes("serv de adm") ||
      n.includes("serv. adm") || n.includes("serv adm") || n.includes("serv.adm") ||
      n.includes("gastos comun") || n.includes("gtos. com")) return "servAdm";
  if (n.includes("serv. mant") || n.includes("serv mant") || n.includes("mantencion") ||
      n.includes("mantenci\u00f3n")) return "servMant";
  if (n.includes("serv") && (n.includes("contab") || n.includes("contable"))) return "servCont";
  if (n.includes("asesor")) return "asesoria";
  if (n.includes("arriendo")) return "arriendo";
  return null;
}
/** Procesa array de XMLs, filtra por RUT, devuelve {tipo:[{nro,uf,total}]} */
// Normaliza código interno: "A2"→"A2", "A-2"→"A2", "B"→"B" (quita guiones, mayúscula)
function _normCod(s) { return (s||"").toUpperCase().replace(/[-\s_]/g,""); }

/** Procesa array de XMLs, filtra por RUT, devuelve {tipo:[{nro,uf,total,cod}]}
 *  sitioFilter (opcional): sc.sitio — si el XML tiene VlrCodigo, solo se incluyen
 *  items cuyo código coincide con el sitio solicitado. */
function _buildXmlFacturas(xmlFiles, rutNorm, sitioFilter = null) {
  const sitioNorm = sitioFilter ? _normCod(sitioFilter) : null;
  const byTipo = {};
  for (const { content } of xmlFiles) {
    const dte = parseXmlDTE(content);
    if (!dte.rut || normRut(dte.rut) !== rutNorm) continue;
    if (dte.tipoDTE === "61") continue; // ignorar Notas de Crédito
    const seenNros = new Set();
    for (const item of dte.items) {
      const tipo = _detectTipoFromNmb(item.nmb);
      if (!tipo) continue;
      // Filtro por VlrCodigo: solo para arriendo — el VlrCodigo de servAdm puede ser
      // un código de concepto ("S-A") en vez de código de sitio ("A-2"), por lo que
      // filtrarlo rechazaría facturas válidas. La selección por UF en _pickByUF
      // desambigua sitios para servAdm cuando hay múltiples candidatos.
      if (tipo !== 'servAdm' && sitioNorm && item.cod && _normCod(item.cod) !== sitioNorm) continue;
      const prefix = tipo === "servAdm" ? "FEE" : "F";
      const nro = `${prefix}-${dte.folio}`;
      if (seenNros.has(nro)) continue; // evitar duplicar línea exenta
      seenNros.add(nro);
      const uf = _ufFromXmlItem(item);
      if (!byTipo[tipo]) byTipo[tipo] = [];
      if (!byTipo[tipo].some(e => e.nro === nro))
        byTipo[tipo].push({ nro, uf, total: dte.total, cod: item.cod || null });
    }
  }
  return byTipo;
}

// Auto-corrección del JSON cuando se usa refresh=1: sobreescribe el dato contaminado
async function _autoSaveHistorial(token, anio, periodo, clienteKey, facturas, pdfFolderId) {
  if (!pdfFolderId || !clienteKey) return;
  try {
    let historial = {};
    const fileId = await findFile(token, HIST_NAME, pdfFolderId);
    if (fileId) {
      const text = await downloadFile(token, fileId);
      if (text) historial = JSON.parse(text);
    }
    if (!historial[anio]) historial[anio] = {};
    if (!historial[anio][periodo]) historial[anio][periodo] = {};
    historial[anio][periodo][clienteKey] = facturas;
    const content = JSON.stringify(historial, null, 2);
    if (fileId) await updateJsonFile(token, fileId, content);
    else await createJsonFile(token, HIST_NAME, pdfFolderId, content);
  } catch(_) { /* silencioso */ }
}
// ── PDF consolidado: extrae facturas por RUT ─────────────────────────────────
// Retorna { arriendo:[{nro,uf,total},...], servAdm:[...], habilitacion:[...] }
// Puede haber múltiples facturas del mismo tipo cuando el cliente tiene varios sitios.
function extractFacturasForRut(text, rutNorm) {
  const facturas = {};  // tipo → [{nro,uf,total}]
  const t = (text||"").replace(/\s+/g," ").slice(0, 3000); // descripción siempre en primeros 3000 chars

  const nros = [];
    // Nota: se excluye "°" (símbolo de grados U+00B0) para no confundir "N°2680"
  // de direcciones con números de factura. Las facturas reales usan "º" (ordinal).
  const nroRe = /(?:[Nn][ºo]\s*|(?:F(?:EE)?-))\s*(\d{4,6})/g;
  let m;
  while ((m = nroRe.exec(t)) !== null) {
    const nro = m[1], pos = m.index;
    if (!nros.length || pos - nros[nros.length-1].pos > 20 || nros[nros.length-1].nro !== nro)
      nros.push({ nro, pos });
  }
  if (!nros.length) return facturas;

  const seenNros = new Set();
  // Acepta tanto "76.123.456-7" (con puntos/espacios) como "76123456-7" (sin separadores)
  const rutRe = /(?:\d{1,2}[.\s]\d{3}[.\s]\d{3}|\d{7,8})-[\dkK]/g;
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
    // Buscar UF también hacia atrás: en PDFs PISA la descripción "12,8 UF" puede
    // aparecer antes del Nº de factura en el flujo de texto extraído
    const wideBack = t.slice(Math.max(0, prevNro.pos - 800), prevNro.pos + 500);
    const total = _extractTotal(t, prevNro.pos);
    const uf = _extractUF(section) ?? _extractUF(wideUF) ?? _extractUF(wideBack) ?? _derivarUFdePrecio(wideUF, total);
    if (!facturas[tipo]) facturas[tipo] = [];
    facturas[tipo].push({ nro, uf, total });
  }
  return facturas;
}

// Selecciona el candidato cuya UF sea más cercana al valor esperado.
// Si no hay candidatos con UF o no se pasa expected, retorna el primero.
function _pickByUF(candidates, expectedUF, siteIdx) {
  if (!candidates || candidates.length === 0) return null;
  if (!(expectedUF > 0)) return candidates[siteIdx != null ? siteIdx % candidates.length : 0];
  // Ordenar por distancia UF ascendente; desempate: folio numérico ascendente
  const sorted = [...candidates].sort((a, b) => {
    const da = a.uf != null ? Math.abs(a.uf - expectedUF) : Infinity;
    const db = b.uf != null ? Math.abs(b.uf - expectedUF) : Infinity;
    if (Math.abs(da - db) > 0.001) return da - db;
    return parseInt((a.nro||"").replace(/\D/g,"")||"0") - parseInt((b.nro||"").replace(/\D/g,"")||"0");
  });
  const minDiff = sorted[0].uf != null ? Math.abs(sorted[0].uf - expectedUF) : Infinity;
  // Umbral 0.5 UF: solo aplica cuando hay MÚLTIPLES candidatos con UF conocido
  // (para desambiguar sitios del mismo cliente). Con un único candidato no hay
  // ambigüedad posible — el frontend puede enviar un ufArr de período distinto.
  const nConUF = candidates.filter(c => c.uf != null).length;
  if (nConUF > 1 && expectedUF > 0 && isFinite(minDiff) && minDiff > 0.5) return null;
  // Entre candidatos empatados (misma distancia al UF esperado), elegir por siteIdx
  const tied = sorted.filter(c => c.uf != null && Math.abs(Math.abs(c.uf - expectedUF) - minDiff) < 0.001);
  if (siteIdx != null && tied.length > 1) return tied[siteIdx % tied.length];
  return sorted[0];
}

// Convierte el resultado multi-candidato a objeto simple {tipo:{nro,uf,total}}
// usando ufArr/ufSrv para seleccionar el correcto cuando hay múltiples.
function _resolveFacturas(multiFacturas, ufArr, ufSrv, siteIdx) {
  // Copia superficial de candidatos para no mutar el original
  const byTipo = {};
  for (const [k, v] of Object.entries(multiFacturas)) byTipo[k] = [...v];

  // ── Rescate: NmbItem incorrecto en Nubox (ej: "Arriendo" en vez de "Serv. Adm.") ──
  // Si servAdm está vacío y ufSrv > 0, busca entre candidatos de arriendo uno cuyo UF
  // esté más cerca de ufSrv que de ufArr → lo reclasifica como servAdm.
  if (ufSrv > 0 && (!byTipo.servAdm || byTipo.servAdm.length === 0) && (byTipo.arriendo || []).length > 1) {
    const withUF = (byTipo.arriendo || []).filter(c => c.uf != null);
    for (const c of withUF) {
      const distSrv = Math.abs(c.uf - ufSrv);
      const distArr = ufArr > 0 ? Math.abs(c.uf - ufArr) : Infinity;
      if (distSrv < distArr && distSrv < 5) {
        byTipo.servAdm = [c];
        byTipo.arriendo = byTipo.arriendo.filter(e => e.nro !== c.nro);
        break;
      }
    }
  }

  const UFExp = { arriendo: ufArr, servAdm: ufSrv, habilitacion: null, servMant: null, servCont: null, asesoria: null };
  const result = {};
  for (const [tipo, candidates] of Object.entries(byTipo)) {
    // Si el sitio no tiene este concepto (UF=0 en planilla), no asignar aunque haya candidatos.
    // Ejemplo: Visibility S.A. tiene 1 arriendo (para Of.102) y 1 servAdm (para Edif.D);
    // el sitio que no corresponde debe tener ufArr=0 o ufSrv=0 en la planilla.
    if (tipo === 'arriendo' && !(ufArr > 0)) continue;
    if (tipo === 'servAdm' && !(ufSrv > 0)) continue;
    // Tipos sin UF esperada (servCont, asesoria): sin VlrCodigo que vincule al sitio,
    // asignar solo al primer sitio del grupo (siteIdx=0) para no duplicar la misma
    // factura en todos los sitios del mismo cliente.
    if (UFExp[tipo] == null && siteIdx > 0) continue;
    const picked = _pickByUF(candidates, UFExp[tipo], siteIdx);
    if (!picked) continue;
    // Facturas adicionales del mismo concepto en el mismo período (ej: retroactiva de mes anterior).
    // Solo se suman si su UF también pasa el umbral → pertenecen al mismo sitio.
    const threshold = UFExp[tipo] > 0 ? 0.5 : Infinity;
    const extras = candidates.filter(c =>
      c.nro !== picked.nro && c.uf != null &&
      (!(UFExp[tipo] > 0) || Math.abs(c.uf - UFExp[tipo]) <= threshold)
    );
    if (extras.length > 0) {
      const extraTotal = extras.reduce((s, e) => s + (e.total || 0), 0);
      result[tipo] = { ...picked, total: (picked.total || 0) + extraTotal, extras: extras.map(e => e.nro) };
    } else {
      result[tipo] = picked;
    }
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
  const t = (text||"").replace(/\s+/g," ").slice(0, 3000); // descripción siempre en primeros 3000 chars
  const hits = [];
  const add = (tipo, needle) => { const i=t.indexOf(needle); if(i>=0) hits.push({tipo,i}); };
  // Habilitación
  add("habilitacion","Habilitaci");
  // Serv. Admin — variantes con/sin "de", con/sin punto, con/sin espacio, COD de descripción
  add("servAdm","Serv. de Adm"); // formato real PISA: "Serv. de Adm. Febrero 2026"
  add("servAdm","Serv.de Adm");
  add("servAdm","Serv de Adm");
  add("servAdm","Serv. Adm.");
  add("servAdm","Serv.Adm.");
  add("servAdm","Serv. Adm ");   // sin punto final: "Serv. Adm Enero 2026"
  add("servAdm","COD: S-A");     // código de concepto en facturas PISA
  add("servAdm","COD:S-A");
  add("servAdm","Gastos Comunes");
  add("servAdm","GASTOS COMUNES");
  add("servAdm","Gtos. Com");
  add("servAdm","Adm. de Propiedad");
  // Arriendo — variantes (incluye "Arrendamiento" que no contiene "Arriendo" como substring)
  add("arriendo","Arriendo");
  add("arriendo","ARRIENDO");
  add("arriendo","Arrendamiento");
  add("arriendo","ARRENDAMIENTO");
  // Serv. Mantención — variantes
  add("servMant","Serv. Mant");
  add("servMant","Serv.Mant");
  add("servMant","Serv Mant");
  add("servMant","Mantencion");
  add("servMant","Mantención");
  // Servicios Contables
  add("servCont","Servicios Contables");
  add("servCont","Serv. Contables");
  add("servCont","Serv Contables");
  // Asesorías de Proyecto
  add("asesoria","Asesoria de Proyecto");
  add("asesoria","Asesoría de Proyecto");
  add("asesoria","Asesorias Proyecto");
  add("asesoria","Asesorías Proyecto");
  add("asesoria","Asesoria Proyecto");
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
  const ruts=[...(text||"").matchAll(/(?:\d{1,2}[.\s]\d{3}[.\s]\d{3}|\d{7,8})-[\dkK]/g)].map(m=>m[0]);
  return ruts.find(r=>normRut(r)!=="966732504")||null;
}

// ── Excel JSON cache ──────────────────────────────────────────────────────────
async function _loadExcelCache(token) {
  const now = Date.now();
  if (_excelCache && (now - _excelCacheTs) < EXCEL_CACHE_TTL) return _excelCache;

  // 1. Prioridad: archivo embebido en el bundle (vercel.json includeFiles)
  if (_EXCEL_EMBEDDED) {
    _excelCache = _EXCEL_EMBEDDED;
    _excelCacheTs = now;
    return _excelCache;
  }

  // 2. Fallback: descarga desde Drive por ID directo
  try {
    const text = await downloadFile(token, EXCEL_JSON_ID);
    if (!text) return null;
    _excelCache = JSON.parse(text);
    _excelCacheTs = now;
    return _excelCache;
  } catch(_) {
    return null;
  }
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
      if (!/^[\w-]+$/.test(fileId)) return res.status(400).json({ error:"ID inválido" });
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers:{ Authorization:`Bearer ${token}` } });
      if (!r.ok) return res.status(r.status).json({ error:`Drive ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control","private, max-age=300");
      return res.status(200).send(buf);
    }

    // ── GET ?rutMap=1 ── mapa RazonSocial→RUT desde ZIPs Drive ──────────────
    if (req.method === "GET" && req.query.rutMap === "1") {
      const now = Date.now();
      if (_rutMapCache && (now - _rutMapCacheTs) < 3600000) {
        res.setHeader("Cache-Control","public, max-age=1800");
        return res.status(200).json({ ruts: _rutMapCache });
      }
      const ruts = {};
      try {
        const files = await driveFiles(token, FACT_FOLDER_ID);
        const zipFiles = files.filter(f => f.name.match(/\.zip$/i)).slice(0, 8);
        // Procesar de a uno para no saturar memoria/tiempo en Vercel
        for (const f of zipFiles) {
          try {
            const rz = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
              { headers:{ Authorization:`Bearer ${token}` } });
            if (!rz.ok) continue;
            const buf = await rz.arrayBuffer();
            const zip = await JSZip.loadAsync(buf);
            for (const name of Object.keys(zip.files)) {
              if (!name.match(/\.xml$/i)) continue;
              const xml = await zip.files[name].async("string");
              // RUT y RazonSocial del receptor (nuestro cliente)
              const rzn = (xml.match(/<RznSocRecep>([^<]+)<\/RznSocRecep>/) || [])[1];
              const rut = (xml.match(/<RUTRecep>([0-9][0-9.]*[-][0-9Kk])<\/RUTRecep>/) || [])[1];
              if (rzn && rut) {
                // Normalizar RUT al formato XX.XXX.XXX-X
                const rutClean = rut.trim().replace(/\./g,"");
                const [num, dv] = rutClean.split("-");
                const rutNorm = num ? num.replace(/\B(?=(\d{3})+(?!\d))/g,".")+"-"+(dv||"").toUpperCase() : rut.trim();
                if (!ruts[rzn.trim()]) ruts[rzn.trim()] = rutNorm;
              }
            }
          } catch(_) {}
        }
        _rutMapCache = ruts;
        _rutMapCacheTs = now;
      } catch(e) {
        if (!_rutMapCache) return res.status(503).json({ error:"Drive no disponible", ruts:{} });
      }
      res.setHeader("Cache-Control","public, max-age=1800");
      return res.status(200).json({ ruts: _rutMapCache || {} });
    }

    // ── GET ?resumen=1 ── resumen de ventas por cliente desde JSON embebido ──
    if (req.method === "GET" && req.query.resumen === "1") {
      if (!_EXCEL_EMBEDDED) {
        return res.status(503).json({ error: "JSON embebido no disponible" });
      }
      // Agregar totales por (cliente, periodo) sumando todos los sitios y tipos
      const clientMap = {};
      for (const [, periodos] of Object.entries(_EXCEL_EMBEDDED)) {
        for (const [periodo, clientes] of Object.entries(periodos)) {
          for (const [nombre, sitios] of Object.entries(clientes)) {
            if (!clientMap[nombre]) clientMap[nombre] = { nombre, meses: {}, total: 0 };
            let periodoTotal = 0;
            for (const tipos of Object.values(sitios)) {
              for (const factura of Object.values(tipos)) {
                periodoTotal += (factura.total || 0);
              }
            }
            if (periodoTotal > 0) {
              clientMap[nombre].meses[periodo] = (clientMap[nombre].meses[periodo] || 0) + periodoTotal;
              clientMap[nombre].total += periodoTotal;
            }
          }
        }
      }
      const clientes = Object.values(clientMap).sort((a, b) => b.total - a.total);
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json({ clientes });
    }

    // ── GET ?listPeriodos=1 ── períodos disponibles en carpeta facturación ─
    if (req.method === "GET" && req.query.listPeriodos === "1") {
      const periodoSet = new Set();

      // 1. Períodos del JSON embebido (siempre disponible, no depende de Drive)
      if (_EXCEL_EMBEDDED) {
        for (const anioKey of Object.keys(_EXCEL_EMBEDDED)) {
          for (const periodo of Object.keys(_EXCEL_EMBEDDED[anioKey] || {})) {
            periodoSet.add(periodo); // Ej: "Enero 2026"
          }
        }
      }

      // 2. Períodos de archivos ZIP en Drive (merge — agrega meses futuros no en JSON)
      try {
        const files = await driveFiles(token, FACT_FOLDER_ID);
        for (const f of files) {
          let anio, mesNum;
          // Formato 1: "2026-05.zip"
          const m1 = f.name.match(/^(\d{4})-(\d{2})\.zip$/i);
          if (m1) { anio = m1[1]; mesNum = m1[2]; }
          else {
            // Formato 2: "Facturas HTML_PISA_2026_05.zip" o "Facturas HTML_PISA_2026-05.zip"
            const m2 = f.name.match(/PISA[_-](\d{4})[_-](\d{2})\.zip$/i);
            if (m2) { anio = m2[1]; mesNum = m2[2]; }
          }
          if (anio && mesNum && MES_NOM[mesNum]) periodoSet.add(`${MES_NOM[mesNum]} ${anio}`);
        }
      } catch(_) { /* Drive no disponible — usamos solo períodos del JSON */ }

      const periodos = [...periodoSet].sort((a,b) => {
        const [ma,ya] = [a.split(" ")[0], a.split(" ")[1]];
        const [mb,yb] = [b.split(" ")[0], b.split(" ")[1]];
        return yb !== ya ? yb.localeCompare(ya) : (MES_NUM[mb]||"00").localeCompare(MES_NUM[ma]||"00");
      });
      return res.status(200).json({ periodos });
    }

    // ── GET ?cliente=X&periodo=Y ── facturas del cliente en el período ──────
    if (req.method === "GET" && req.query.cliente && req.query.periodo) {
      const { cliente, periodo, rut: rutQuery, debug, ufArr: ufArrQ, ufSrv: ufSrvQ, refresh, siteIdx: siteIdxQ, sitio: sitioQ } = req.query;
      const siteIdx = siteIdxQ != null ? parseInt(siteIdxQ) : null;
      const ufArr = ufArrQ ? parseFloat(ufArrQ) : 0;
      const ufSrv = ufSrvQ ? parseFloat(ufSrvQ) : 0;
      const [mesNom, anioStr] = periodo.split(" ");
      const mesNum = MES_NUM[mesNom];
      if (!mesNum) return res.status(400).json({ error:"Periodo inválido" });
      const dbg = debug === "1";
      const dbgInfo = {};
      if (dbg) dbgInfo.embeddedPath = _EXCEL_EMBEDDED_PATH || "(no cargado)";

      /* ── FUENTE 0: Excel pre-cargado (historial-excel-2026.json) ─────────────
         Fuente más confiable: datos directamente de Nubox sin parseo dinámico.
         Siempre corre primero — refresh solo aplica a FUENTE 2 (PDFs desde Drive).
      ── */
      {
        try {
          const excelData = await _loadExcelCache(token);
          if (dbg) dbgInfo.excel0_loaded = !!excelData;
          if (excelData) {
            if (dbg) dbgInfo.excel0_years = Object.keys(excelData);
            const periodoData = excelData[anioStr]?.[periodo];
            if (dbg) dbgInfo.excel0_hasPeriodo = !!periodoData;
            if (periodoData) {
              if (dbg) dbgInfo.excel0_clientes = Object.keys(periodoData).slice(0, 15);
              // 1. Buscar cliente: strip (solo alfanumérico, sin espacios ni puntos) → fuzzy
              // strip("NCH CHILE S A") = "nchchilesa" = strip("NCH Chile S.A.") → match exacto robusto
              // NFD + diacríticos eliminados para manejar acentos (Crédito = Credito)
              const strip = s => (s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
              const clienteNorm = strip(cliente);
              let clienteKey = Object.keys(periodoData).find(k => strip(k) === clienteNorm);
              if (!clienteKey)
                clienteKey = Object.keys(periodoData).find(k => clienteMatch(k, cliente));
              if (dbg) dbgInfo.excel0_clienteKey = clienteKey || null;
              if (dbg) dbgInfo.excel0_clienteNorm = clienteNorm;

              if (clienteKey) {
                const sitios = periodoData[clienteKey];
                if (dbg) dbgInfo.excel0_sitios = Object.keys(sitios);
                // 2. Elegir sitio: exacto → normalizado (sin guión) → único → match por UF
                const normS = s => (s||"").toUpperCase().replace(/-/g,"");
                let sitioData = null;
                if (sitioQ) {
                  // Primero exacto, luego normalizado (ej: "5-A" == "5A")
                  const sitioKey = sitios[sitioQ]
                    ? sitioQ
                    : Object.keys(sitios).find(k => normS(k) === normS(sitioQ));
                  if (sitioKey) sitioData = sitios[sitioKey];
                }
                if (!sitioData && Object.keys(sitios).length === 1) {
                  sitioData = Object.values(sitios)[0];
                } else if (!sitioData) {
                  // Multi-sitio sin sitioQ: buscar por UF más cercana
                  for (const d of Object.values(sitios)) {
                    const okArr = !(ufArr > 0) || !d.arriendo?.uf || Math.abs(d.arriendo.uf - ufArr) < 0.5;
                    const okSrv = !(ufSrv > 0) || !d.servAdm?.uf  || Math.abs(d.servAdm.uf  - ufSrv) < 0.5;
                    if (okArr && okSrv) { sitioData = d; break; }
                  }
                }
                if (dbg) dbgInfo.excel0_sitioData = sitioData;
                if (sitioData) {
                  const facturas = {};
                  if (sitioQ) {
                    // Lookup directo por sitio: devolver TODOS los tipos del JSON
                    // (arriendo, servAdm, habilitacion, servCont, asesoria, etc.)
                    Object.assign(facturas, sitioData);
                  } else {
                    // Sin sitio especificado: usar ufArr/ufSrv para desambiguar conceptos
                    if (ufArr > 0 && sitioData.arriendo) facturas.arriendo = sitioData.arriendo;
                    if (ufSrv > 0 && sitioData.servAdm)  facturas.servAdm  = sitioData.servAdm;
                  }
                  if (dbg) dbgInfo.excel0_facturas = facturas;
                  if (Object.keys(facturas).length > 0) {
                    if (dbg) dbgInfo.excelSource = { clienteKey, sitioQ };
                    return res.status(200).json({ facturas, source:"excel", ...(dbg?{dbg:dbgInfo}:{}) });
                  }
                }
              }
            }
          }
        } catch(e) { if (dbg) dbgInfo.excel0_error = e.message; }
      }

      /* ── rutNorm y driveFileList: necesarios para FUENTE XML y FUENTE 2 ── */
      const rutNorm = normRut(rutQuery);
      const driveFileList = await driveFiles(token, FACT_FOLDER_ID);

      /* ── Detectar ZIP XML para este período (tiene prioridad sobre FUENTE 1) ── */
      const xmlZipRe = new RegExp(`PISA[_-]${anioStr}[_-]${mesNum}\.zip$`, "i");
      const xmlZipFile = rutNorm ? driveFileList.find(f => xmlZipRe.test(f.name)) : null;
      if (dbg) dbgInfo.xmlZipFile = xmlZipFile?.name || null;

      /* ── FUENTE 1: historial JSON — solo si NO hay ZIP XML para este período ── */
      let savedFacturas = null; // guardamos si faltan totales para enriquecer con FUENTE 2
      if (PDF_FOLDER && !refresh && !xmlZipFile) {
        try {
          const histFileId = await findFile(token, HIST_NAME, PDF_FOLDER);
          if (histFileId) {
            const histText = await downloadFile(token, histFileId);
            if (histText) {
              const histData = JSON.parse(histText);
              const periodoData = histData[anioStr]?.[periodo];
              if (periodoData) {
                if (dbg) dbgInfo.jsonKeys = Object.keys(periodoData);
                // Buscar primero con sitio (ej: "Visibility S.A.:A-2"), luego sin él
                const sitioSuffix = sitioQ ? `:${sitioQ}` : "";
                const key = Object.keys(periodoData).find(k => clienteMatch(k, cliente + sitioSuffix))
                         || (!sitioSuffix ? undefined : Object.keys(periodoData).find(k => clienteMatch(k, cliente)));
                if (dbg) dbgInfo.jsonMatchedKey = key || null;
                if (key && Object.keys(periodoData[key]).length > 0) {
                  // Normalizar formato antiguo {tipo:"F-XXXXX"} → {tipo:{nro,uf,total}}
                  const raw = periodoData[key];
                  const facturas = Object.fromEntries(Object.entries(raw).map(([k,v])=>
                    [k, typeof v==="string" ? {nro:v,uf:null,total:null} : v]
                  ));
                  // Eliminar conceptos que la planilla indica que este sitio NO tiene.
                  // El JSON puede contener datos de varios sitios bajo la misma clave cliente.
                  if (!(ufArr > 0) && facturas.arriendo) delete facturas.arriendo;
                  if (!(ufSrv > 0) && facturas.servAdm)  delete facturas.servAdm;
                  // Eliminar conceptos cuyo UF difiere >0.5 del esperado (probable contaminación de otro sitio).
                  if (facturas.arriendo?.uf != null && ufArr > 0 && Math.abs(facturas.arriendo.uf - ufArr) > 0.5) delete facturas.arriendo;
                  if (facturas.servAdm?.uf  != null && ufSrv > 0 && Math.abs(facturas.servAdm.uf  - ufSrv) > 0.5) delete facturas.servAdm;
                  // Si todos los totales Y UFs están presentes, Y no falta ningún concepto esperado → retornar inmediato
                  const allComplete = Object.values(facturas).every(f => f.total != null && f.uf != null)
                    && !(ufArr > 0 && !facturas.arriendo)    // esperamos arriendo pero no está
                    && !(ufSrv > 0 && !facturas.servAdm);   // esperamos servAdm pero no está
                  if (allComplete) {
                    return res.status(200).json({ facturas, source:"json", ...(dbg?{dbg:dbgInfo}:{}) });
                  }
                  // Faltan totales, UFs, o conceptos esperados → continuar a FUENTE 2 para enriquecer
                  savedFacturas = facturas;
                }
              } else if (dbg) {
                dbgInfo.jsonKeys = null;
              }
            }
          }
        } catch(e) { if (dbg) dbgInfo.jsonError = e.message; }
      }

      /* ── FUENTE XML: ZIP con DTEs individuales — XML es siempre fresco, sin caché JSON ── */
      if (xmlZipFile && rutNorm) {
        {
          try {
            const xzRes = await fetch(
              `https://www.googleapis.com/drive/v3/files/${xmlZipFile.id}?alt=media`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (xzRes.ok) {
              const xmlZip = await JSZip.loadAsync(Buffer.from(await xzRes.arrayBuffer()));
              const xmlFiles = [];
              for (const [, entry] of Object.entries(xmlZip.files)) {
                if (entry.dir || !entry.name.toLowerCase().endsWith(".xml")) continue;
                xmlFiles.push({ content: await entry.async("text") });
              }
              const byTipo = _buildXmlFacturas(xmlFiles, rutNorm, sitioQ || null);
              if (dbg) dbgInfo.xmlByTipo = byTipo;
              const xmlFacturas = _resolveFacturas(byTipo, ufArr, ufSrv, siteIdx);
              if (dbg) dbgInfo.xmlFacturas = xmlFacturas;
              if (Object.keys(xmlFacturas).length > 0) {
                // Verificar si faltan conceptos esperados según planilla
                const xmlComplete = !(ufArr > 0 && !xmlFacturas.arriendo)
                                 && !(ufSrv > 0 && !xmlFacturas.servAdm);
                if (xmlComplete) {
                  return res.status(200).json({
                    facturas: xmlFacturas,
                    source: "xml",
                    ...(dbg ? { dbg: dbgInfo } : {})
                  });
                }
                // Faltan conceptos → continuar a FUENTE 2.6 para completar con ZIP individual
                savedFacturas = xmlFacturas;
              }
            }
          } catch(e) { if (dbg) dbgInfo.xmlError = e.message; }
        }
      }

      /* ── FUENTE 2: PDF consolidado Facturas_PISA_YYYY-MM.pdf — búsqueda por RUT ── */
      if (rutNorm) {
        const pdfPattern = new RegExp(`facturas_pisa_${anioStr}-${mesNum}\\.pdf`, "i");
        const pdfFile = driveFileList.find(f => pdfPattern.test(f.name));
        if (dbg) dbgInfo.consolidadoPDF = pdfFile?.name || null;

        if (pdfFile) {
          const pdfRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${pdfFile.id}?alt=media`,
            { headers:{ Authorization:`Bearer ${token}` } }
          );
          if (pdfRes.ok) {
            const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
            const text = extractText(pdfBuf);
            if (dbg) {
              dbgInfo.textSample = text.slice(0, 500);
              dbgInfo.rutNorm = rutNorm;
              // Muestra los primeros RUTs distintos encontrados en el PDF
              const allRuts = [...text.slice(0,3000).matchAll(/(?:\d{1,2}[.\s]\d{3}[.\s]\d{3}|\d{7,8})-[\dkK]/g)].map(m=>normRut(m[0]));
              dbgInfo.pdfRutsFound = [...new Set(allRuts)].slice(0,10);
            }
            // extractFacturasForRut ahora retorna arrays por tipo; _resolveFacturas selecciona
            // el candidato cuya UF sea más cercana al valor esperado del sitio (ufArr/ufSrv).
            const multiFacturas = extractFacturasForRut(text, rutNorm);
            const pdfFacturas = _resolveFacturas(multiFacturas, ufArr, ufSrv, siteIdx);
            if (dbg) dbgInfo.facturasByRut = pdfFacturas;
            if (Object.keys(pdfFacturas).length > 0) {
              let facturas;
              if (savedFacturas) {
                // Merge: nro del JSON (fiable), uf/total del PDF si faltan en JSON
                facturas = {};
                for (const [tipo, f] of Object.entries(savedFacturas)) {
                  const pdfF = pdfFacturas[tipo];
                  facturas[tipo] = { nro: f.nro, uf: f.uf ?? pdfF?.uf, total: f.total ?? pdfF?.total };
                }
                // Agregar tipos que el PDF encontró pero no están en el JSON
                for (const [tipo, pdfF] of Object.entries(pdfFacturas)) {
                  if (!facturas[tipo]) facturas[tipo] = pdfF;
                }
              } else {
                facturas = pdfFacturas;
              }
              /* ── FUENTE 2.5: ZIP individual para UF faltantes ── */
              const missingUF = Object.entries(facturas).filter(([,f]) => f.nro && f.uf == null);
              if (missingUF.length > 0) {
                const zipName25 = `${anioStr}-${mesNum}.zip`;
                const zipFile25 = driveFileList.find(f => f.name.toLowerCase() === zipName25.toLowerCase());
                if (zipFile25) {
                  try {
                    const zr = await fetch(
                      `https://www.googleapis.com/drive/v3/files/${zipFile25.id}?alt=media`,
                      { headers:{ Authorization:`Bearer ${token}` } }
                    );
                    if (zr.ok) {
                      const zip25 = await JSZip.loadAsync(Buffer.from(await zr.arrayBuffer()));
                      for (const [tipo, f] of missingUF) {
                        const numPart = f.nro.replace(/^F(?:EE)?-/i, "");
                        for (const [path, entry] of Object.entries(zip25.files)) {
                          if (entry.dir || !path.toLowerCase().endsWith(".pdf")) continue;
                          const fname = path.split("/").pop();
                          const nm = fname.match(/^(?:F(?:EE)?-)?(\d+)/i);
                          if (!nm || nm[1] !== numPart) continue;
                          const pdfText25 = extractText(Buffer.from(await entry.async("arraybuffer")));
                          const uf = _extractUF(pdfText25) ?? _derivarUFdePrecio(pdfText25, f.total);
                          if (uf != null) facturas[tipo] = { ...facturas[tipo], uf };
                          break;
                        }
                      }
                    }
                  } catch(_) {}
                }
              }
              // Eliminar conceptos no esperados según planilla (evita contaminación de caché)
              if (!(ufSrv > 0) && facturas.servAdm) delete facturas.servAdm;
              if (!(ufArr > 0) && facturas.arriendo) delete facturas.arriendo;
              // Si todavía faltan conceptos esperados o UFs, intentar FUENTE 2.6 antes de retornar
              const stillMissing2 = (ufArr > 0 && !facturas.arriendo)
                                 || (ufSrv > 0 && !facturas.servAdm)
                                 || (ufArr > 0 && facturas.arriendo?.uf == null)
                                 || (ufSrv > 0 && facturas.servAdm?.uf  == null);
              if (!stillMissing2) {
                if (refresh) _autoSaveHistorial(token, anioStr, periodo, sitioQ ? `${cliente}:${sitioQ}` : cliente, facturas, PDF_FOLDER).catch(()=>{});
                return res.status(200).json({ facturas, source: refresh ? "pdf_refreshed" : (savedFacturas ? "json+pdf" : "pdf_consolidado"), ...(dbg?{dbg:dbgInfo}:{}) });
              }
              savedFacturas = facturas; // incompleto → continuar a FUENTE 2.6
            }
          }
        }
      }

      // Si FUENTE 2 no dio resultado, intentar ZIP individual para UF faltantes
      // y también para conceptos esperados que no están en savedFacturas (FUENTE 2.6)
      if (savedFacturas) {
        const missingUF26 = Object.entries(savedFacturas).filter(([,f]) => f.nro && f.uf == null);
        // Conceptos que esperamos (por ufArr/ufSrv) pero ausentes en savedFacturas
        const missingConceptos26 = [];
        if (ufArr > 0 && !savedFacturas.arriendo) missingConceptos26.push("arriendo");
        if (ufSrv > 0 && !savedFacturas.servAdm)  missingConceptos26.push("servAdm");

        if (dbg) dbgInfo.missingConceptos26 = missingConceptos26;
        if (missingUF26.length > 0 || missingConceptos26.length > 0) {
          const zipName26 = `${anioStr}-${mesNum}.zip`;
          const zipFile26 = driveFileList.find(f => f.name.toLowerCase() === zipName26.toLowerCase());
          if (dbg) dbgInfo.zip26File = zipFile26?.name || null;
          if (zipFile26) {
            try {
              const zr26 = await fetch(
                `https://www.googleapis.com/drive/v3/files/${zipFile26.id}?alt=media`,
                { headers:{ Authorization:`Bearer ${token}` } }
              );
              if (zr26.ok) {
                const zip26 = await JSZip.loadAsync(Buffer.from(await zr26.arrayBuffer()));

                // Rellenar UFs faltantes para nros ya conocidos
                for (const [tipo, f] of missingUF26) {
                  const numPart = f.nro.replace(/^F(?:EE)?-/i, "");
                  for (const [path, entry] of Object.entries(zip26.files)) {
                    if (entry.dir || !path.toLowerCase().endsWith(".pdf")) continue;
                    const fname = path.split("/").pop();
                    const nm = fname.match(/^(?:F(?:EE)?-)?(\d+)/i);
                    if (!nm || nm[1] !== numPart) continue;
                    const pdfText26 = extractText(Buffer.from(await entry.async("arraybuffer")));
                    const uf26 = _extractUF(pdfText26) ?? _derivarUFdePrecio(pdfText26, f.total);
                    if (uf26 != null) savedFacturas[tipo] = { ...savedFacturas[tipo], uf: uf26 };
                    break;
                  }
                }

                // Buscar conceptos faltantes por nombre de cliente + tipo
                if (missingConceptos26.length > 0) {
                  const candidates26 = {};  // tipo → [{nro, uf, total}]
                  for (const [path, entry] of Object.entries(zip26.files)) {
                    if (entry.dir || !path.toLowerCase().endsWith(".pdf")) continue;
                    const fname = path.split("/").pop();
                    const nroMatch = fname.match(/^(F(?:EE)?)-(\d+)(?:\s+(.+))?\.pdf$/i);
                    if (!nroMatch) continue;
                    const [, prefix, nro, fileCliente] = nroMatch;
                    if (fileCliente && !clienteMatch(fileCliente, cliente)) continue;
                    const nroFull = `${prefix.toUpperCase()}-${nro}`;
                    const pdfTxt26m = extractText(Buffer.from(await entry.async("arraybuffer")));
                    const tipo26 = detectTipo(pdfTxt26m);
                    if (!tipo26 || !missingConceptos26.includes(tipo26)) continue;
                    const total26m = _extractTotal(pdfTxt26m);
                    const uf26m = _extractUF(pdfTxt26m) ?? _derivarUFdePrecio(pdfTxt26m, total26m);
                    if (!candidates26[tipo26]) candidates26[tipo26] = [];
                    candidates26[tipo26].push({ nro: nroFull, uf: uf26m, total: total26m });
                  }
                  // Seleccionar candidato más cercano por UF (clave para clientes multi-sitio)
                  if (dbg) dbgInfo.zip26Candidates = candidates26;
                  const UFExp26 = { arriendo: ufArr, servAdm: ufSrv };
                  for (const tipo26 of missingConceptos26) {
                    const picked26 = _pickByUF(candidates26[tipo26], UFExp26[tipo26], siteIdx);
                    if (picked26) savedFacturas[tipo26] = picked26;
                  }
                }
              }
            } catch(_) {}
          }
        }
        // Eliminar conceptos no esperados antes de devolver caché parcial
        if (!(ufSrv > 0) && savedFacturas.servAdm) delete savedFacturas.servAdm;
        if (!(ufArr > 0) && savedFacturas.arriendo) delete savedFacturas.arriendo;
        return res.status(200).json({ facturas: savedFacturas, source:"json", ...(dbg?{dbg:dbgInfo}:{}) });
      }

      /* ── FUENTE 3: ZIP individual (legado) ── */
      const zipName = `${anioStr}-${mesNum}.zip`;
      const zipFile = driveFileList.find(f => f.name.toLowerCase() === zipName.toLowerCase());
      if (!zipFile) return res.status(200).json({ facturas: null, source:"zip_missing", ...(dbg?{dbg:dbgInfo}:{}) });

      const zipRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
        { headers:{ Authorization:`Bearer ${token}` } }
      );
      if (!zipRes.ok) return res.status(200).json({ facturas: null, source:"zip_error", ...(dbg?{dbg:dbgInfo}:{}) });

      const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
      // Colectar todos los candidatos por tipo (igual que _buildXmlFacturas/extractFacturasForRut)
      // para que _resolveFacturas pueda desambiguar por UF y siteIdx entre sitios del mismo cliente.
      const multiFacturas3 = {};
      if (dbg) dbgInfo.zipFiles = [];

      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || !path.toLowerCase().endsWith(".pdf")) continue;
        const fname = path.split("/").pop();
        const nroMatch = fname.match(/^(F(?:EE)?)-(\d+)(?:\s+(.+))?\.pdf$/i);
        if (!nroMatch) continue;
        const [, prefix, nro, fileCliente] = nroMatch;
        const nroFull = `${prefix.toUpperCase()}-${nro}`;
        if (dbg) dbgInfo.zipFiles.push({ fname, fileCliente: fileCliente||null });

        if (fileCliente && !clienteMatch(fileCliente, cliente)) continue;

        const pdfBuf = Buffer.from(await entry.async("arraybuffer"));
        const text = extractText(pdfBuf);

        if (!fileCliente) {
          if (rutNorm) {
            const pdfRut = extractRutFromText(text);
            if (!pdfRut || normRut(pdfRut) !== rutNorm) continue;
          } else {
            const pdfCliente = extractClienteFromText(text);
            if (!pdfCliente || !clienteMatch(pdfCliente, cliente)) continue;
          }
        } else if (rutNorm) {
          // El nombre de archivo puede corresponder al edificio, no al cliente legal.
          // Si el PDF tiene un RUT distinto al esperado → rechazar (cliente equivocado).
          const pdfRut = extractRutFromText(text);
          if (pdfRut && normRut(pdfRut) !== rutNorm) continue;
        }

        const tipo = detectTipo(text);
        if (!tipo) continue;
        const totalZ = _extractTotal(text);
        const ufZ = _extractUF(text) ?? _derivarUFdePrecio(text, totalZ);
        if (dbg) { if (!dbgInfo.zip3Candidates) dbgInfo.zip3Candidates = {}; if (!dbgInfo.zip3Candidates[tipo]) dbgInfo.zip3Candidates[tipo] = []; dbgInfo.zip3Candidates[tipo].push({ nro: nroFull, uf: ufZ }); }
        if (!multiFacturas3[tipo]) multiFacturas3[tipo] = [];
        multiFacturas3[tipo].push({ nro: nroFull, uf: ufZ, total: totalZ });
      }

      // _resolveFacturas desambigua por UF/siteIdx y respeta ufArr=0/ufSrv=0 de planilla
      const facturas = _resolveFacturas(multiFacturas3, ufArr, ufSrv, siteIdx);
      const tiene = Object.keys(facturas).length > 0;
      return res.status(200).json({ facturas: tiene ? facturas : null, source:"zip", ...(dbg?{dbg:dbgInfo}:{}) });
    }

    // ── GET ?anio=YYYY ── devuelve historial JSON ─────────────────────────
    if (req.method === "GET") {
      if (!PDF_FOLDER) return res.status(200).json({});
      const fileId = await findFile(token, HIST_NAME, PDF_FOLDER);
      if (!fileId) return res.status(200).json({});
      const text = await downloadFile(token, fileId);
      const data = text ? JSON.parse(text) : {};
      const anio = req.query.anio;
      return res.status(200).json(anio ? (data[anio] || {}) : data);
    }

    // ── POST ── guarda/fusiona período ─────────────────────────────────────
    if (req.method === "POST") {
      const { anio, periodo, data: periodoData } = req.body || {};
      if (!anio || !periodo || !periodoData)
        return res.status(400).json({ error:"Se requiere anio, periodo y data" });
      if (!PDF_FOLDER)
        return res.status(500).json({ error:"DRIVE_PDF_FACTURAS_ID no configurada" });

      let historial = {};
      const fileId = await findFile(token, HIST_NAME, PDF_FOLDER);
      if (fileId) {
        const text = await downloadFile(token, fileId);
        if (text) historial = JSON.parse(text);
      }

      if (!historial[anio]) historial[anio] = {};
      historial[anio][periodo] = { ...(historial[anio][periodo] || {}), ...periodoData };

      const content = JSON.stringify(historial, null, 2);
      if (fileId) await updateJsonFile(token, fileId, content);
      else await createJsonFile(token, HIST_NAME, PDF_FOLDER, content);

      return res.status(200).json({ ok:true, anio, periodo, clientes: Object.keys(periodoData).length });
    }

    return res.status(405).json({ error:"Method not allowed" });
  } catch (e) {
    console.error("historial:", e.message);
    return res.status(500).json({ error: e.message });
  }
}

export {
  normRut, norm, clienteMatch, detectTipo,
  _pickByUF, _resolveFacturas,
  _buildXmlFacturas, parseXmlDTE,
  extractFacturasForRut, extractText,
  _extractUF, _extractTotal, _derivarUFdePrecio,
  extractClienteFromText, extractRutFromText,
  getToken, driveFiles, downloadFile, findFile, createJsonFile, updateJsonFile,
  FACT_FOLDER_ID,
};
