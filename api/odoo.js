// /api/odoo.js
// Conecta con Odoo via JSON-RPC usando sesión persistente
// Uso: GET /api/odoo?empresa=dko&mes=2026-05
//      GET /api/odoo?empresa=multi&mes=2026-05
//      GET /api/odoo?empresa=dko&action=test

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { empresa = "dko", mes, action } = req.query;

  const cfg = empresa === "multi" ? {
    url:  process.env.ODOO_DKO_URL,
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
    return res.status(500).json({ error: "Variables de entorno Odoo no configuradas" });
  }

  try {
    const { uid, cookie } = await odooLogin(cfg);
    if (!uid) return res.status(401).json({ error: "Autenticación fallida" });

    if (action === "test") {
      return res.json({ ok: true, uid, db: cfg.db, user: cfg.user, mensaje: "Conexión exitosa" });
    }

    const [anio, mesNum] = (mes || "2026-05").split("-").map(Number);
    const fechaDesde = `${anio}-${String(mesNum).padStart(2,"0")}-01`;
    const ultimoDia = new Date(anio, parseInt(mesNum), 0).getDate();
    const fechaHasta = `${anio}-${String(mesNum).padStart(2,"0")}-${ultimoDia}`;

    const domain = [
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["invoice_date", ">=", fechaDesde],
      ["invoice_date", "<=", fechaHasta],
    ];

    // Filtrar por compañía
    const companyName = empresa === "dko" ? "dko" : "sanchez";
    const companies = await odooCall(cfg, uid, cookie, "res.company", "search_read",
      [[["name", "ilike", companyName]]], ["id", "name", "vat"]);

    if (empresa === "dko" && companies.length > 0) {
      domain.push(["company_id", "=", companies[0].id]);
    } else if (empresa === "multi") {
      const multi = companies.find(c => !c.name.toLowerCase().includes("dko"));
      if (multi) domain.push(["company_id", "=", multi.id]);
    }

    // Facturas sin partner_vat (campo no disponible)
    const facturas = await odooCall(cfg, uid, cookie, "account.move", "search_read", [domain], [
      "name", "partner_id", "invoice_date", "amount_untaxed", "amount_total",
      "state", "l10n_latam_document_number", "l10n_latam_document_type_id",
      "l10n_cl_dte_status", "l10n_cl_dte_acceptation_status", "company_id",
    ], 5000);

    // Obtener RUT de partners en batch
    const partnerIds = [...new Set(facturas.map(f => f.partner_id?.[0]).filter(Boolean))];
    const partners = partnerIds.length > 0
      ? await odooCall(cfg, uid, cookie, "res.partner", "search_read",
          [[["id", "in", partnerIds]]], ["id", "vat"], partnerIds.length + 10)
      : [];
    const partnerMap = Object.fromEntries(partners.map(p => [p.id, p.vat || ""]));

    return res.json({
      ok: true,
      empresa,
      mes,
      total: facturas.length,
      facturas: facturas.map(f => ({
        numero:      f.name,
        folio:       f.l10n_latam_document_number,
        tipo_doc:    f.l10n_latam_document_type_id?.[1] || "",
        fecha:       f.invoice_date,
        rut:         partnerMap[f.partner_id?.[0]] || "",
        cliente:     f.partner_id?.[1] || "",
        neto:        Math.round(f.amount_untaxed),
        total:       Math.round(f.amount_total),
        estado:      f.state,
        estado_sii:  f.l10n_cl_dte_status || "",
        estado_acep: f.l10n_cl_dte_acceptation_status || "",
        empresa:     f.company_id?.[1] || "",
      }))
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 400) });
  }
}

async function odooLogin({ url, db, user, pass }) {
  const res = await fetch(`${url}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db, login: user, password: pass },
    }),
  });
  const cookie = res.headers.get("set-cookie") || "";
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return { uid: data.result?.uid, cookie };
}

async function odooCall({ url }, uid, cookie, model, method, args, fields, limit = 5000) {
  const kwargs = fields
    ? { fields, limit, context: { lang: "es_CL" } }
    : { context: { lang: "es_CL" } };
  const res = await fetch(`${url}/web/dataset/call_kw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: Math.floor(Math.random()*9999),
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result;
}
