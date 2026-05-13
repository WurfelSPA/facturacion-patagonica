export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`
    window.__PAT_KEY__ = ${JSON.stringify(process.env.PAT_ANTHROPIC_KEY || "")};
    window.__PAT_GID__ = ${JSON.stringify(process.env.PAT_GMAIL_CLIENT_ID || "")};
    window.__TG_BOT__ = ${JSON.stringify(process.env.PAT_TG_BOT || "")};
    window.__TG_CHAT__ = ${JSON.stringify(process.env.PAT_TG_CHAT || "")};
  `);
}
