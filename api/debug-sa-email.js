export default async function handler(req, res) {
  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    return res.status(200).json({ client_email: sa.client_email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
