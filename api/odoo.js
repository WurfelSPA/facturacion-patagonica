// /api/odoo.js
// Conecta con Odoo via JSON-RPC (compatible con Odoo 14+)
// Uso: GET /api/odoo?empresa=dko&mes=2026-05
//      GET /api/odoo?empresa=multi&mes=2026-05
//      GET /api/odoo?empresa=dko&action=test  ← prueba conexión

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { empresa = "dko", mes, action } = req.query;

  // Seleccionar credenciales según empresa
  const cfg = empresa === "multi" ? {
    url:  process.env.ODOO_DKO_URL,   // mismo servidor
    db:   process.env.ODOO_MULTI_DB,
    user: process.env.ODOO_MULTI_USER,
    pass: process.env.ODOO_MULTI_PASS,
  } : {
    url:  process.env.ODOO_DKO_URL,
    db:   process.env.ODOO_DKO_DB,
    user: process.env.ODOO_DKO_USER,
    pass: process.env.ODOO_DKO_PASS,
  };

  if (!cfg.url || !cfg.db || !cfg.user || !cfg.pass) {
    return res.status(500).json({ error: "Variables de entorno Odoo no configuradas", cfg_keys: Object.keys(cfg) });
  }

  try {
    // ── PASO 1: Autenticar ──
    const uid = await odooAuthenticate(cfg);
    if (!uid) return res.status(401).json({ error: "Autenticación fallida — usuario/contraseña incorrectos o DB incorrecta" });

    if (action === "test") {
      return res.json({ ok: true, uid, db: cfg.db, user: cfg.user, mensaje: "Conexión exitosa con Odoo" });
    }

    // ── PASO 2: Obtener facturas del mes ──
    const [anio, mesNum] = (mes || "2026-05").split("-").map(Number);
    const fechaDesde = `${anio}-${String(mesNum).padStart(2,"0")}-01`;
    const fechaHasta = `${anio}-${String(mesNum).padStart(2,"0")}-31`;

    const facturas = await odooSearchRead(cfg, uid, "account.move", [
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["invoice_date", ">=", fechaDesde],
      ["invoice_date", "<=", fechaHasta],
    ], [
      "name", "partner_id", "invoice_date", "amount_untaxed", "amount_total",
      "state", "l10n_latam_document_number", "l10n_latam_document_type_id",
      "l10n_cl_dte_status", "l10n_cl_dte_acceptation_status",
      "partner_vat",
    ]);

    return res.json({
      ok: true,
      empresa,
      mes,
      total: facturas.length,
      facturas: facturas.map(f => ({
        numero:       f.name,
        folio:        f.l10n_latam_document_number,
        tipo_doc:     f.l10n_latam_document_type_id?.[1] || "",
        fecha:        f.invoice_date,
        rut:          f.partner_vat || "",
        cliente:      f.partner_id?.[1] || "",
        neto:         Math.round(f.amount_untaxed),
        total:        Math.round(f.amount_total),
        estado:       f.state,
        estado_sii:   f.l10n_cl_dte_status || "",
        estado_acep:  f.l10n_cl_dte_acceptation_status || "",
      }))
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 300) });
  }
}

/* ── Helpers JSON-RPC Odoo ── */

async function odooCall(url, service, method, args) {
  const res = await fetch(`${url}/web/dataset/call_kw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: { service, method, args },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result;
}

async function odooAuthenticate({ url, db, user, pass }) {
  const res = await fetch(`${url}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db, login: user, password: pass },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result?.uid || null;
}

async function odooSearchRead({ url, db, user, pass }, uid, model, domain, fields) {
  // Usar endpoint JSON-RPC de búsqueda
  const res = await fetch(`${url}/web/dataset/call_kw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: {
        model,
        method: "search_read",
        args: [domain],
        kwargs: {
          fields,
          limit: 5000,
          context: { lang: "es_CL" },
        },
      },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result || [];
}
