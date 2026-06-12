import JSZip from "jszip";

export const config = { api: { bodyParser: false, responseLimit: '15mb' } };

const FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";
const MES_NOM = {"01":"Enero","02":"Febrero","03":"Marzo","04":"Abril","05":"Mayo","06":"Junio","07":"Julio","08":"Agosto","09":"Septiembre","10":"Octubre","11":"Noviembre","12":"Diciembre"};

async function signJWT(payload, pk) {
  const header = { alg:"RS256", typ:"JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = pk.replace(/-----BEGIN PRIVATE KEY-----/,"").replace(/-----END PRIVATE KEY-----/,"").replace(/\s/g,"");
  const key = await crypto.subtle.importKey("pkcs8",Uint8Array.from(atob(pem),c=>c.charCodeAt(0)).buffer,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(input));
  return `${input}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}`;
}

async function getToken(sa) {
  const now = Math.floor(Date.now()/1000);
  const jwt = await signJWT({iss:sa.client_email,scope:"https://www.googleapis.com/auth/drive.readonly",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600},sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`});
  const d = await r.json();
  if (!d.access_token) throw new Error("Token: "+JSON.stringify(d));
  return d.access_token;
}

/* ── PDF text extraction (same CMap approach as split-pdf.js) ─────────────── */
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
        const code=parseInt(src,16),bytes=Buffer.from(dst,"hex");
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
  const re=/stream\r?\n([\s\S]*?)endstream/g;
  let match;
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
    for(const [,h] of d.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)){const code=parseInt(h,16);text+=mapping[code]!==undefined?mapping[code]:(code>=32&&code<127?String.fromCharCode(code):" ");}
    for(const [,arr] of d.matchAll(/\[([^\]]+)\]\s*TJ/g)) for(const [,h] of arr.matchAll(/<([0-9a-fA-F]+)>/g)){const code=parseInt(h,16);text+=mapping[code]!==undefined?mapping[code]:(code>=32&&code<127?String.fromCharCode(code):" ");}
    for(const [,s] of d.matchAll(/\(([^)]*)\)\s*Tj/g)) text+=s.replace(/\\n/g," ")+" ";
    for(const [,arr] of d.matchAll(/\[([^\]]*)\]\s*TJ/g)){for(const [,s] of arr.matchAll(/\(([^)]*)\)/g)) text+=s.replace(/\\n/g," ");text+=" ";}
  }
  return text.replace(/\s+/g," ").trim();
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function norm(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g,"").trim(); }

function clienteMatch(fromFile, query) {
  const a=norm(fromFile), b=norm(query);
  if(!a||!b) return false;
  if(a===b||a.includes(b)||b.includes(a)) return true;
  // al menos 1 palabra significativa (>3 chars) en común
  return b.split(" ").filter(w=>w.length>3).some(w=>a.includes(w));
}

function detectTipo(text) {
  const t=(text||"").replace(/\s+/g," ");
  if(/Habilitaci/i.test(t)) return "habilitacion";
  if(/Serv\.?\s*Adm\./i.test(t)) return "servAdm";
  if(/Arriendo/i.test(t)) return "arriendo";
  return null;
}

function extractClienteFromText(text) {
  const m=text.match(/Se[ñn]or\(es\)\s*(.+?)\s*RUT\s*[\d]/);
  return m?m[1].trim().replace(/\s+/g," ").slice(0,40):null;
}

/* ── Handler ────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="GET") return res.status(405).json({error:"Method not allowed"});

  const saJson=process.env.GOOGLE_SERVICE_ACCOUNT;
  if(!saJson) return res.status(500).json({error:"Sin credenciales"});

  const { cliente, periodo, listPeriodos } = req.query;

  try {
    const sa=JSON.parse(saJson);
    const token=await getToken(sa);

    // Listar carpeta Drive
    const q=`'${FOLDER_ID}' in parents and trashed=false`;
    const lr=await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`,{headers:{Authorization:`Bearer ${token}`}});
    const {files=[]}=await lr.json();

    // ZIPs nombrados YYYY-MM.zip, más recientes primero
    const zips=files
      .filter(f=>/^\d{4}-\d{2}\.zip$/i.test(f.name))
      .sort((a,b)=>b.name.localeCompare(a.name));

    /* ── Modo: listar períodos disponibles ─────────────────────────────── */
    if(listPeriodos==="1"){
      const periodos=zips.map(f=>{
        const [anio,mesNum]=f.name.replace(/\.zip$/i,"").split("-");
        return MES_NOM[mesNum]?`${MES_NOM[mesNum]} ${anio}`:null;
      }).filter(Boolean);
      return res.status(200).json({periodos});
    }

    /* ── Modo: buscar facturas de un cliente en un período ────────────── */
    if(!cliente||!periodo) return res.status(400).json({error:"Faltan parámetros cliente y periodo"});

    const [,mesNum]=(()=>{
      const [mesNom,anio]=(periodo||"").split(" ");
      const map={"Enero":"01","Febrero":"02","Marzo":"03","Abril":"04","Mayo":"05","Junio":"06","Julio":"07","Agosto":"08","Septiembre":"09","Octubre":"10","Noviembre":"11","Diciembre":"12"};
      return [`${anio}-${map[mesNom]||"00"}`,map[mesNom]||"00"];
    })();

    const [anioStr]=periodo.split(" ");
    const zipName=`${anioStr}-${mesNum}.zip`;
    const zipFile=zips.find(f=>f.name.toLowerCase()===zipName.toLowerCase());
    if(!zipFile) return res.status(200).json({facturas:null,msg:"ZIP no encontrado para "+periodo});

    const zipRes=await fetch(`https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,{headers:{Authorization:`Bearer ${token}`}});
    if(!zipRes.ok) return res.status(200).json({facturas:null,msg:"No se pudo descargar ZIP"});

    const zip=await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
    const facturas={};

    for(const [path,entry] of Object.entries(zip.files)){
      if(entry.dir||!path.toLowerCase().endsWith(".pdf")) continue;
      const fname=path.split("/").pop();

      // Nombre: "F-14633 Nombre Cliente.pdf" o "F-14633.pdf"
      const nroMatch=fname.match(/^F-(\d+)(?:\s+(.+))?\.pdf$/i);
      if(!nroMatch) continue;
      const [,nro,fileCliente]=nroMatch;

      // Intentar match por nombre en filename primero (más rápido)
      if(fileCliente&&!clienteMatch(fileCliente,cliente)) continue;

      const pdfBuf=Buffer.from(await entry.async("arraybuffer"));
      const text=extractText(pdfBuf);

      // Si filename no tenía nombre, verificar por texto del PDF
      if(!fileCliente){
        const pdfCliente=extractClienteFromText(text);
        if(!pdfCliente||!clienteMatch(pdfCliente,cliente)) continue;
      }

      const tipo=detectTipo(text);
      if(tipo&&!facturas[tipo]) facturas[tipo]=`F-${nro}`;
    }

    const tiene=Object.keys(facturas).length>0;
    return res.status(200).json({facturas:tiene?facturas:null});

  } catch(e){
    return res.status(500).json({error:e.message,stack:e.stack?.slice(0,300)});
  }
}
