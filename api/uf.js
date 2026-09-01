/**
 * /api/uf
 * GET → valor UF de hoy, vía mindicador.cl (proxy server-side).
 * Evita depender de que el navegador del cliente pueda llegar directo a
 * mindicador.cl (bloqueado/inestable en algunas redes móviles) — el propio
 * front-end de facturacion-patagonica.vercel.app llama a este endpoint en
 * vez de mindicador.cl directamente.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const r = await fetch("https://mindicador.cl/api/uf");
    if (!r.ok) throw new Error("mindicador.cl HTTP " + r.status);
    const d = await r.json();
    const valor = d?.serie?.[0]?.valor;
    if (!valor) throw new Error("Respuesta sin UF");
    res.setHeader("Cache-Control", "public, max-age=1800");
    return res.status(200).json({ valor });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
