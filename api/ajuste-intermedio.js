/**
 * POST /api/ajuste-intermedio
 * Guarda a mano el detalle de "ajuste intermedio" de un contrato (pasos de
 * renta pactados en el contrato original o sus anexos que no siguen el
 * % de reajuste plano de la planilla — ej: Trane 5-A tiene 385.93 UF -> 404.43
 * UF (01-09-2023) -> 407.92 UF (01-09-2026) -> +5% cada 3 años en adelante).
 * Vive en ajustes-contratos.json (vía GitHub API), nunca en la Planilla.
 *
 * Body: {
 *   rut: string, sitio: string,
 *   pasos: [{fecha:"YYYY-MM-DD", uf?:number, pct?:number}],
 *   recurrente?: {pct:number, cadaAnios:number, desde?:"YYYY-MM-DD"},
 *   notas?: string
 * }
 * Si pasos está vacío y no hay recurrente ni notas, se borra la entrada.
 *
 * Env vars requeridas:
 *   GITHUB_TOKEN  - Personal Access Token con permiso repo
 *   GITHUB_REPO   - "usuario/repositorio" (ej: "WurfelSPA/facturacion-patagonica")
 */

const GITHUB_REPO_DEFAULT = 'WurfelSPA/facturacion-patagonica';
const CACHE_FILE = 'ajustes-contratos.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function keyFor(rut, sitio) {
  return `${String(rut).trim()}|${String(sitio || '').trim()}`;
}

async function readFromGitHub(githubToken, repo) {
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

async function writeToGitHub(data, sha, githubToken, repo) {
  const apiBase = `https://api.github.com/repos/${repo}/contents/${CACHE_FILE}`;
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const body = {
    message: `chore: ajuste intermedio contrato ${new Date().toISOString().slice(0, 10)}`,
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

  const { rut, sitio, pasos, recurrente, notas } = req.body || {};
  if (!rut || typeof rut !== 'string') return res.status(400).json({ error: 'Falta rut' });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'Falta GITHUB_TOKEN' });

  try {
    const { data: cache, sha } = await readFromGitHub(GITHUB_TOKEN, GITHUB_REPO);
    if (!cache.items) cache.items = {};
    const key = keyFor(rut, sitio);
    const pasosLimpios = Array.isArray(pasos)
      ? pasos.filter(p => p && p.fecha).map(p => ({
          fecha: String(p.fecha),
          ...(typeof p.uf === 'number' ? { uf: p.uf } : {}),
          ...(typeof p.pct === 'number' ? { pct: p.pct } : {})
        }))
      : [];
    const tieneRecurrente = recurrente && typeof recurrente.pct === 'number' && typeof recurrente.cadaAnios === 'number';
    const tieneNotas = typeof notas === 'string' && notas.trim();

    if (pasosLimpios.length === 0 && !tieneRecurrente && !tieneNotas) {
      delete cache.items[key];
    } else {
      cache.items[key] = {
        pasos: pasosLimpios,
        ...(tieneRecurrente ? { recurrente: { pct: recurrente.pct, cadaAnios: recurrente.cadaAnios, ...(recurrente.desde ? { desde: String(recurrente.desde) } : {}) } } : {}),
        ...(tieneNotas ? { notas: notas.trim() } : {})
      };
    }
    cache.updatedAt = new Date().toISOString();

    await writeToGitHub(cache, sha, GITHUB_TOKEN, GITHUB_REPO);
    return res.status(200).json({ ok: true, key, item: cache.items[key] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
