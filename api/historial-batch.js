/**
 * /api/historial-batch
 *
 * POST { periodo, sitios }
 *   periodo : "Marzo 2026" o "2026-03"
 *   sitios  : [{ rut, cliente, sitio, edificio, ufArr, ufSrv }, ...]
 *             (viene del frontend que ya tiene la planilla parseada)
 *
 * Descarga los archivos del período UNA sola vez, procesa todos los clientes
 * juntos (resuelve multi-sitio correctamente), guarda historial-YYYY-MM.json
 * en Drive y devuelve el resultado para revisión.
 *
 * GET { periodo }  → devuelve el JSON guardado (si existe)
 * POST { periodo, sitios, aprobar:true } → marca el período como aprobado
 * POST { periodo, correccion: { rut, sitio, facturas } } → corrección manual
 */

import JSZip from "jszip";
import {
  normRut, clienteMatch, detectTipo,
  _pickByUF,
  _buildXmlFacturas, extractFacturasForRut, extractText,
  _extractUF, _extractTotal, _derivarUFdePrecio,
  getToken, driveFiles, FACT_FOLDER_ID,
} from "./historial.js";

export const config = { api: { bodyParser: true, responseLimit: "20mb" } };

const MES_NUM = {
  Enero:"01", Febrero:"02", Marzo:"03", Abril:"04", Mayo:"05", Junio:"06",
  Julio:"07", Agosto:"08", Septiembre:"09", Octubre:"10", Noviembre:"11", Diciembre:"12",
};

function parsePeriodo(periodo) {
  if (!periodo) return null;
  if (periodo.match(/^\d{4}-\d{2}$/)) {
    const [a, m] = periodo.split("-");
    return { anioStr: a, mesNum: m };
  }
  const [mesNom, anio] = periodo.split(" ");
  const mesNum = MES_NUM[mesNom];
  if (!mesNum) return null;
  return { anioStr: anio, mesNum };
}

// ── Carga archivos del período desde Drive (una vez para todos los clientes) ──
async function loadPeriodFiles(token, driveFileList, anioStr, mesNum) {
  const result = { xmlFiles: [], pdfText: null, zip: null };
  const authH = { Authorization: `Bearer ${token}` };

  // 1. ZIP XML de DTEs
  const xmlZipRe = new RegExp(`PISA[_-]${anioStr}[_-]${mesNum}\\.zip$`, "i");
  const xmlZipFile = driveFileList.find(f => xmlZipRe.test(f.name));
  if (xmlZipFile) {
    try {
      const buf = Buffer.from(await (await fetch(
        `https://www.googleapis.com/drive/v3/files/${xmlZipFile.id}?alt=media`,
        { headers: authH }
      )).arrayBuffer());
      const zip = await JSZip.loadAsync(buf);
      for (const [name, entry] of Object.entries(zip.files)) {
        if (!name.toLowerCase().endsWith(".xml")) continue;
        result.xmlFiles.push({ name, content: await entry.async("string") });
      }
    } catch(_) {}
  }

  // 2. PDF consolidado
  const pdfRe = new RegExp(`facturas_pisa_${anioStr}[_-]${mesNum}\\.pdf$`, "i");
  const pdfFile = driveFileList.find(f => pdfRe.test(f.name));
  if (pdfFile) {
    try {
      const buf = Buffer.from(await (await fetch(
        `https://www.googleapis.com/drive/v3/files/${pdfFile.id}?alt=media`,
        { headers: authH }
      )).arrayBuffer());
      result.pdfText = extractText(buf);
    } catch(_) {}
  }

  // 3. ZIP individual de PDFs
  const zipName = `${anioStr}-${mesNum}.zip`;
  const zipFile = driveFileList.find(f => f.name.toLowerCase() === zipName.toLowerCase());
  if (zipFile) {
    try {
      const buf = Buffer.from(await (await fetch(
        `https://www.googleapis.com/drive/v3/files/${zipFile.id}?alt=media`,
        { headers: authH }
      )).arrayBuffer());
      result.zip = await JSZip.loadAsync(buf);
    } catch(_) {}
  }

  return result;
}

// ── Extrae candidatos del ZIP individual por nombre de cliente ────────────────
async function extractFromZipByCliente(zip, clienteName) {
  const byTipo = {};
  if (!zip) return byTipo;
  for (const [filename, entry] of Object.entries(zip.files)) {
    if (entry.dir || !filename.toLowerCase().endsWith(".pdf")) continue;
    // Nombre archivo: "F-14308 VISIBILITY S. A..pdf" — quitar prefijo nro
    const base = filename.replace(/^[A-Za-z]+-\d+\s+/, "").replace(/\.pdf$/i, "");
    if (!clienteMatch(base, clienteName)) continue;
    const nroMatch = filename.match(/^([A-Za-z]+-\d+)/i);
    if (!nroMatch) continue;
    try {
      const buf = Buffer.from(await entry.async("arraybuffer"));
      const text = extractText(buf);
      const tipo = detectTipo(text);
      if (!tipo) continue;
      const total = _extractTotal(text);
      const uf = _extractUF(text) ?? _derivarUFdePrecio(text, total);
      const nro = nroMatch[1].toUpperCase();
      if (!byTipo[tipo]) byTipo[tipo] = [];
      if (!byTipo[tipo].some(e => e.nro === nro))
        byTipo[tipo].push({ nro, uf, total, fuente: "zip" });
    } catch(_) {}
  }
  return byTipo;
}

// ── Asigna candidatos a sitios evitando duplicar facturas ─────────────────────
function assignToSites(rutSitios, allByTipo) {
  const usedNros = new Set();
  const results = [];

  // Ordenar sitios: procesar primero los que tienen ufArr más específico
  const ordered = rutSitios.map((s, i) => ({ ...s, _origIdx: i }))
    .sort((a, b) => (b.ufArr || 0) - (a.ufArr || 0));

  for (const sitio of ordered) {
    const sitioFacturas = {};
    const siteIdx = sitio._origIdx;

    for (const [tipo, candidates] of Object.entries(allByTipo)) {
      if (tipo === "arriendo" && !(sitio.ufArr > 0)) continue;
      if (tipo === "servAdm"  && !(sitio.ufSrv > 0)) continue;
      // tipos sin UF (habilitacion, servMant, servCont, asesoria): solo siteIdx=0
      const ufExp = tipo === "arriendo" ? sitio.ufArr :
                    tipo === "servAdm"  ? sitio.ufSrv : null;
      if (ufExp == null && siteIdx > 0) continue;

      const available = candidates.filter(c => !usedNros.has(c.nro));
      if (!available.length) continue;

      const picked = _pickByUF(available, ufExp, siteIdx);
      if (!picked) continue;

      usedNros.add(picked.nro);
      sitioFacturas[tipo] = {
        nro: picked.nro, uf: picked.uf, total: picked.total, fuente: picked.fuente || "?"
      };
    }

    const tieneArriendo = !(sitio.ufArr > 0) || !!sitioFacturas.arriendo;
    const tieneServAdm  = !(sitio.ufSrv > 0) || !!sitioFacturas.servAdm;
    const estado = tieneArriendo && tieneServAdm ? "ok" : "pendiente";

    results.push({
      rut: sitio.rut,
      cliente: sitio.cliente,
      sitio: sitio.sitio || "",
      edificio: sitio.edificio || "",
      ufArr: sitio.ufArr || 0,
      ufSrv: sitio.ufSrv || 0,
      facturas: sitioFacturas,
      estado,
    });
  }

  return results;
}

// ── Preserva correcciones manuales del JSON anterior ─────────────────────────
function mergeBatchData(newData, existingData) {
  if (!existingData?.sitios) return;
  if (existingData.aprobado) newData.aprobado = existingData.aprobado;
  for (const newEntry of newData.sitios) {
    const existing = existingData.sitios.find(
      s => normRut(s.rut) === normRut(newEntry.rut) && s.sitio === newEntry.sitio
    );
    if (existing?.estado === "corregido") {
      newEntry.facturas = existing.facturas;
      newEntry.estado = "corregido";
    }
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
  const sa = JSON.parse(saJson);

  try {
    const token = await getToken(sa);

    const { periodo, sitios } = req.body || {};
    const p = parsePeriodo(periodo);
    if (!p) return res.status(400).json({ error: "Periodo inválido" });
    if (!Array.isArray(sitios) || sitios.length === 0)
      return res.status(400).json({ error: "sitios[] es requerido" });

    const driveFileList = await driveFiles(token, FACT_FOLDER_ID);
    const sharedFiles = await loadPeriodFiles(token, driveFileList, p.anioStr, p.mesNum);

    // Agrupar por RUT para resolver multi-sitio en conjunto
    const byRut = {};
    for (const sitio of sitios) {
      const rut = normRut(sitio.rut);
      if (!byRut[rut]) byRut[rut] = [];
      byRut[rut].push(sitio);
    }

    const resultSitios = [];
    for (const [rutN, rutSitios] of Object.entries(byRut)) {
      const allByTipo = {};

      if (sharedFiles.xmlFiles.length > 0) {
        const xmlByTipo = _buildXmlFacturas(sharedFiles.xmlFiles, rutN, null);
        for (const [tipo, cands] of Object.entries(xmlByTipo)) {
          if (!allByTipo[tipo]) allByTipo[tipo] = [];
          for (const c of cands)
            if (!allByTipo[tipo].some(e => e.nro === c.nro))
              allByTipo[tipo].push({ ...c, fuente: "xml" });
        }
      }

      if (sharedFiles.pdfText) {
        const pdfByTipo = extractFacturasForRut(sharedFiles.pdfText, rutN);
        for (const [tipo, cands] of Object.entries(pdfByTipo)) {
          if (!allByTipo[tipo]) allByTipo[tipo] = [];
          for (const c of cands)
            if (!allByTipo[tipo].some(e => e.nro === c.nro))
              allByTipo[tipo].push({ ...c, fuente: "pdf" });
        }
      }

      if (sharedFiles.zip) {
        const cliente = rutSitios[0].cliente;
        const zipByTipo = await extractFromZipByCliente(sharedFiles.zip, cliente);
        for (const [tipo, cands] of Object.entries(zipByTipo)) {
          if (!allByTipo[tipo]) allByTipo[tipo] = [];
          for (const c of cands)
            if (!allByTipo[tipo].some(e => e.nro === c.nro))
              allByTipo[tipo].push(c);
        }
      }

      resultSitios.push(...assignToSites(rutSitios, allByTipo));
    }

    const stats = {
      total: resultSitios.length,
      ok: resultSitios.filter(s => s.estado === "ok").length,
      pendiente: resultSitios.filter(s => s.estado === "pendiente").length,
      corregido: resultSitios.filter(s => s.estado === "corregido").length,
    };

    return res.status(200).json({ ok: true, stats, sitios: resultSitios });

  } catch (e) {
    console.error("historial-batch:", e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
}
