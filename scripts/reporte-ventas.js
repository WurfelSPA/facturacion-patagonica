// scripts/reporte-ventas.js
// Reporte mensual automático: consulta Odoo y envía email con estado DTE
// Corre via GitHub Actions el día 30/31 de cada mes

const nodemailer = require("nodemailer");

/* ── Configuración ── */
const ODOO_URL  = process.env.ODOO_DKO_URL;
const EMPRESAS  = process.env.EMPRESA_INPUT === "dko"   ? ["dko"]   :
                  process.env.EMPRESA_INPUT === "multi"  ? ["multi"] : ["dko", "multi"];

const RUT_MAP = {
  dko:   { nombre: "Sánchez Hermanos",        rut: "77454587-5", db: process.env.ODOO_DKO_DB,   user: process.env.ODOO_DKO_USER,  pass: process.env.ODOO_DKO_PASS },
  multi: { nombre: "Distribuidora Sánchez 4G", rut: "77538786-6", db: process.env.ODOO_MULTI_DB, user: process.env.ODOO_MULTI_USER, pass: process.env.ODOO_MULTI_PASS },
};

const DESTINATARIOS = [
  "amelendez@patagonica.cl",
  "mmunoz@patagonica.cl",
];

/* ── Determinar mes a reportar ── */
function getMes() {
  if (process.env.MES_MANUAL) return process.env.MES_MANUAL;
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes  = String(hoy.getMonth() + 1).padStart(2, "0");
  return `${anio}-${mes}`;
}

/* ── Autenticar en Odoo ── */
async function odooLogin(cfg) {
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db: cfg.db, login: cfg.user, password: cfg.pass },
    }),
  });
  const cookie = res.headers.get("set-cookie") || "";
  const data   = await res.json();
  if (data.error) throw new Error("Login Odoo fallido: " + JSON.stringify(data.error));
  return { uid: data.result?.uid, cookie };
}

/* ── Llamada JSON-RPC Odoo ── */
async function odooCall(cookie, model, method, args, fields, limit = 5000) {
  const kwargs = fields ? { fields, limit, context: { lang: "es_CL" } } : { context: { lang: "es_CL" } };
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: Math.floor(Math.random() * 9999),
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result;
}

/* ── Obtener facturas de una empresa ── */
async function getFacturas(empId, mes) {
  const cfg = RUT_MAP[empId];
  const { uid, cookie } = await odooLogin(cfg);

  const [anio, mesNum] = mes.split("-");
  const fechaDesde = `${anio}-${mesNum}-01`;
  const fechaHasta = `${anio}-${mesNum}-31`;

  // Buscar company_id
  const companies = await odooCall(cookie, "res.company", "search_read",
    [[["name", "ilike", empId === "dko" ? "dko" : "sanchez"]]], ["id", "name"]);
  const domain = [
    ["move_type", "=", "out_invoice"],
    ["state", "=", "posted"],
    ["invoice_date", ">=", fechaDesde],
    ["invoice_date", "<=", fechaHasta],
  ];
  if (companies.length > 0) {
    const comp = empId === "dko"
      ? companies[0]
      : companies.find(c => !c.name.toLowerCase().includes("dko")) || companies[0];
    domain.push(["company_id", "=", comp.id]);
  }

  const facturas = await odooCall(cookie, "account.move", "search_read", [domain], [
    "name", "partner_id", "invoice_date", "amount_untaxed", "amount_total",
    "l10n_latam_document_number", "l10n_latam_document_type_id",
    "l10n_cl_dte_status", "l10n_cl_dte_acceptation_status",
  ]);

  // Solo tipo 33
  const f33 = facturas.filter(f => f.l10n_latam_document_type_id?.[1]?.includes("33"));

  return {
    empresa: cfg.nombre,
    rut:     cfg.rut,
    total:   f33.length,
    aceptadas:   f33.filter(f => f.l10n_cl_dte_status === "accepted"),
    enEspera:    f33.filter(f => f.l10n_cl_dte_status === "ask_for_status"),
    sinEnviar:   f33.filter(f => f.l10n_cl_dte_status === "not_sent"),
    rechazadas:  f33.filter(f => f.l10n_cl_dte_status === "rejected"),
    total_neto:  f33.reduce((s, f) => s + Math.round(f.amount_untaxed), 0),
    total_bruto: f33.reduce((s, f) => s + Math.round(f.amount_total), 0),
  };
}

/* ── Formatear CLP ── */
const fmtCLP = v => "$" + Math.round(v).toLocaleString("es-CL");

/* ── Construir HTML del reporte ── */
function buildReporteHtml(resultados, mes) {
  const [anio, mesNum] = mes.split("-");
  const MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const mesNombre = MESES[parseInt(mesNum)];
  const totalAlertas = resultados.reduce((s, r) => s + r.sinEnviar.length + r.rechazadas.length, 0);
  const hayAlertas = totalAlertas > 0;

  const resumenEmpresas = resultados.map(r => `
    <tr>
      <td style="padding:10px 14px;font-size:13px;color:#333;border-bottom:1px solid #f0f0f0">${r.empresa}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:monospace;color:#333;border-bottom:1px solid #f0f0f0">${r.rut}</td>
      <td style="padding:10px 14px;font-size:13px;text-align:center;border-bottom:1px solid #f0f0f0">${r.total}</td>
      <td style="padding:10px 14px;font-size:13px;text-align:center;color:#0a7c4e;font-weight:700;border-bottom:1px solid #f0f0f0">${r.aceptadas.length}</td>
      <td style="padding:10px 14px;font-size:13px;text-align:center;color:#a05c00;border-bottom:1px solid #f0f0f0">${r.enEspera.length}</td>
      <td style="padding:10px 14px;font-size:13px;text-align:center;color:${r.sinEnviar.length>0?"#c0392b":"#999"};font-weight:${r.sinEnviar.length>0?"700":"400"};border-bottom:1px solid #f0f0f0">${r.sinEnviar.length}</td>
      <td style="padding:10px 14px;font-size:13px;text-align:center;color:${r.rechazadas.length>0?"#c0392b":"#999"};font-weight:${r.rechazadas.length>0?"700":"400"};border-bottom:1px solid #f0f0f0">${r.rechazadas.length}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:monospace;text-align:right;border-bottom:1px solid #f0f0f0">${fmtCLP(r.total_neto)}</td>
    </tr>
  `).join("");

  const alertasHtml = resultados.flatMap(r => [
    ...r.sinEnviar.map(f => `
      <tr style="background:#fdf0ef">
        <td style="padding:8px 12px;font-size:11px;color:#c0392b;font-weight:700">⚠ Sin enviar</td>
        <td style="padding:8px 12px;font-size:11px">${r.empresa}</td>
        <td style="padding:8px 12px;font-size:11px;font-family:monospace">${f.l10n_latam_document_number}</td>
        <td style="padding:8px 12px;font-size:11px">${f.partner_id?.[1] || ""}</td>
        <td style="padding:8px 12px;font-size:11px;font-family:monospace">${fmtCLP(f.amount_total)}</td>
        <td style="padding:8px 12px;font-size:11px">${f.invoice_date}</td>
      </tr>
    `),
    ...r.rechazadas.map(f => `
      <tr style="background:#fdf0ef">
        <td style="padding:8px 12px;font-size:11px;color:#c0392b;font-weight:700">✗ Rechazada</td>
        <td style="padding:8px 12px;font-size:11px">${r.empresa}</td>
        <td style="padding:8px 12px;font-size:11px;font-family:monospace">${f.l10n_latam_document_number}</td>
        <td style="padding:8px 12px;font-size:11px">${f.partner_id?.[1] || ""}</td>
        <td style="padding:8px 12px;font-size:11px;font-family:monospace">${fmtCLP(f.amount_total)}</td>
        <td style="padding:8px 12px;font-size:11px">${f.invoice_date}</td>
      </tr>
    `),
  ]).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:28px 0">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e0e0e0;overflow:hidden">

  <!-- Header -->
  <tr><td style="background:${hayAlertas?"#8B0000":"#1e3a5f"};padding:22px 32px">
    <div style="font-size:18px;font-weight:700;color:#fff">
      ${hayAlertas ? "⚠ " : "✅ "}Reporte de Ventas — ${mesNombre} ${anio}
    </div>
    <div style="font-size:12px;color:${hayAlertas?"#ffb3b3":"#93b5d4"};margin-top:4px">
      ${hayAlertas
        ? `${totalAlertas} factura${totalAlertas!==1?"s":""} requieren atención inmediata`
        : "Todas las facturas han sido aceptadas por el SII"}
    </div>
  </td></tr>

  <!-- Resumen por empresa -->
  <tr><td style="padding:24px 32px">
    <div style="font-size:13px;font-weight:700;color:#333;margin-bottom:12px">Resumen por empresa</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;overflow:hidden">
      <tr style="background:#f0f4f8">
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#999;text-align:left">EMPRESA</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#999;text-align:left">RUT</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#999;text-align:center">TOTAL</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#0a7c4e;text-align:center">✓ ACEP.</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#a05c00;text-align:center">⏳ ESP.</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#c0392b;text-align:center">⚠ S/ENV.</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#c0392b;text-align:center">✗ RECH.</th>
        <th style="padding:8px 14px;font-size:10px;font-weight:700;color:#999;text-align:right">NETO</th>
      </tr>
      ${resumenEmpresas}
    </table>
  </td></tr>

  <!-- Alertas -->
  ${hayAlertas ? `
  <tr><td style="padding:0 32px 24px">
    <div style="font-size:13px;font-weight:700;color:#c0392b;margin-bottom:12px">⚠ Facturas que requieren acción</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f5c0bc;border-radius:6px;overflow:hidden">
      <tr style="background:#fdf0ef">
        <th style="padding:8px 12px;font-size:10px;font-weight:700;color:#c0392b;text-align:left">ESTADO</th>
        <th style="padding:8px 12px;font-size:10px;font-weight:700;color:#c0392b;text-align:left">EMPRESA</th>
        <th style="padding:8px 12px;font-size:10px;font-weight:700;color:#c0392b;text-align:left">FOLIO</th>
        <th style="padding:8px 12px;font-size:10px;font-weight:700;color:#c0392b;text-align:left">CLIENTE</th>
        <th style="padding:8px 12px;font-size:10px;font-weight:700;color:#c0392b;text-align:left">TOTAL</th>
        <th style="padding:8px 12px;font-size:10px;font-weight:700;color:#c0392b;text-align:left">FECHA</th>
      </tr>
      ${alertasHtml}
    </table>
  </td></tr>
  ` : `
  <tr><td style="padding:0 32px 24px">
    <div style="background:#e8f5f0;border:1px solid #b6ddd0;border-radius:8px;padding:16px 20px;font-size:13px;color:#0a7c4e">
      ✅ Sin alertas — todas las facturas tipo 33 de ${mesNombre} ${anio} han sido aceptadas por el SII.
    </div>
  </td></tr>
  `}

  <!-- Footer -->
  <tr><td style="background:#f8f8f8;border-top:1px solid #e8e8e8;padding:16px 32px">
    <p style="font-size:11px;color:#999;margin:0">
      Reporte generado automáticamente el ${new Date().toLocaleDateString("es-CL", {day:"2-digit",month:"long",year:"numeric"})}
      · Patagónica Inmobiliaria SpA · RUT 96.673.250-4
    </p>
    <p style="font-size:11px;color:#999;margin:4px 0 0">
      Sistema: facturacion-patagonica.vercel.app · Fuente: Odoo directo
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/* ── Enviar email ── */
async function enviarReporte(html, mes, hayAlertas) {
  const [anio, mesNum] = mes.split("-");
  const MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const mesNombre = MESES[parseInt(mesNum)];

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const asunto = hayAlertas
    ? `⚠ ALERTA — Ventas ${mesNombre} ${anio} — Facturas pendientes SII`
    : `✅ Reporte Ventas ${mesNombre} ${anio} — Sin diferencias`;

  await transporter.sendMail({
    from:    `"Patagónica Inmobiliaria" <${process.env.GMAIL_USER}>`,
    to:      DESTINATARIOS.join(", "),
    subject: asunto,
    html,
  });

  console.log(`✓ Reporte enviado a: ${DESTINATARIOS.join(", ")}`);
}

/* ── Main ── */
async function main() {
  const mes = getMes();
  console.log(`\n══════════════════════════════════`);
  console.log(`Reporte de Ventas — ${mes}`);
  console.log(`Empresas: ${EMPRESAS.join(", ")}`);
  console.log(`══════════════════════════════════\n`);

  const resultados = [];

  for (const empId of EMPRESAS) {
    try {
      console.log(`Consultando Odoo — ${RUT_MAP[empId].nombre}...`);
      const r = await getFacturas(empId, mes);
      resultados.push(r);
      console.log(`  ✓ ${r.total} facturas | ${r.aceptadas.length} aceptadas | ${r.sinEnviar.length} sin enviar | ${r.rechazadas.length} rechazadas`);
    } catch (e) {
      console.error(`  ✗ Error ${empId}: ${e.message}`);
      resultados.push({
        empresa: RUT_MAP[empId].nombre,
        rut: RUT_MAP[empId].rut,
        total: 0, aceptadas: [], enEspera: [], sinEnviar: [], rechazadas: [],
        total_neto: 0, total_bruto: 0,
        error: e.message,
      });
    }
  }

  const hayAlertas = resultados.some(r => r.sinEnviar.length > 0 || r.rechazadas.length > 0);
  const html = buildReporteHtml(resultados, mes);

  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    await enviarReporte(html, mes, hayAlertas);
  } else {
    console.log("⚠ GMAIL_USER/GMAIL_PASS no configurados — guardando HTML localmente");
    require("fs").writeFileSync(`reporte-${mes}.html`, html);
    console.log(`✓ Reporte guardado: reporte-${mes}.html`);
  }

  console.log("\n✓ Proceso completado");
  process.exit(hayAlertas ? 1 : 0); // Exit 1 si hay alertas (GitHub lo marca en amarillo)
}

main().catch(e => {
  console.error("Error fatal:", e.message);
  process.exit(1);
});
