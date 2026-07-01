/**
 * /api/storage  — fusión de /api/zip + /api/drive
 *
 * GET  ?periodo=Mes YYYY          → descarga ZIP del mes desde Drive
 * GET  ?buscarPdf=nombre&folderId → busca PDF por nombre en Drive
 * GET  ?ls=folderId               → delegar a historial (no usado aquí)
 * POST { action:"upload-url", filename, mimeType, folderId }
 *      → crea sesión resumible Drive, devuelve { uploadUrl }
 * POST { action:"upload", base64, filename, mimeType, folderId }
 *      → sube archivo pequeño via Service Account
 */

export const config = { api: { bodyParser: { sizeLimit: '20mb' }, responseLimit: '50mb' } };

const FACTURACION_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NUM = {
  "Enero":"01","Febrero":"02","Marzo":"03","Abril":"04",
  "Mayo":"05","Junio":"06","Julio":"07","Agosto":"08",
  "Septiembre":"09","Octubre":"10","Noviembre":"11","Diciembre":"12"
};

// ── JWT / Service Account ────────────────────────────────────────────────────
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

async function getSAToken(scope = "https://www.googleapis.com/auth/drive") {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT(
    { iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 },
    sa.private_key
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("SA token error: " + JSON.stringify(data));
  return data.access_token;
}

async function driveList(token, folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error("Drive list error: " + JSON.stringify(data));
  return data.files || [];
}

// ── Handler GET (ex /api/zip) ────────────────────────────────────────────────
async function handleGet(req, res) {
  // Modo búsqueda de PDF por nombre
  if (req.query.buscarPdf) {
    const pdfName = req.query.buscarPdf;
    const folderId = req.query.folderId || FACTURACION_FOLDER_ID;
    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
    try {
      const sa = JSON.parse(saJson);
      const tok = await getSAToken("https://www.googleapis.com/auth/drive.readonly");
      const q = `name='${pdfName}' and '${folderId}' in parents and trashed=false`;
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`, { headers: { Authorization: `Bearer ${tok}` } });
      const d = await r.json();
      const found = d.files && d.files.length > 0 ? d.files[0].id : null;
      return res.status(200).json({ pdfFileId: found });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Descarga ZIP del período
  const periodo = req.query.periodo;
  if (!periodo) return res.status(400).json({ error: "Falta parametro periodo" });

  const parts = periodo.split(" ");
  const mesNombre = parts[0];
  const anio = parts[1];
  const mesNum = MES_NUM[mesNombre];
  if (!mesNum || !anio) return res.status(400).json({ error: "Periodo invalido: " + periodo });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });

  try {
    const sa = JSON.parse(saJson);
    const token = await getSAToken("https://www.googleapis.com/auth/drive.readonly");
    const files = await driveList(token, FACTURACION_FOLDER_ID);

    // 1. Buscar ZIP: "2026-05.zip"
    const zipName = `${anio}-${mesNum}.zip`;
    const zipFile = files.find(f => f.name.toLowerCase() === zipName.toLowerCase());

    // Modo ?check=1 — sólo verificar existencia, sin descargar el ZIP
    if (req.query.check) {
      if (!zipFile) return res.status(404).json({ error: `ZIP ${zipName} no encontrado` });
      const sizeMB = zipFile.size ? Math.round(parseInt(zipFile.size) / 1024 / 1024) : null;
      return res.status(200).json({ zipName, fileId: zipFile.id, sizeMB, exists: true });
    }

    if (zipFile) {
      // Guard: no intentar descargar ZIPs grandes (causan timeout en Vercel).
      // Si Drive no devuelve size (null/undefined), tratar como grande (999 MB)
      // para evitar intentar descargar un ZIP de tamaño desconocido.
      const rawSize = zipFile.size ? parseInt(zipFile.size) : null;
      const zipSizeMB = rawSize !== null ? Math.round(rawSize / 1024 / 1024) : 999;
      if (zipSizeMB > 30) {
        // ZIP existe pero es demasiado grande (o tamaño desconocido) — informar al frontend
        return res.status(404).json({
          error: "zip_too_large",
          zipName, zipFileId: zipFile.id, zipSizeMB: rawSize !== null ? zipSizeMB : null,
          canGenerate: true,
          pdfMaestroId: null,
          mensaje: `ZIP ${zipName} existe en Drive — los PDFs individuales estarán disponibles después de re-separar`
        });
      }
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!driveRes.ok) {
        const txt = await driveRes.text();
        return res.status(driveRes.status).json({ error: `Drive ${driveRes.status}: ${txt.slice(0,200)}` });
      }
      const buffer = await driveRes.arrayBuffer();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Length", buffer.byteLength);
      return res.status(200).send(Buffer.from(buffer));
    }

    // 2. ZIP no existe — buscar PDF maestro del mes
    // Acepta: "Facturas_PISA_2026-06.pdf" (por número) O "Facturas_PISA_Junio_2026.pdf" (por nombre)
    const pdfMaestro = files.find(f => {
      const n = f.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
      const mes = mesNombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
      const mesNumPadded = mesNum; // ya es "06", "05", etc.
      return n.endsWith(".pdf") && n.includes("pisa") && (
        n.includes(mes) ||                                  // "junio"
        n.includes(`${anio}-${mesNumPadded}`) ||            // "2026-06"
        n.includes(`_${mesNumPadded}_`) ||                  // "_06_"
        n.includes(`${mesNumPadded}-${anio}`)               // "06-2026"
      );
    });

    if (pdfMaestro) {
      return res.status(404).json({
        error: "no_zip",
        pdfMaestroId: pdfMaestro.id,
        pdfMaestroNombre: pdfMaestro.name,
        canGenerate: true,
        mensaje: `No existe ${zipName} pero hay un PDF maestro disponible para generar.`
      });
    }

    return res.status(404).json({
      error: "no_zip",
      canGenerate: false,
      mensaje: `No existe ${zipName} ni PDF maestro para ${mesNombre} ${anio} en Drive.`
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Handler POST (ex /api/drive) ─────────────────────────────────────────────
async function handlePost(req, res) {
  const { action, filename, mimeType, folderId, base64 } = req.body || {};

  // Acción: expandir ZIP existente a archivos individuales en Drive
  if (action === 'expand-zip') {
    const { periodo } = req.body || {};
    if (!periodo) return res.status(400).json({ error: 'Falta periodo' });
    const parts = periodo.split(" ");
    const mesNombre = parts[0];
    const anio = parts[1];
    const mesNum = MES_NUM[mesNombre];
    if (!mesNum || !anio) return res.status(400).json({ error: 'Periodo invalido' });
    const zipName = `${anio}-${mesNum}.zip`;
    try {
      const token = await getSAToken();
      // Buscar ZIP
      const files = await driveList(token, FACTURACION_FOLDER_ID);
      const zipFile = files.find(f => f.name.toLowerCase() === zipName.toLowerCase());
      if (!zipFile) return res.status(404).json({ error: `ZIP ${zipName} no encontrado` });
      // Verificar tamaño (no bajar ZIPs > 80MB)
      const sizeMB = zipFile.size ? Math.round(parseInt(zipFile.size) / 1024 / 1024) : 0;
      if (sizeMB > 80) return res.status(400).json({ error: `ZIP demasiado grande (${sizeMB}MB). Re-separar primero.` });
      // Descargar ZIP
      const zipRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!zipRes.ok) return res.status(502).json({ error: `Error descargando ZIP: ${zipRes.status}` });
      const zipBuf = Buffer.from(await zipRes.arrayBuffer());
      // Extraer y subir PDFs individuales
      const JSZipLib = (await import('jszip')).default;
      const zip = await JSZipLib.loadAsync(zipBuf);
      let uploaded = 0, skipped = 0;
      const errors = [];
      const uploadTasks = [];
      zip.forEach((path, entry) => {
        if (entry.dir) return;
        const fname = path.split('/').pop();
        if (!fname.endsWith('.pdf') || !fname.startsWith('F-')) { skipped++; return; }
        uploadTasks.push({ fname, entry });
      });
      // Lotes de 5
      const BATCH = 5;
      for (let b = 0; b < uploadTasks.length; b += BATCH) {
        const batch = uploadTasks.slice(b, b + BATCH);
        await Promise.all(batch.map(async ({ fname, entry }) => {
          try {
            const pdfBuf = Buffer.from(await entry.async('nodebuffer'));
            const bnd = 'exp_pdf_bnd';
            const meta = JSON.stringify({ name: fname, mimeType: 'application/pdf', parents: [FACTURACION_FOLDER_ID] });
            const metaPart = Buffer.from(`--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${bnd}\r\nContent-Type: application/pdf\r\n\r\n`);
            const endPart = Buffer.from(`\r\n--${bnd}--`);
            const body = Buffer.concat([metaPart, pdfBuf, endPart]);
            const r = await fetch(
              'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
              { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${bnd}` }, body }
            );
            if (r.ok) uploaded++;
            else { skipped++; errors.push(fname); }
          } catch (e) { skipped++; errors.push(fname); }
        }));
      }
      return res.status(200).json({ ok: true, periodo, zipName, uploaded, skipped, errors: errors.slice(0, 10) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!filename || !folderId) return res.status(400).json({ error: 'Faltan filename o folderId' });

  try {
    const token = await getSAToken();
    const mime = mimeType || 'application/octet-stream';
    const metadata = JSON.stringify({ name: filename, mimeType: mime, parents: [folderId] });

    // Acción: URL de subida resumible (para archivos grandes)
    if (action === 'upload-url') {
      const initRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mime,
          },
          body: metadata,
        }
      );
      if (!initRes.ok) {
        const err = await initRes.text();
        return res.status(502).json({ error: `Drive resumable init ${initRes.status}: ${err.slice(0,200)}` });
      }
      const uploadUrl = initRes.headers.get('Location');
      if (!uploadUrl) return res.status(502).json({ error: 'Drive no devolvió uploadUrl' });
      return res.status(200).json({ uploadUrl });
    }

    // Acción: subida directa base64 (para archivos pequeños)
    if (!base64) return res.status(400).json({ error: 'Falta base64 o action' });
    const binaryStr = atob(base64);
    const fileBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) fileBytes[i] = binaryStr.charCodeAt(i);
    const boundary = 'drive_boundary';
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
    const endPart = `\r\n--${boundary}--`;
    const metaBytes = new TextEncoder().encode(metaPart);
    const endBytes = new TextEncoder().encode(endPart);
    const body = new Uint8Array(metaBytes.length + fileBytes.length + endBytes.length);
    body.set(metaBytes, 0); body.set(fileBytes, metaBytes.length); body.set(endBytes, metaBytes.length + fileBytes.length);
  