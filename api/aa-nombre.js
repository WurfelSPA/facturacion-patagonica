/**
 * POST /api/aa-nombre
 * Actualiza a mano el campo "nombre" de una cuenta de Aguas Andinas en
 * aa-cache.json — mientras Khipu no esté activado comercialmente (devuelve
 * 401 y nunca llena ese campo), esta es la única fuente para poder comparar
 * el nombre real de la cuenta AA contra el cliente de la planilla.
 *
 * Body: { idAgua: string, nombre: string }
 *
 * Env vars requeridas:
 *   GITHUB_TOKEN  - Personal Access Token con permiso repo
 *   GITHUB_REPO   - "usuario/repositorio" (ej: "WurfelSPA/facturacion-patagonica")
 */

const GITHUB_REPO_DEFAULT = 'WurfelSPA/facturacion-patagonica';
const CACHE_FILE = 'aa-cache.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readCacheFromGitHub(githubToken, repo) {
  const apiBase = `https://api.github.com/repos/${repo}/contents/${CACHE_FILE}`;
  const res = await fetch(apiBase, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf-8');
  return { data: JSON.parse(content), sha: json.sha };
}

async function updateCacheViaGitHub(data, sha, githubToken, repo) {
  const apiBase = `https://api.github.com/repos/${repo}/contents/${CACHE_FILE}`;
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const body = {
    message: `chore: nombre AA manual ${new Date().toISOString().slice(0, 10)}`,
    content,
    sha
  };
  const res = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${err.slice(0, 200)}`);
  }
  return await res.json();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { idAgua, nombre } = req.body || {};
  if (!idAgua || typeof idAgua !== 'string') return res.status(400).json({ error: 'Falta idAgua' });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'Falta GITHUB_TOKEN' });

  try {
    const { data: cache, sha } = await readCacheFromGitHub(GITHUB_TOKEN, GITHUB_REPO);
    if (!cache.accounts) cache.accounts = {};
    if (!cache.accounts[idAgua]) cache.accounts[idAgua] = { deuda: null };
    cache.accounts[idAgua].nombre = (typeof nombre === 'string' && nombre.trim()) ? nombre.trim() : null;

    await updateCacheViaGitHub(cache, sha, GITHUB_TOKEN, GITHUB_REPO);
    return res.status(200).json({ ok: true, idAgua, nombre: cache.accounts[idAgua].nombre });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
