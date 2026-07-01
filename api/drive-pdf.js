/**
 * /api/drive-pdf
 * GET ?folio=14670&periodo=2026-06
 *   Ruta 0: PDF individual F-14670*.pdf en FACT_FOLDER_ID
 *   Ruta 1: PDF general Facturas_PISA_2026-06.pdf en FACT_FOLDER_ID
 *   Ruta 2: búsqueda global en Drive
 * Todos los errores quedan capturados — nunca crashea el proceso.
 */

export const config = { api: { bodyParser: false } };

const FACT_FOLDER_ID = "1O1nBsti_reAKnAXXKdL2opNWz1ocZu8u";

const MES_NUM = {
  Enero:"01", Febrero:"02", Marzo:"03", Abril:"04", Mayo:"05", Junio:"06",
  Julio:"07", Agosto:"08", Septiembre:"09", Octubre:"10", Noviembre:"11", Diciembre:"12",
};

function parsePeriodo(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\w+)\s+(\d{4})$/);
  if (!m) return null;
  const mes = MES_NUM[m[1]];
  return mes ? `${m[2]}-${mes}` : null;
}

async function signJWT(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = o => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const input = `${enc(header)}.${enc(payload)}`;
  const pem = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${input}.${sigB64}`;
}

async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }, sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("SA token: " + JSON.stringify(d));
  return d.access_token;
}

async function driveGet(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Drive ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function findPdfGlobal(token, folio) {
  const q = encodeURIComponent(
    `name contains 'F-${folio}' and mimeType='application/pdf' and trashed=false`
  );
  const d = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const files = (d && d.files) || [];
  if (!files.length) return null;
  return files.find(f =>
    f && f.name && (f.name.startsWith(`F-${folio} `) || f.name.startsWith(`F-${folio}.`))
  ) || files[0] || null;
}

export default async function handler(req, res) {
  try {
    // -- Validar folio --
    const folioRaw = Array.isArray(req.query.folio) ? req.query.folio[0] : req.query.folio;
    const folio = String(folioRaw || "").trim();
    if (!folio || !/^\d+$/.test(folio)) {
      return res.status(400).json({ error: "Parámetro folio inválido (debe ser entero)" });
    }

    // -- Service Account --
    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!saRaw) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
    let sa;
    try { sa = JSON.parse(saRaw); } catch {
      return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT formato inválido" });
    }

    // -- Token --
    let token;
    try { token = await getToken(sa); } catch (e) {
      return res.status(500).json({ error: "Error de autenticación: " + e.message });
    }

    // -- Periodo --
    const periodoRaw = Array.isArray(req.query.periodo) ? req.query.periodo[0] : req.query.periodo;
    const periodo = parsePeriodo(periodoRaw);

    // ── Ruta 0: PDF individual en carpeta de facturas ────────────────────────
    try {
      const q0 = encodeURIComponent(
        `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false` +
        ` and (name contains 'F-${folio} ' or name contains 'F-${folio}.'` +
        ` or name='F-${folio}.pdf' or name contains 'FEE-${folio} '` +
        ` or name contains 'FEE-${folio}.')`
      );
      const d0 = await driveGet(token,
        `https://www.googleapis.com/drive/v3/files?q=${q0}` +
        `&fields=files(id,name)&pageSize=10` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      const f0 = ((d0 && d0.files) || []).find(f => f && f.id);
      if (f0) {
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, `https://drive.google.com/file/d/${f0.id}/view`);
      }
    } catch (e0) {
      console.warn("drive-pdf R0:", e0 && e0.message);
    }

    // ── Ruta 1: PDF general del período (Facturas_PISA_YYYY-MM.pdf) ──────────
    if (periodo) {
      try {
        const parts = periodo.split("-");
        const anio = parts[0] || "";
        const mesNum = parts[1] || "";
        const q1 = encodeURIComponent(
          `'${FACT_FOLDER_ID}' in parents and mimeType='application/pdf'` +
          ` and trashed=false and name contains 'PISA'`
        );
        const d1 = await driveGet(token,
          `https://www.googleapis.com/drive/v3/files?q=${q1}` +
          `&fields=files(id,name)&pageSize=20` +
          `&supportsAllDrives=true&includeItemsFromAllDrives=true`);
        const all1 = (d1 && d1.files) || [];
        const gen = all1.find(f => {
          if (!f || !f.name || !f.id) return false;
          const n = f.name.toLowerCase();
          return n.endsWith(".pdf") && n.includes("pisa") && (
            n.includes(`${anio}-${mesNum}`) ||
            n.includes(`${mesNum}-${anio}`) ||
            n.includes(`_${mesNum}_`) ||
            n.includes(`-${mesNum}.pdf`)
          );
        });
        if (gen) {
          console.log("drive-pdf R1 →", gen.name);
          res.setHeader("Cache-Control", "no-store");
          return res.redirect(302, `https://drive.google.com/file/d/${gen.id}/preview`);
        }
      } catch (e1) {
        console.warn("drive-pdf R1:", e1 && e1.message);
      }
    }

    // ── Ruta 2: búsqueda global en Drive ─────────────────────────────────────
    try {
      const f2 = await findPdfGlobal(token, folio);
      if (f2 && f2.id) {
        res.setHeader("Cache-Control", "public, max-age=3600");
        return res.redirect(302, `https://drive.google.com/file/d/${f2.id}/view`);
      }
    } catch (e2) {
      console.warn("drive-pdf R2:", e2 && e2.message);
    }

    return res.status(404).json({
      error: `PDF para folio ${folio} no encontrado`,
      periodo: periodo || "no especificado",
      hint: "Verifica que Facturas_PISA_YYYY-MM.pdf o F-{folio}.pdf estén en la carpeta de Drive.",
    });

  } catch (err) {
    console.error("drive-pdf CRASH:", err && (err.stack || err.message));
    if (!res.headersSent) {
      return res.status(500).json({
        error: "Error interno",
        detail: String(err && err.message || err),
      });
    }
  }
}
