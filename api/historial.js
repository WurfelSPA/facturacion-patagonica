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

// ── Historial-cliente helpers ─────────────────────────────────────────────────
function norm(s){
  return (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g,"").trim();
}
function clienteMatch(fromFile, query) {
  const a=norm(fromFile), b=norm(query);
  if(!a||!b) return false;
  if(a===b||a.includes(b)||b.includes(a)) return true;
  return b.split(" ").filter(w=>w.length>3).some(w=>a.includes(w));
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

    // ── GET ?listPeriodos=1 ── períodos disponibles en carpeta facturación ─
    if (req.method === "GET" && req.query.listPeriodos === "1") {
      const files = await driveFiles(token, FACT_FOLDER_ID);
      const periodos = files
        .filter(f => /^\d{4}-\d{2}\.zip$/i.test(f.name))
        .sort((a,b) => b.name.localeCompare(a.name))
        .map(f => {
          const [anio, mesNum] = f.name.replace(/\.zip$/i,"").split("-");
          return MES_NOM[mesNum] ? `${MES_NOM[mesNum]} ${anio}` : null;
        })
        .filter(Boolean);
      return res.status(200).json({ periodos });
    }

    // ── GET ?cliente=X&periodo=Y ── facturas del cliente en el período ──────
    if (req.method === "GET" && req.query.cliente && req.query.periodo) {
      const { cliente, periodo } = req.query;
      const [mesNom, anioStr] = periodo.split(" ");
      const mesNum = MES_NUM[mesNom];
      if (!mesNum) return res.status(400).json({ error:"Periodo inválido" });

      /* ── FUENTE 1: historial JSON (instantáneo, confiable) ── */
      if (PDF_FOLDER) {
        try {
          const histFileId = await findFile(token, HIST_NAME, PDF_FOLDER);
          if (histFileId) {
            const histText = await downloadFile(token, histFileId);
            if (histText) {
              const histData = JSON.parse(histText);
              const periodoData = histData[anioStr]?.[periodo];
              if (periodoData) {
                const key = Object.keys(periodoData).find(k => clienteMatch(k, cliente));
                if (key && Object.keys(periodoData[key]).length > 0) {
                  return res.status(200).json({ facturas: periodoData[key], source:"json" });
                }
              }
            }
          }
        } catch {}  // si falla el JSON, continuar con ZIP fallback
      }

      /* ── FUENTE 2: ZIP fallback (parseo PDF) ── */
      const zipName = `${anioStr}-${mesNum}.zip`;
      const files = await driveFiles(token, FACT_FOLDER_ID);
      const zipFile = files.find(f => f.name.toLowerCase() === zipName.toLowerCase());
      if (!zipFile) return res.status(200).json({ facturas: null, source:"zip_missing" });

      const zipRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
        { headers:{ Authorization:`Bearer ${token}` } }
      );
      if (!zipRes.ok) return res.status(200).json({ facturas: null, source:"zip_error" });

      const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
      const facturas = {};

      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || !path.toLowerCase().endsWith(".pdf")) continue;
        const fname = path.split("/").pop();
        const nroMatch = fname.match(/^F-(\d+)(?:\s+(.+))?\.pdf$/i);
        if (!nroMatch) continue;
        const [, nro, fileCliente] = nroMatch;

        if (fileCliente && !clienteMatch(fileCliente, cliente)) continue;

        const pdfBuf = Buffer.from(await entry.async("arraybuffer"));
        const text = extractText(pdfBuf);

        if (!fileCliente) {
          const pdfCliente = extractClienteFromText(text);
          if (!pdfCliente || !clienteMatch(pdfCliente, cliente)) continue;
        }

        const tipo = detectTipo(text);
        if (tipo && !facturas[tipo]) facturas[tipo] = `F-${nro}`;
      }

      const tiene = Object.keys(facturas).length > 0;
      return res.status(200).json({ facturas: tiene ? facturas : null, source:"zip" });
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
