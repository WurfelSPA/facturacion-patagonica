// api/nubox-pisa.js
// GET /api/nubox-pisa?mes=YYYY-MM&tipo=33
// Consulta facturas de Pisa en Nubox por período.
//
// Variables requeridas en Vercel:
//   NUBOX_PISA_API_KEY  → usuario API Nubox (ej: QE710sHnJCrt)
//   NUBOX_PARTNER_TOKEN → contraseña del usuario API

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { mes, tipo = "33" } = req.query;

  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ ok: false, error: "Parámetro mes requerido en formato YYYY-MM" });
  }

  const apiUser = process.env.NUBOX_PISA_API_KEY;
  const apiPass = process.env.NUBOX_PARTNER_TOKEN;

  if (!apiUser || !apiPass) {
    return res.status(500).json({
      ok: false,
      error: "Faltan variables NUBOX_PISA_API_KEY o NUBOX_PARTNER_TOKEN",
    });
  }

  try {
    // ── PASO 1: Autenticar con la API antigua de Nubox ────────────────────────
    // Concatenar user:pass en base64
    const credentials = Buffer.from(`${apiUser}:${apiPass}`).toString("base64");

    const authRes = await fetch("https://api.nubox.com/nubox.api/autenticar", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
    });

    if (!authRes.ok) {
      const text = await authRes.text();
      return res.status(401).json({
        ok: false,
        step: "autenticacion",
        status: authRes.status,
        error: text.slice(0, 500),
        hint: "Verifica que NUBOX_PISA_API_KEY (usuario) y NUBOX_PARTNER_TOKEN (contraseña) sean correctos",
      });
    }

    // El token viene en el header de la respuesta
    const token = authRes.headers.get("Token") || authRes.headers.get("token");
    const authData = await authRes.json();

    if (!token) {
      return res.status(500).json({
        ok: false,
        step: "autenticacion",
        error: "Autenticación OK pero no se recibió Token en headers",
        auth_response: authData,
      });
    }

    // Extraer lista de sistemas (empresas) del usuario
    const sistemas = Array.isArray(authData)
      ? authData
      : authData.sistemas || authData.Sistemas || authData.data || [];

    // Buscar el sistema de Pisa por RUT (96673250)
    const pisaSistema =
      sistemas.find((s) => {
        const r = String(s.Rut || s.rut || s.RutEmpresa || "").replace(/[.\-]/g, "");
        return r.startsWith("96673250");
      }) || sistemas[0] || {};

    const serie = String(
      pisaSistema.NumeroSerie || pisaSistema.numeroSerie || pisaSistema.Serie || ""
    );

    // ── PASO 2: Consultar facturas por período ────────────────────────────────
    const [anio, mesNum] = mes.split("-");
    const facturas = [];

    // Intentar la API nueva (Factura y Administración) que sí tiene listado por período
    // URL base obtenida de developers.nubox.com/api-docs
    const nuevaApiBase = "https://api.pyme.nubox.com/nbxpymapi-environment-pyme/v1";
    const nuevaApiUrl = `${nuevaApiBase}/sales?period=${mes}&type=${tipo}&size=500&page=1`;

    const nuevaRes = await fetch(nuevaApiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-Key": apiUser,
        "Content-Type": "application/json",
      },
    });

    if (nuevaRes.ok) {
      const nuevaData = await nuevaRes.json();
      const items = nuevaData.data || nuevaData.items || nuevaData || [];
      if (Array.isArray(items) && items.length > 0) {
        return res.json({
          ok: true,
          source: "nueva_api",
          mes,
          tipo: Number(tipo),
          count: items.length,
          facturas: normalizarFacturas(items, "nueva"),
        });
      }
    }

    // Intentar la API antigua con endpoint de documentos (puede estar sin documentar)
    const antiguaUrl = `https://api.nubox.com/nubox.api/factura/documentos/${encodeURIComponent("96673250-4")}?periodo=${anio}${mesNum}&tipo=${tipo}&serie=${serie}`;

    const antiguaRes = await fetch(antiguaUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Token: token,
        "Content-Type": "application/json",
      },
    });

    if (antiguaRes.ok) {
      let antiguaData;
      try { antiguaData = await antiguaRes.json(); } catch (_) { antiguaData = null; }
      if (antiguaData && (Array.isArray(antiguaData) ? antiguaData.length > 0 : true)) {
        const items = Array.isArray(antiguaData) ? antiguaData : (antiguaData.data || antiguaData.documentos || []);
        if (items.length > 0) {
          return res.json({
            ok: true,
            source: "antigua_api",
            mes,
            tipo: Number(tipo),
            count: items.length,
            facturas: normalizarFacturas(items, "antigua"),
          });
        }
      }
    }

    // ── DIAGNÓSTICO: Ningún endpoint funcionó aún ─────────────────────────────
    // Devolver información útil para depuración
    return res.json({
      ok: false,
      debug: true,
      message:
        "Autenticación exitosa, pero aún no encontramos el endpoint correcto para listar facturas. " +
        "Comparte este diagnóstico con soporte de Nubox o revisa la URL base de la API nueva.",
      token_preview: token.slice(0, 8) + "...",
      serie_pisa: serie,
      sistemas: sistemas.map((s) => ({
        rut: s.Rut || s.rut,
        nombre: s.Nombre || s.nombre,
        serie: s.NumeroSerie || s.Serie || s.serie,
      })),
      endpoints_probados: [
        { url: nuevaApiUrl, status: nuevaRes.status },
        { url: antiguaUrl, status: antiguaRes.status },
      ],
    });
  } catch (err) {
    console.error("[nubox-pisa]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// Normalizar respuesta a formato estándar { folio, cliente, fecha, total, tipo }
function normalizarFacturas(items, fuente) {
  return items.map((f) => {
    if (fuente === "nueva") {
      return {
        folio:   String(f.documentNumber || f.folio || ""),
        cliente: f.receptor?.businessName || f.cliente || "",
        rut:     f.receptor?.taxId || f.rut || "",
        fecha:   (f.issueDate || f.fecha || "").split("T")[0],
        total:   f.amounts?.total || f.montoTotal || f.total || 0,
        tipo:    f.documentType?.code || f.tipo || 33,
        estado:  f.status?.name || f.estado || "",
      };
    }
    // Formato API antigua
    return {
      folio:   String(f.Folio || f.folio || ""),
      cliente: f.RazonSocial || f.razonSocial || f.cliente || "",
      rut:     f.RutCliente || f.rutCliente || f.rut || "",
      fecha:   (f.FechaEmision || f.fechaEmision || f.fecha || "").split("T")[0],
      total:   f.MontoTotal || f.montoTotal || f.total || 0,
      tipo:    f.CodigoTipoDocumento || f.tipo || 33,
      estado:  f.Estado || f.estado || "",
    };
  });
}
