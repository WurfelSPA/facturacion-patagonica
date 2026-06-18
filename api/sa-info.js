// Endpoint temporal — devuelve solo el client_email del SA (no la clave privada)
// BORRAR después de obtener el email
export default function handler(req, res) {
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saRaw) return res.status(500).json({ error: "GOOGLE_SERVICE_ACCOUNT no configurada" });
  try {
    const sa = JSON.parse(saRaw);
    res.json({ client_email: sa.client_email, project_id: sa.project_id });
  } catch {
    res.status(500).json({ error: "JSON inválido" });
  }
}
