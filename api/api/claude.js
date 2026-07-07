/**
 * /api/claude
 * GET  → sirve variables de configuración como <script> (ex /api/config)
 * POST → proxy hacia Anthropic API (mantiene la API key en servidor)
 */
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, anthropic-version, anthropic-beta');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: exponer variables de config al frontend (ex /api/config) ────────────
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(`
      window.__PAT_KEY__ = ${JSON.stringify(process.env.PAT_ANTHROPIC_KEY || "")};
      window.__PAT_GID__ = ${JSON.stringify(process.env.PAT_GMAIL_CLIENT_ID || "")};
      window.__TG_BOT__ = ${JSON.stringify(process.env.PAT_TG_BOT || "")};
      window.__TG_CHAT__ = ${JSON.stringify(process.env.PAT_TG_CHAT || "")};
    `);
  }

  // ── POST: proxy hacia Anthropic ───────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.PAT_ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'PAT_ANTHROPIC_KEY no configurada en Vercel' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
