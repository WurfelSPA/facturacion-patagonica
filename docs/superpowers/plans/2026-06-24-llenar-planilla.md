# Llenar Planilla — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app planilla fill editor: users enter UF and GC values per client/building row without leaving the portal; data persists as JSON in Google Drive.

**Architecture:** Extend `api/planilla.js` with two new actions (load-fill, save-fill) that read/write a single `planilla-fills.json` keyed by periodo. Add a `LlenarPlanillaView` React component to `index.html`. Restructure the button layout in the upload view to match the mockup. Fill data is stored by composite key `Sitio|Edificio|RUT|Cliente`.

**Tech Stack:** SheetJS (XLSX, already loaded), React (h/useState/useEffect, no JSX), Vercel serverless (api/planilla.js extended), Google Drive API via Service Account PATCH.

---

### Task 1: Create planilla-fills.json in Drive + env var

**Files:**
- Create: `planilla-fills.json` (empty file, uploaded manually to Drive)

- [ ] **Step 1: Generate empty fills file**

```bash
echo '{}' > /tmp/planilla-fills.json
```

- [ ] **Step 2: Upload to Drive**

User: open Drive folder `1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u` → New → Upload file → select `planilla-fills.json` → right-click → Get link → copy file ID.

- [ ] **Step 3: Add env var to Vercel**

Vercel Dashboard → project → Settings → Environment Variables → add:
- Name: `DRIVE_PLANILLA_FILL_ID`
- Value: `<file ID from Drive>`

---

### Task 2: Extend api/planilla.js with fill actions

**Files:**
- Modify: `api/planilla.js` (add helpers + two new route branches)

- [ ] **Step 1: Add FILL_FILE_ID constant and helpers after existing constants**

After `const HC_COL_DEFAULT = ...` line, insert:

```javascript
const FILL_FILE_ID = process.env.DRIVE_PLANILLA_FILL_ID;

async function downloadFillData(token) {
  if (!FILL_FILE_ID) return {};
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${FILL_FILE_ID}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return {};
  try { return await r.json(); } catch { return {}; }
}

async function uploadFillData(token, data) {
  if (!FILL_FILE_ID) throw new Error('DRIVE_PLANILLA_FILL_ID no configurado');
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${FILL_FILE_ID}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data, null, 2)
  });
  if (!r.ok) throw new Error(`Drive fill upload ${r.status}: ${(await r.text()).slice(0,200)}`);
}
```

- [ ] **Step 2: Add route branches BEFORE the existing POST check**

In the handler, before `if (req.method === "POST") {`, insert:

```javascript
// ── GET ?action=load-fill ─────────────────────────────────────────────────
if (req.method === "GET" && req.query.action === "load-fill") {
  const { periodo } = req.query;
  if (!periodo) return res.status(400).json({ error: "Se requiere periodo" });
  try {
    const token = await getAccessToken(sa);
    const allData = await downloadFillData(token);
    return res.status(200).json({ values: allData[periodo]?.values || {} });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── POST ?action=save-fill ────────────────────────────────────────────────
if (req.method === "POST" && req.query.action === "save-fill") {
  const { periodo, values } = req.body || {};
  if (!periodo || !values) return res.status(400).json({ error: "Se requiere periodo y values" });
  try {
    const token = await getAccessToken(sa);
    const allData = await downloadFillData(token);
    allData[periodo] = { savedAt: new Date().toISOString(), values };
    await uploadFillData(token, allData);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
```

- [ ] **Step 3: Verify syntax**

```bash
node --input-type=module < api/planilla.js
```
Expected: no output (no errors).

- [ ] **Step 4: Commit**

```bash
git add api/planilla.js
git commit -m "feat: add load-fill and save-fill actions to api/planilla"
```

---

### Task 3: Restructure buttons in index.html (view==="upload")

**Files:**
- Modify: `index.html` (view==="upload" section, ~line 3992)

Column indices in the planilla (0-indexed in XLSX.js array):
- idx 1 (B) = Sitios
- idx 2 (C) = Edificios
- idx 3 (D) = RUT
- idx 5 (F) = Nombre Cliente
- month col = found by date search in row 2 (0-indexed) starting at i=50
- GC col = month col + 1

- [ ] **Step 1: Replace the "Enviar Planilla" button and add "Llenar Planilla"**

Find the existing button block (around line 3996):
```javascript
files.planilla&&h("button",{
  style:{fontSize:13,fontWeight:600,padding:"8px 20px",borderRadius:10,border:"1px solid var(--bdr)",
    background:"var(--surf)",color:"var(--txm)",cursor:"pointer",display:"flex",alignItems:"center",gap:6,
    fontFamily:"'DM Sans',sans-serif"},
  onClick:async()=>{
```

Replace the entire button block (from `files.planilla&&h("button"` through the closing `},"📧 Enviar Planilla "+periodo),`) with:

```javascript
h("div",{style:{display:"flex",gap:10,justifyContent:"center"}},
  h("button",{
    style:{fontSize:12,fontWeight:600,padding:"7px 16px",borderRadius:20,border:"1px solid var(--bdr)",
      background:"var(--surf)",color:"var(--txm)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,
      fontFamily:"'DM Sans',sans-serif"},
    onClick:()=>setView("llenar")
  },"● Llenar Planilla "+periodo),
  files.planilla&&h("button",{
    style:{fontSize:12,fontWeight:600,padding:"7px 16px",borderRadius:20,border:"1px solid var(--bdr)",
      background:"var(--surf)",color:"var(--txm)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,
      fontFamily:"'DM Sans',sans-serif"},
    onClick:async()=>{
      try{
        const token=await getToken();
        notify("Leyendo comentarios de la planilla...","info");
        const grupos=await extraerComentariosMes(files.planilla,periodo);
        const sitiosConComentarios=Object.keys(grupos).filter(s=>grupos[s].length>0);
        let bodyHtml=`<p>Estimados,</p><p>Adjunto planilla facturación <strong>${periodo}</strong></p>`;
        if(sitiosConComentarios.length===0){
          bodyHtml+=`<p>Sin comentarios especiales para este período.</p>`;
        } else {
          for(const sitio of sitiosConComentarios){
            bodyHtml+=`<p><strong>Sitio ${sitio}</strong></p><ul>`;
            for(const {edif,cliente,comentario} of grupos[sitio]){
              bodyHtml+=`<li><strong>${cliente}</strong>${edif?` ${edif}`:""}:&nbsp;${comentario}</li>`;
            }
            bodyHtml+=`</ul>`;
          }
        }
        bodyHtml+=`<br><p>Quedo atento a sus comentarios</p><p>Saludos</p>`;
        bodyHtml+=`<br><hr><p style="color:#999;font-size:11px">Este correo fue generado automáticamente con apoyo de inteligencia artificial — Sistema de Facturación Patagónica Inmobiliaria SpA</p>`;
        const planBuf=await readFileAsBuffer(files.planilla);
        const planBytes=new Uint8Array(planBuf);
        let binary="";
        for(let i=0;i<planBytes.length;i+=8192) binary+=String.fromCharCode(...planBytes.subarray(i,i+8192));
        const planB64=btoa(binary);
        const planNombre=`Planilla Facturación ${periodo}.xlsx`;
        const subject=`Facturación ${periodo}`;
        const TO="bpulgar@patagonica.cl,contabilidad@patagonica.cl";
        const CC="mmunoz@patagonica.cl,alagies@patagonica.cl";
        await sendGmail(token,TO,CC,REMITENTE,subject,bodyHtml,planB64,planNombre,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        notify(`✓ Planilla ${periodo} enviada`,"ok");
      }catch(e){notify("Error: "+e.message,"err");}
    }
  },"● Subir Planilla "+periodo)
),
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: restructure facturacion buttons layout"
```

---

### Task 4: Add LlenarPlanillaView component + wire view

**Files:**
- Modify: `index.html` (add component before ChangePwdModal, wire into render)

- [ ] **Step 1: Add LlenarPlanillaView component**

Before `function ChangePwdModal(){` insert the full component:

```javascript
function LlenarPlanillaView({periodo,planillaFile,onBack}){
  var rowsS=React.useState([]); var setRows=rowsS[1]; var rows=rowsS[0];
  var editsS=React.useState({}); var setEdits=editsS[1]; var edits=editsS[0];
  var loadingS=React.useState(true); var setLoading=loadingS[1]; var loading=loadingS[0];
  var savingS=React.useState(false); var setSaving=savingS[1]; var saving=savingS[0];
  var msgS=React.useState(null); var setMsg=msgS[1]; var msg=msgS[0];

  React.useEffect(function(){
    if(!planillaFile)return;
    var cancelled=false;
    async function load(){
      setLoading(true);
      var buf=await readFileAsBuffer(planillaFile);
      var wb=XLSX.read(buf,{type:"array",cellDates:true,raw:true});
      var ws=wb.Sheets["Flujo"];
      if(!ws){setLoading(false);return;}
      var raw=XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});
      var fila3=raw[2]||[];
      var mesNum=MES_NUM[periodo.split(" ")[0]];
      var anio=parseInt(periodo.split(" ")[1]);
      var colMes=-1;
      function esTargetMes(val){
        if(!val)return false;
        if(typeof val==="number"&&val>40000&&val<60000){
          var d=new Date(new Date(Date.UTC(1899,11,30)).getTime()+Math.round(val)*86400000);
          return d.getUTCFullYear()===anio&&(d.getUTCMonth()+1)===mesNum;
        }
        if(val instanceof Date)return val.getFullYear()===anio&&(val.getMonth()+1)===mesNum;
        return false;
      }
      for(var i=50;i<fila3.length;i++){if(esTargetMes(fila3[i])){colMes=i;break;}}
      var colGC=colMes+1;
      var EXCL=["","VACANTE","Nombre Cliente","Areas Comunes Edificio","Areas comunes Edificio (Subterraneos)","Area Comun"];
      var parsed=[];
      for(var ri=4;ri<raw.length;ri++){
        var row=raw[ri];if(!row)continue;
        var cliente=row[5];
        if(!cliente||EXCL.includes(String(cliente).trim()))continue;
        var sitio=String(row[1]||"").trim();
        var edificio=String(row[2]||"").trim();
        var rut=String(row[3]||"").trim();
        var clienteStr=String(cliente).trim();
        var key=sitio+"|"+edificio+"|"+rut+"|"+clienteStr;
        var uf=colMes>=0?(row[colMes]||0):0;
        var gc=colGC>=0?(row[colGC]||0):0;
        parsed.push({key,sitio,edificio,rut,cliente:clienteStr,uf,gc});
      }
      if(!cancelled)setRows(parsed);
      try{
        var r=await fetch("/api/planilla?action=load-fill&periodo="+encodeURIComponent(periodo));
        if(r.ok){var d=await r.json();if(d.values&&!cancelled)setEdits(d.values);}
      }catch(e){}
      if(!cancelled)setLoading(false);
    }
    load();
    return function(){cancelled=true;};
  },[planillaFile,periodo]);

  function setEdit(key,field,val){
    setEdits(function(prev){
      var next=Object.assign({},prev);
      next[key]=Object.assign({},prev[key]||{});
      next[key][field]=val;
      return next;
    });
  }

  async function save(){
    setSaving(true);setMsg(null);
    var values={};
    rows.forEach(function(row){
      var e=edits[row.key]||{};
      var uf=e.uf!==undefined?parseFloat(e.uf)||0:parseFloat(row.uf)||0;
      var gc=e.gc!==undefined?parseFloat(e.gc)||0:parseFloat(row.gc)||0;
      if(uf||gc)values[row.key]={uf,gc};
    });
    try{
      var r=await fetch("/api/planilla?action=save-fill",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({periodo,values})
      });
      var d=await r.json();
      if(d.ok)setMsg({type:"ok",text:"✓ Guardado correctamente"});
      else setMsg({type:"err",text:d.error||"Error al guardar"});
    }catch(e){setMsg({type:"err",text:"Error de conexión"});}
    setSaving(false);
  }

  var thBase={textAlign:"left",padding:"8px 10px",borderBottom:"2px solid var(--bdr)",fontWeight:700,fontSize:11,whiteSpace:"nowrap"};
  var tdBase={padding:"5px 8px",borderBottom:"1px solid var(--bdr)",fontSize:12};
  var inputStyle={width:80,textAlign:"right",padding:"3px 6px",border:"1px solid var(--bdr)",borderRadius:4,
    background:"var(--surf)",color:"var(--tx)",fontSize:12,fontFamily:"'DM Mono',monospace"};
  var mesLabel=(periodo.split(" ")[0]||"").substring(0,3).toUpperCase()+" UF";

  if(loading)return h("main",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}},
    h("span",{style:{color:"var(--txm)",fontSize:13}},"Cargando planilla..."));

  return h("main",{style:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}},
    h("div",{style:{display:"flex",alignItems:"center",gap:12,padding:"16px 28px",borderBottom:"1px solid var(--bdr)",flexShrink:0}},
      h("button",{onClick:onBack,style:{background:"none",border:"none",cursor:"pointer",color:"var(--txm)",fontSize:20,lineHeight:1}},"←"),
      h("span",{style:{fontWeight:700,fontSize:15}},"Llenar Planilla — "+periodo),
      h("div",{style:{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}},
        msg&&h("span",{style:{fontSize:12,color:msg.type==="ok"?"var(--green)":"var(--red)"}},(msg.text)),
        h("button",{onClick:onBack,style:{fontSize:12,padding:"6px 14px",borderRadius:8,border:"1px solid var(--bdr)",background:"var(--surf2)",color:"var(--txm)",cursor:"pointer"}},"Cancelar"),
        h("button",{onClick:save,disabled:saving,className:"btn-primary",style:{fontSize:12,padding:"6px 18px",opacity:saving?0.6:1}},saving?"Guardando...":"Guardar")
      )
    ),
    h("div",{style:{flex:1,overflowY:"auto",overflowX:"auto",padding:"0 0 24px"}},
      h("table",{style:{width:"100%",borderCollapse:"collapse"}},
        h("thead",null,
          h("tr",null,
            h("th",{style:{...thBase,background:"var(--surf2)",color:"var(--txm)"}},"Sitio"),
            h("th",{style:{...thBase,background:"var(--surf2)",color:"var(--txm)"}},"Edificio"),
            h("th",{style:{...thBase,background:"var(--surf2)",color:"var(--txm)"}},"RUT"),
            h("th",{style:{...thBase,background:"var(--surf2)",color:"var(--txm)",minWidth:180}},"Nombre Cliente"),
            h("th",{style:{...thBase,background:"var(--acc)",color:"#fff",textAlign:"right"}},mesLabel),
            h("th",{style:{...thBase,background:"var(--acc)",color:"#fff",textAlign:"right"}},"GC UF")
          )
        ),
        h("tbody",null,
          rows.map(function(row,i){
            var e=edits[row.key]||{};
            var ufVal=e.uf!==undefined?e.uf:(row.uf||"");
            var gcVal=e.gc!==undefined?e.gc:(row.gc||"");
            return h("tr",{key:row.key,style:{background:i%2===0?"var(--surf)":"var(--surf2)"}},
              h("td",{style:tdBase},row.sitio),
              h("td",{style:tdBase},row.edificio),
              h("td",{style:{...tdBase,fontFamily:"'DM Mono',monospace",fontSize:11}},row.rut),
              h("td",{style:{...tdBase,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},row.cliente),
              h("td",{style:{...tdBase,padding:"3px 6px"}},
                h("input",{type:"number",step:"0.01",min:"0",value:ufVal,
                  onChange:function(ev){setEdit(row.key,"uf",ev.target.value);},
                  style:inputStyle})
              ),
              h("td",{style:{...tdBase,padding:"3px 6px"}},
                h("input",{type:"number",step:"0.01",min:"0",value:gcVal,
                  onChange:function(ev){setEdit(row.key,"gc",ev.target.value);},
                  style:inputStyle})
              )
            );
          })
        )
      )
    )
  );
}
```

- [ ] **Step 2: Wire the view into the render function**

In the main App render, find:
```javascript
view==="upload"&&h("main",
```

Before it, add:
```javascript
view==="llenar"&&h(LlenarPlanillaView,{periodo,planillaFile:files.planilla,onBack:()=>setView("upload")}),
```

- [ ] **Step 3: Verify syntax (open in browser, check console)**

Deploy and navigate to Facturación → click "Llenar Planilla" → verify grid loads.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add LlenarPlanillaView grid component"
```

---

### Task 5: Create planilla-fills.json + configure env var

> One-time setup run by the user.

- [ ] Upload `planilla-fills.json` (contents: `{}`) to the Drive folder
- [ ] Copy its file ID from the Drive link
- [ ] Add `DRIVE_PLANILLA_FILL_ID=<id>` in Vercel → Settings → Environment Variables
- [ ] Redeploy from Vercel dashboard

