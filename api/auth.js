/**
 * /api/auth
 * POST ?action=init            → (admin, una sola vez) crea credentials.json en Drive
 * POST ?action=login           → valida email+password, retorna cookie JWT
 * GET  ?action=logout          → borra cookie, redirige a /
 * GET  ?action=me              → retorna {email, name} desde cookie
 * POST ?action=change-password → cambia contraseña (requiere cookie válida)
 * POST ?action=forgot-password → envía email de reset via Resend
 * GET  ?action=reset-form&token=XX → sirve HTML formulario de nueva clave
 * POST ?action=reset-password  → valida token y actualiza contraseña
 */

export const config = { api: { bodyParser: true } };

// Node.js 18: crypto global = legacy module; Web Crypto API lives in globalThis.crypto
const webcrypto = globalThis.crypto;

// ── Helpers JWT (HMAC-SHA256) ────────────────────────────────────────────────
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlStr(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlDecode(str) {
  return atob(str.replace(/-/g,'+').replace(/_/g,'/'));
}

async function getHmacKey(secret) {
  return webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify']
  );
}

async function signToken(payload, secret) {
  const header = b64urlStr(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body   = b64urlStr(JSON.stringify(payload));
  const key    = await getHmacKey(secret);
  const sig    = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  const parts = (token||'').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await getHmacKey(secret);
  const raw = Uint8Array.from(b64urlDecode(sig), c=>c.charCodeAt(0));
  const ok  = await webcrypto.subtle.verify('HMAC', key, raw, new TextEncoder().encode(`${header}.${body}`));
  if (!ok) return null;
  const payload = JSON.parse(decodeURIComponent(escape(b64urlDecode(body))));
  if (payload.exp < Math.floor(Date.now()/1000)) return null;
  return payload;
}

function makeCookie(token, maxAge=28800) {
  return `auth_token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Path=/`;
}

// ── Helpers PBKDF2 (password hashing) ───────────────────────────────────────
function hexEncode(buf) {
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function generateSalt() {
  return hexEncode(webcrypto.getRandomValues(new Uint8Array(16)));
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits(
    {name:'PBKDF2', salt:enc.encode(salt), iterations:100000, hash:'SHA-256'},
    key, 256
  );
  return hexEncode(bits);
}
async function sha256hex(str) {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return hexEncode(buf);
}

// ── Google Drive helpers ──────────────────────────────────────────────────────
async function saToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now()/1000);
  const header = b64urlStr(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claim  = b64urlStr(JSON.stringify({
    iss:sa.client_email, scope:'https://www.googleapis.com/auth/drive',
    aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key = await webcrypto.subtle.importKey(
    'pkcs8', Uint8Array.from(atob(pem),c=>c.charCodeAt(0)).buffer,
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']
  );
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;
  const r = await fetch('https://oauth2.googleapis.com/token',{
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA token error: '+JSON.stringify(d));
  return d.access_token;
}

async function readCredentials(token) {
  const id = process.env.DRIVE_CREDENTIALS_ID;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,{
    headers:{Authorization:`Bearer ${token}`}
  });
  if (!r.ok) throw new Error('readCredentials: '+r.status);
  return r.json();
}

async function writeCredentials(token, data) {
  const id = process.env.DRIVE_CREDENTIALS_ID;
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,{
    method:'PATCH',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body: JSON.stringify(data, null, 2)
  });
  if (!r.ok) throw new Error('writeCredentials: '+r.status+' '+(await r.text()));
}

async function createCredentialsFile(token, folderId, data) {
  const meta = JSON.stringify({name:'credentials.json', parents:[folderId], mimeType:'application/json'});
  const body = JSON.stringify(data, null, 2);
  const boundary = 'patagonica_bound';
  const multipart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/related; boundary=${boundary}`},
    body: multipart
  });
  if (!r.ok) throw new Error('createFile: '+r.status+' '+(await r.text()));
  const d = await r.json();
  return d.id;
}

// ── Resend email ─────────────────────────────────────────────────────────────
async function sendResetEmail(to, name, resetUrl) {
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const r = await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body: JSON.stringify({
      from, to,
      subject: 'Recuperar contraseña — Portal Patagónica',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Recuperar contraseña</h2>
        <p>Hola ${name},</p>
        <p>Haz clic en el botón para crear una nueva contraseña. El link expira en <strong>1 hora</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Crear nueva contraseña
        </a>
        <p style="color:#666;font-size:13px">Si no solicitaste este cambio, ignora este mensaje.</p>
        <p style="color:#999;font-size:12px">${resetUrl}</p>
      </div>`
    })
  });
  if (!r.ok) throw new Error('Resend error: '+(await r.text()));
}

// ── Cookie parser ─────────────────────────────────────────────────────────────
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || '';
  const JWT_SECRET = process.env.JWT_SECRET || '';

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (action==='init') {
    const { folderId, users } = req.body || {};
    if (!folderId || !Array.isArray(users) || !users.length)
      return res.status(400).json({error:'Requiere folderId y users[]'});
    const token = await saToken();
    const credentials = {};
    for (const u of users) {
      const salt = generateSalt();
      const hash = await hashPassword('123', salt);
      credentials[u.email.toLowerCase()] = {
        name: u.name, hash, salt, mustChangePassword: true,
        resetToken: null, resetTokenExpiry: null
      };
    }
    const fileId = await createCredentialsFile(token, folderId, credentials);
    return res.status(200).json({ok:true, fileId, message:`credentials.json creado. Agrega DRIVE_CREDENTIALS_ID=${fileId} en Vercel.`});
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  if (action==='login') {
    const { email='', password='' } = req.body || {};
    if (!email || !password)
      return res.status(400).json({error:'Email y contraseña requeridos'});

    let creds;
    try {
      const token = await saToken();
      creds = await readCredentials(token);
    } catch(e) {
      return res.status(500).json({error:'Error leyendo credenciales'});
    }

    const user = creds[email.toLowerCase()];
    if (!user) return res.status(401).json({error:'Email o contraseña incorrectos'});

    const hash = await hashPassword(password, user.salt);
    if (hash !== user.hash) return res.status(401).json({error:'Email o contraseña incorrectos'});

    const payload = {
      email: email.toLowerCase(),
      name: user.name,
      mustChangePassword: !!user.mustChangePassword,
      exp: Math.floor(Date.now()/1000) + 28800
    };
    const jwt = await signToken(payload, JWT_SECRET);
    res.setHeader('Set-Cookie', makeCookie(jwt));
    return res.status(200).json({ok:true, name:user.name, mustChangePassword:!!user.mustChangePassword});
  }

  // ── LOGOUT ────────────────────────────────────────────────────────────────
  if (action==='logout') {
    res.setHeader('Set-Cookie', makeCookie('', -1));
    res.setHeader('Location', '/');
    return res.status(302).end();
  }

  // ── ME ────────────────────────────────────────────────────────────────────
  if (action==='me') {
    const cookieToken = parseCookie(req.headers.cookie, 'auth_token');
    const payload = await verifyToken(cookieToken, JWT_SECRET);
    if (!payload) return res.status(401).json({error:'No autenticado'});
    return res.status(200).json({email:payload.email, name:payload.name, mustChangePassword:!!payload.mustChangePassword});
  }

  // ── CHANGE-PASSWORD ───────────────────────────────────────────────────────
  if (action==='change-password') {
    const cookieToken = parseCookie(req.headers.cookie, 'auth_token');
    const payload = await verifyToken(cookieToken, JWT_SECRET);
    if (!payload) return res.status(401).json({error:'No autenticado'});

    const { currentPassword='', newPassword='' } = req.body || {};
    if (newPassword.length < 8)
      return res.status(400).json({error:'La nueva contraseña debe tener al menos 8 caracteres'});

    const driveToken = await saToken();
    const creds = await readCredentials(driveToken);
    const user = creds[payload.email];
    if (!user) return res.status(404).json({error:'Usuario no encontrado'});

    if (!user.mustChangePassword) {
      if (!currentPassword) return res.status(400).json({error:'Contraseña actual requerida'});
      const currentHash = await hashPassword(currentPassword, user.salt);
      if (currentHash !== user.hash)
        return res.status(401).json({error:'Contraseña actual incorrecta'});
    }

    const salt = generateSalt();
    const hash = await hashPassword(newPassword, salt);
    creds[payload.email] = {...user, hash, salt, mustChangePassword: false};
    await writeCredentials(driveToken, creds);

    const newPayload = {email:payload.email, name:payload.name, mustChangePassword:false,
      exp: Math.floor(Date.now()/1000) + 28800};
    const jwt = await signToken(newPayload, JWT_SECRET);
    res.setHeader('Set-Cookie', makeCookie(jwt));
    return res.status(200).json({ok:true});
  }

  // ── FORGOT-PASSWORD ───────────────────────────────────────────────────────
  if (action==='forgot-password') {
    const { email='' } = req.body || {};
    if (!email) return res.status(400).json({error:'Email requerido'});

    const driveToken = await saToken();
    const creds = await readCredentials(driveToken);
    const user = creds[email.toLowerCase()];
    if (!user) return res.status(200).json({ok:true});

    const rawToken = hexEncode(webcrypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256hex(rawToken);
    const expiry = Math.floor(Date.now()/1000) + 3600;
    creds[email.toLowerCase()] = {...user, resetToken:tokenHash, resetTokenExpiry:expiry};
    await writeCredentials(driveToken, creds);

    const resetUrl = `https://facturacion-patagonica.vercel.app/api/auth?action=reset-form&token=${rawToken}&email=${encodeURIComponent(email.toLowerCase())}`;
    await sendResetEmail(email, user.name, resetUrl);
    return res.status(200).json({ok:true});
  }

  // ── RESET-FORM ────────────────────────────────────────────────────────────
  if (action==='reset-form') {
    const { token='', email='' } = req.query;
    let valid = false;
    let userName = '';
    try {
      const driveToken = await saToken();
      const creds = await readCredentials(driveToken);
      const user = creds[email.toLowerCase()];
      if (user && user.resetToken) {
        const tokenHash = await sha256hex(token);
        const notExpired = user.resetTokenExpiry > Math.floor(Date.now()/1000);
        valid = tokenHash === user.resetToken && notExpired;
        userName = user.name;
      }
    } catch(e) { valid = false; }

    const html = valid ? `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nueva contraseña — Patagónica</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f7;font-family:system-ui,sans-serif}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:8px}
p{color:#666;font-size:14px;margin-bottom:24px}
label{font-size:13px;font-weight:600;color:#444;display:block;margin-bottom:6px}
input{width:100%;padding:10px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:14px;outline:none;transition:.2s;margin-bottom:16px}
input:focus{border-color:#4f46e5}
button{width:100%;padding:12px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#3730a3}
.msg{margin-top:16px;padding:10px 14px;border-radius:8px;font-size:13px;display:none}
.msg.ok{background:#d1fae5;color:#065f46}
.msg.err{background:#fee2e2;color:#991b1b}
</style></head><body>
<div class="card">
  <h1>Nueva contraseña</h1>
  <p>Hola ${userName}, ingresa tu nueva contraseña.</p>
  <label>Nueva contraseña</label>
  <input type="password" id="p1" placeholder="Mínimo 8 caracteres" minlength="8">
  <label>Confirmar contraseña</label>
  <input type="password" id="p2" placeholder="Repite la contraseña">
  <button onclick="submit()">Guardar contraseña</button>
  <div class="msg" id="msg"></div>
</div>
<script>
async function submit(){
  const p1=document.getElementById('p1').value;
  const p2=document.getElementById('p2').value;
  const msg=document.getElementById('msg');
  if(p1.length<8){showMsg('La contraseña debe tener al menos 8 caracteres','err');return;}
  if(p1!==p2){showMsg('Las contraseñas no coinciden','err');return;}
  const r=await fetch('/api/auth?action=reset-password',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:'${token}',email:'${email.toLowerCase()}',newPassword:p1})});
  const d=await r.json();
  if(d.ok){showMsg('¡Contraseña actualizada! Redirigiendo...','ok');setTimeout(()=>location.href='/',2000);}
  else showMsg(d.error||'Error al actualizar','err');
}
function showMsg(t,c){const m=document.getElementById('msg');m.textContent=t;m.className='msg '+c;m.style.display='block';}
</script></body></html>`
    : `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Link inválido</title>
<style>body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#f5f5f7}
.card{background:#fff;border-radius:16px;padding:40px;max-width:360px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#991b1b;margin-bottom:12px}p{color:#666;font-size:14px;margin-bottom:24px}
a{color:#4f46e5;font-size:14px}</style></head><body>
<div class="card"><h1>Link expirado</h1>
<p>Este link ya no es válido. Los links de recuperación expiran en 1 hora y son de un solo uso.</p>
<a href="/">Volver al portal</a></div></body></html>`;

    res.setHeader('Content-Type','text/html');
    return res.status(valid?200:400).send(html);
  }

  // ── RESET-PASSWORD ────────────────────────────────────────────────────────
  if (action==='reset-password') {
    const { token='', email='', newPassword='' } = req.body || {};
    if (!token || !email || !newPassword)
      return res.status(400).json({error:'Datos incompletos'});
    if (newPassword.length < 8)
      return res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres'});

    const driveToken = await saToken();
    const creds = await readCredentials(driveToken);
    const user = creds[email.toLowerCase()];
    if (!user || !user.resetToken)
      return res.status(400).json({error:'Token inválido'});

    const tokenHash = await sha256hex(token);
    if (tokenHash !== user.resetToken)
      return res.status(400).json({error:'Token inválido'});
    if (user.resetTokenExpiry < Math.floor(Date.now()/1000))
      return res.status(400).json({error:'El link expiró. Solicita uno nuevo.'});

    const salt = generateSalt();
    const hash = await hashPassword(newPassword, salt);
    creds[email.toLowerCase()] = {...user, hash, salt, mustChangePassword:false, resetToken:null, resetTokenExpiry:null};
    await writeCredentials(driveToken, creds);
    return res.status(200).json({ok:true});
  }

  return res.status(400).json({error:'Action desconocida'});
  } catch(e) {
    console.error('auth error:', e);
    return res.status(500).json({error: String(e.message||e), stack: e.stack});
  }
}
                                                                                                                                                                                                                             