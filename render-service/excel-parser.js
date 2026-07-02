/**
 * excel-parser.js
 *
 * Convierte datos de Nubox a formato historial-facturas.json.
 *
 * Acepta dos fuentes:
 *   A) excelBuffer — Buffer del .xls descargado desde Nubox
 *   B) documentos  — Array JSON del endpoint ObtenerPorFiltro (fallback confiable)
 *
 * Salida:
 *   {
 *     anio: "2026",
 *     periodo: "Julio 2026",
 *     data: {
 *       "CLIENTE SA": {
 *         "default": {
 *           arriendo: { nro: "F-14500", uf: null, total: 5200000 },
 *           servAdm:  { nro: "FEE-14501", uf: null, total: 420000 },
 *         }
 *       }
 *     }
 *   }
 *
 * Notas:
 *   • uf: null porque los UF vienen de la planilla (no del Excel Nubox)
 *   • El sitio es "default" — el frontend resuelve el sitio exacto con ufArr/ufSrv
 *   • Las Notas de Crédito (tipo 61) se almacenan como total negativo: NC-FOLIO
 */

const XLSX = require('xlsx');

// ── Constantes ────────────────────────────────────────────────────────────────

const MES_NOM = {
  '01':'Enero','02':'Febrero','03':'Marzo','04':'Abril',
  '05':'Mayo','06':'Junio','07':'Julio','08':'Agosto',
  '09':'Septiembre','10':'Octubre','11':'Noviembre','12':'Diciembre',
};

// RUT de la empresa emisora (Patagónica) para excluirlo
const RUT_EMISOR = '966732504';

// Tipos DTE relevantes
const TIPO_NC = '61'; // Nota de Crédito Electrónica
const TIPO_FACTURA = '33'; // Factura Electrónica de Venta

// ── Helpers ───────────────────────────────────────────────────────────────────

function normRut(r) {
  return (r || '').replace(/\./g,'').replace(/\s/g,'').toLowerCase();
}

function mesFromFecha(fecha) {
  // Acepta "01/06/2026", "2026-06-01", "01-06-2026"
  if (!fecha) return null;
  const iso = fecha.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { mesNum: iso[2], anio: iso[1] };
  const cl  = fecha.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/);
  if (cl)  return { mesNum: cl[2], anio: cl[3] };
  return null;
}

function detectTipoDTE(tipo) {
  const t = String(tipo || '').trim();
  return t === TIPO_NC ? 'NC' : (t === '34' ? 'exenta' : 'factura');
}

function nombrePeriodo(mesNum, anio) {
  return `${MES_NOM[mesNum] || 'Mes'+mesNum} ${anio}`;
}

// Detecta si el ítem es Serv. Adm. o Arriendo basándose en texto disponible
function detectTipoConcepto(descripcion, folio) {
  const d = (descripcion || '').toLowerCase();
  if (d.includes('serv. adm') || d.includes('serv adm') || d.includes('gastos comun') ||
      d.includes('fee') || d.includes('adm.') || d.includes('adm ')) return 'servAdm';
  if (d.includes('arriendo') || d.includes('arrendamiento')) return 'arriendo';
  // Sin descripción: usar prefijo del folio si lo hay
  if (String(folio).startsWith('FEE')) return 'servAdm';
  return 'arriendo'; // default más común
}

// ── Parser de Excel Nubox (.xls) ──────────────────────────────────────────────

/**
 * parseExcelNubox(buffer, mes)
 *   buffer — Buffer del archivo .xls
 *   mes    — "YYYY-MM" (ej: "2026-07")
 *   returns Array<{folio, tipoDTE, rutRecep, razonSocial, fechaEmision, total}>
 */
function parseExcelNubox(buffer, mes) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (!rows.length) return [];

  // ── Detectar fila de encabezados ──────────────────────────────────────────
  // Buscar la primera fila que tenga "Folio" o "N°" y "RUT" y "Total"
  let headerIdx = -1;
  let colMap = {};

  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i].map(v => String(v || '').toLowerCase().trim());
    const hasCol = (...keywords) => keywords.some(kw => row.some(c => c.includes(kw)));

    if (hasCol('folio', 'n°', 'número') && hasCol('rut', 'r.u.t') && hasCol('total', 'monto')) {
      headerIdx = i;
      // Mapear índices de columnas
      row.forEach((cell, idx) => {
        if (cell.includes('folio') || cell === 'n°') colMap.folio = idx;
        else if (cell.includes('tipo') && cell.includes('dte')) colMap.tipoDTE = idx;
        else if (cell.includes('tipo')) colMap.tipo = idx;
        else if (cell.includes('rut') && (cell.includes('recep') || cell.includes('receptor') || cell.includes('cliente'))) colMap.rutRecep = idx;
        else if (cell === 'rut' || cell === 'r.u.t.') colMap.rutRecep = colMap.rutRecep ?? idx;
        else if (cell.includes('raz') || cell.includes('nombre') || cell.includes('cliente') || cell.includes('receptor')) colMap.razonSocial = idx;
        else if (cell.includes('fecha')) colMap.fecha = idx;
        else if (cell.includes('total') || (cell.includes('monto') && cell.includes('total'))) colMap.total = idx;
        else if (cell.includes('monto') && !colMap.total) colMap.total = idx;
      });
      break;
    }
  }

  // Si no encontramos encabezados, intentar heurística posicional
  if (headerIdx === -1) {
    console.warn('[parser] No se encontraron encabezados estándar — usando columnas 0..N');
    headerIdx = 0;
    // Columnas típicas en reporte Nubox: Folio | Tipo | Fecha | RUT | Razón Social | Total
    colMap = { folio: 0, tipoDTE: 1, fecha: 2, rutRecep: 3, razonSocial: 4, total: 5 };
  }

  // ── Parsear filas de datos ────────────────────────────────────────────────
  const [targetYear, targetMonth] = (mes || '').split('-');
  const registros = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === '' || c == null)) continue;

    const folio      = String(row[colMap.folio]  || '').trim().replace(/\D/g,'');
    const tipoDTE    = String(row[colMap.tipoDTE] || row[colMap.tipo] || '33').trim();
    const rutRecep   = String(row[colMap.rutRecep]   || '').trim();
    const razonSocial= String(row[colMap.razonSocial] || '').trim();
    const fechaRaw   = row[colMap.fecha] instanceof Date
      ? `${String(row[colMap.fecha].getDate()).padStart(2,'0')}/${String(row[colMap.fecha].getMonth()+1).padStart(2,'0')}/${row[colMap.fecha].getFullYear()}`
      : String(row[colMap.fecha] || '').trim();
    const totalRaw   = row[colMap.total];
    const total      = typeof totalRaw === 'number' ? Math.round(totalRaw) : parseInt(String(totalRaw).replace(/[^0-9-]/g,'')) || 0;

    if (!folio || !rutRecep || !razonSocial) continue;
    if (!total) continue;

    // Filtrar el RUT emisor (Patagónica)
    if (normRut(rutRecep) === RUT_EMISOR) continue;

    // Filtrar por mes si es posible
    if (targetMonth && fechaRaw) {
      const f = mesFromFecha(fechaRaw);
      if (f && (f.mesNum !== targetMonth || (targetYear && f.anio !== targetYear))) continue;
    }

    registros.push({ folio, tipoDTE: tipoDTE.trim(), rutRecep, razonSocial, fechaEmision: fechaRaw, total });
  }

  return registros;
}

// ── Parser de documentos JSON (ObtenerPorFiltro) ──────────────────────────────

/**
 * parseDocumentosJson(documentos)
 *   documentos — Array de objetos del endpoint ObtenerPorFiltro de Nubox
 *   returns Array<{folio, tipoDTE, rutRecep, razonSocial, fechaEmision, total}>
 *
 * Los nombres de campo varían según la versión del endpoint:
 *   folio     → folio | Folio | NroFolio | nroFolio
 *   tipoDTE   → tipoDTE | TipoDTE | TipoDocumento | codigoDocumento
 *   rutRecep  → rutReceptor | RutReceptor | rutRecep | rutCliente
 *   razSoc    → razonSocial | RazonSocial | nombreCliente | receptor
 *   total     → montoTotal | MontoTotal | total | Total | monto
 */
function parseDocumentosJson(documentos) {
  if (!Array.isArray(documentos)) return [];

  const get = (obj, ...keys) => {
    for (const k of keys) {
      const found = Object.keys(obj).find(ok => ok.toLowerCase() === k.toLowerCase());
      if (found !== undefined && obj[found] !== undefined && obj[found] !== null && obj[found] !== '') {
        return obj[found];
      }
    }
    return null;
  };

  return documentos
    .map(doc => {
      const folio      = String(get(doc, 'folio','Folio','nroFolio','NroFolio','numeroFolio') || '').replace(/\D/g,'');
      const tipoDTE    = String(get(doc, 'tipoDTE','TipoDTE','tipoDocumento','TipoDocumento','codigoDocumento','CodigoDocumento','tipo','Tipo') || '33').trim();
      const rutRecep   = String(get(doc, 'rutReceptor','RutReceptor','rutRecep','RutRecep','rutCliente','RutCliente','rut','Rut') || '').trim();
      const razonSocial= String(get(doc, 'razonSocial','RazonSocial','nombreCliente','NombreCliente','receptor','Receptor','nombre','Nombre') || '').trim();
      const fechaRaw   = String(get(doc, 'fechaEmision','FechaEmision','fecha','Fecha','fechaDoc') || '').trim();
      const totalVal   = get(doc, 'montoTotal','MontoTotal','total','Total','monto','Monto','mntTotal');
      const total      = typeof totalVal === 'number' ? Math.round(Math.abs(totalVal)) : parseInt(String(totalVal || '0').replace(/[^0-9]/g,'')) || 0;

      return { folio, tipoDTE, rutRecep, razonSocial, fechaEmision: fechaRaw, total };
    })
    .filter(r => r.folio && r.total > 0 && normRut(r.rutRecep) !== RUT_EMISOR);
}

// ── Construcción del historial ────────────────────────────────────────────────

/**
 * buildHistorial(registros, mes)
 *   registros — Array normalizado de facturas
 *   mes       — "YYYY-MM"
 *   returns { anio, periodo, data }
 */
function buildHistorial(registros, mes) {
  if (!mes || !mes.match(/^\d{4}-\d{2}$/)) throw new Error('mes debe ser "YYYY-MM"');

  const [anio, mesNum] = mes.split('-');
  const periodo = nombrePeriodo(mesNum, anio);
  const data = {};

  for (const r of registros) {
    const nombre = r.razonSocial.toUpperCase().trim();
    if (!nombre) continue;

    if (!data[nombre]) data[nombre] = { default: {} };

    const isNC = r.tipoDTE === TIPO_NC || r.tipoDTE === '61';

    if (isNC) {
      // Nota de crédito: total negativo
      data[nombre].default[`NC-${r.folio}`] = {
        nro: `NC-${r.folio}`,
        uf:  null,
        total: -r.total,
      };
      continue;
    }

    // Determinar tipo de concepto: arriendo (F-) vs servAdm (FEE-)
    // Heurística: si el total es bajo (< 1.5M CLP) suele ser servAdm; si es alto, arriendo
    // Pero sin descripción, usamos la razón social para verificar si tiene FEE históricamente
    // → Se almacena en "default" como tipo genérico; el frontend usa ufArr/ufSrv para discriminar
    const isServAdm = r.tipoDTE === '34'; // facturas exentas suelen ser FEE
    const nroPrefix = isServAdm ? 'FEE' : 'F';
    const nro = `${nroPrefix}-${r.folio}`;
    const tipo = isServAdm ? 'servAdm' : 'arriendo';

    // Evitar sobrescribir si ya existe un entry con el mismo folio
    if (data[nombre].default[tipo]?.nro === nro) continue;

    // Si ya hay un arriendo y llega otro, puede ser servAdm
    if (tipo === 'arriendo' && data[nombre].default.arriendo && data[nombre].default.arriendo.nro !== nro) {
      // Segundo arriendo → probablemente es servAdm (las FEE a veces vienen como tipo 33)
      if (!data[nombre].default.servAdm) {
        data[nombre].default.servAdm = { nro, uf: null, total: r.total };
      } else {
        // Tercer documento: guardar con clave única
        data[nombre].default[`extra-${r.folio}`] = { nro, uf: null, total: r.total };
      }
      continue;
    }

    data[nombre].default[tipo] = { nro, uf: null, total: r.total };
  }

  // Limpiar clientes sin data útil
  for (const [k, v] of Object.entries(data)) {
    if (!Object.keys(v.default).length) delete data[k];
  }

  return { anio, periodo, data };
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * procesarNuboxData(options)
 *   options.excelBuffer — Buffer del .xls de Nubox (puede ser null)
 *   options.documentos  — Array del ObtenerPorFiltro (fallback)
 *   options.mes         — "YYYY-MM"
 *   returns { anio, periodo, data, stats }
 */
function procesarNuboxData({ excelBuffer, documentos, mes }) {
  let registros = [];
  let fuente = 'ninguna';

  // Prioridad 1: Excel de Nubox
  let rawDiag = null;
  if (excelBuffer && excelBuffer.length > 100) {
    try {
      // Sin filtro de mes → ver cuántas filas hay en total
      const sinFiltro = parseExcelNubox(excelBuffer, null);
      // Con filtro de mes → resultado real
      registros = parseExcelNubox(excelBuffer, mes);
      fuente = 'excel';
      rawDiag = {
        totalSinFiltro: sinFiltro.length,
        mesesEncontrados: [...new Set(sinFiltro.map(r => r.fechaEmision ? r.fechaEmision.slice(0, 7) : 'sin-fecha'))].slice(0, 6),
        primeraFila: sinFiltro[0] || null,
      };
      console.log(`[parser] Excel Nubox: ${registros.length} con filtro, ${sinFiltro.length} sin filtro`);
      console.log('[parser] diag:', JSON.stringify(rawDiag));
    } catch (e) {
      console.error('[parser] Error parseando Excel:', e.message);
      rawDiag = { error: e.message };
    }
  }

  // Fallback: documentos JSON del ObtenerPorFiltro
  if (!registros.length && documentos && documentos.length) {
    registros = parseDocumentosJson(documentos);
    fuente = 'documentos-api';
    console.log(`[parser] Documentos API: ${registros.length} facturas parseadas`);
  }

  if (!registros.length) {
    console.warn('[parser] No hay datos — verificar credenciales o período sin facturas');
  }

  const historial = buildHistorial(registros, mes);

  const stats = {
    fuente,
    totalRegistros: registros.length,
    totalClientes: Object.keys(historial.data).length,
    periodo: historial.periodo,
    folios: registros.map(r => r.folio).filter(Boolean),
    diag: rawDiag,
  };

  return { ...historial, stats };
}

module.exports = { procesarNuboxData, parseExcelNubox, parseDocumentosJson, buildHistorial };
