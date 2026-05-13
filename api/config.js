export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  // Inyectar variables de entorno de Vercel como variables JS globales
  // Las variables NUNCA aparecen en el código fuente de GitHub
  res.send(`
    window.__PAT_KEY__ = ${JSON.stringify(process.env.PAT_ANTHROPIC_KEY || "")};
    window.__PAT_GID__ = ${JSON.stringify(process.env.PAT_GMAIL_CLIENT_ID || "")};
  `);
}
