# Auth System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proteger el portal de facturación con login httpOnly, sesiones de 8h, cambio de contraseña obligatorio en primer ingreso, y reset por email (Resend).

**Architecture:** Vercel Edge Middleware (`middleware.js`) valida una cookie JWT httpOnly antes de servir cualquier contenido. Si la cookie falta o es inválida, el middleware retorna directamente el HTML de login (sin servir `index.html`). Toda la lógica de auth vive en `api/auth.js` (reemplaza `api/sa-info.js` que era un 404 muerto). Las credenciales se almacenan como `credentials.json` en Google Drive, accedido por el Service Account existente.

**Tech Stack:** `@vercel/edge` (middleware pass-through), Web Crypto API (PBKDF2-SHA256 + HMAC-SHA256), Resend REST API (fetch puro, sin SDK), Google Drive API (service account existente).

---

## Mapa de Archivos

| Archivo | Acción | Responsabilidad |
|---------|--------|-----------------|
| `middleware.js` | Crear | Validar cookie JWT; servir HTML login/force-change inline |
| `api/auth.js` | Crear (reemplaza `api/sa-info.js`) | Actions: init, login, logout, me, change-password, forgot-password, reset-form, reset-password |
| `api/sa-info.js` | Eliminar | Era un 404 stub |
| `index.html` | Modificar | Menú usuario: nombre, cambiar clave, cerrar sesión |
| `vercel.json` | Modificar | Eliminar referencia a sa-info.js (no estaba en functions config, ya ok) |
| `package.json` | Modificar | Agregar `@vercel/edge` |

---

## Variables de Entorno (agregar en Vercel Dashboard)

| Variable | Valor |
|----------|-------|
| `JWT_SECRET` | `79fe2309d2826629e50aaafc9e9db152e41f04db2b980a00e5d8e138086451dd030ad40b41edcf95dd1b22e88438cdff9398e3132e2c10486ad0dbb6a4b242c3` |
| `RESEND_API_KEY` | tu key `re_Ayj...` de resend.com |
| `RESEND_FROM` | `onboarding@resend.dev` (provisional hasta verificar dominio) |
| `DRIVE_CREDENTIALS_ID` | ID retornado por el endpoint de init (Task 3) |
| `GOOGLE_SERVICE_ACCOUNT` | Ya configurada ✓ |

---

## Task 1: package.json — agregar @vercel/edge

**Files:**
- Modify: `package.json`

- [ ] **Paso 1: Agregar dependencia**

```json
{
  "dependencies": {
    "@vercel/edge": "^1.1.1",
    "jszip": "3.10.1",
    "node-forge": "^1.3.1",
    "pdf-lib": "^1.17.1",
    "xml-crypto": "^6.0.0"
  }
}
```

- [ ] **Paso 2: Instalar**

```bash
npm install @vercel/edge
```

- [ ] **Paso 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @vercel/edge for middleware"
```

---

## Task 2: Eliminar api/sa-info.js

**Files:**
- Delete: `api/sa-info.js`

- [ ] **Paso 1: Eliminar el archivo**

```bash
rm api/sa-info.js
```

- [ ] **Paso 2: Verificar que vercel.json no lo referencia**

En `vercel.json`, la sección `functions` no incluye `api/sa-info.js` — ya no estaba. Nada que cambiar.

- [ ] **Paso 3: Commit**

```bash
git add -A
git commit -m "chore: remove dead sa-info.js stub"
```

---

## Task 3: api/auth.js — Infraestructura base + action init

**Files:**
- Create: `api/auth.js`

Este task crea el archivo completo con todos los helpers y la action `init` que inicializa `credentials.json` en Drive leyendo la lista de usuarios desde un JSON body.

- [ ] **Paso 1: Crear api/auth.js con helpers y action init**

```javascript
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
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify']
  );
}

async function signToken(payload, secret) {
  const header = b64urlStr(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body   = b64urlStr(JSON.stringify(payload));
  const key    = await getHmacKey(secret);
  const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  const parts = (token||'').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await getHmacKey(secret);
  const raw = Uint8Array.from(b64urlDecode(sig), c=>c.charCodeAt(0));
  const ok  = await crypto.subtle.verify('HMAC', key, raw, new TextEncoder().encode(`${header}.${body}`));
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
  return hexEncode(crypto.getRandomValues(new Uint8Array(16)));
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name:'PBKDF2', salt:enc.encode(salt), iterations:100000, hash:'SHA-256'},
    key, 256
  );
  return hexEncode(bits);
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
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
  const key = await crypto.subtle.importKey(
    'pkcs8', Uint8Array.from(atob(pem),c=>c.charCodeAt(0)).buffer,
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
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
  // Crea credentials.json nuevo en Drive, retorna el fileId
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
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || '';
  const JWT_SECRET = process.env.JWT_SECRET || '';

  // ── INIT (una sola vez, protegido con CRON_SECRET) ──────────────────────────
  if (action==='init') {
    const secret = process.env.CRON_SECRET || '';
    const bearer = (req.headers.authorization||'').replace('Bearer ','');
    if (secret && bearer !== secret)
      return res.status(401).json({error:'Unauthorized'});

    // Body: { folderId: "Drive folder ID", users: [{email, name}] }
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
      exp: Math.floor(Date.now()/1000) + 28800  // 8 horas
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
    return res.status(200).json({email:payload.email, name:payload.name});
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

    // Si NO es cambio forzado, verificar contraseña actual
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

    // Emitir nueva cookie sin el flag mustChangePassword
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
    // Siempre responder OK para no revelar si el email existe
    if (!user) return res.status(200).json({ok:true});

    const rawToken = hexEncode(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256hex(rawToken);
    const expiry = Math.floor(Date.now()/1000) + 3600; // 1 hora
    creds[email.toLowerCase()] = {...user, resetToken:tokenHash, resetTokenExpiry:expiry};
    await writeCredentials(driveToken, creds);

    const resetUrl = `https://facturacion-patagonica.vercel.app/api/auth?action=reset-form&token=${rawToken}&email=${encodeURIComponent(email.toLowerCase())}`;
    await sendResetEmail(email, user.name, resetUrl);
    return res.status(200).json({ok:true});
  }

  // ── RESET-FORM (sirve HTML con formulario) ────────────────────────────────
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
}
```

- [ ] **Paso 2: Verificar que el archivo existe**

```bash
ls -la api/auth.js
```

Esperado: archivo de ~280 líneas creado.

- [ ] **Paso 3: Commit**

```bash
git add api/auth.js
git commit -m "feat: add api/auth.js with all auth actions"
```

---

## Task 4: Inicializar credentials.json en Drive

Este task llama al endpoint `init` para crear el archivo `credentials.json` en Drive con todos los usuarios del Excel.

- [ ] **Paso 1: Preparar la lista de usuarios en formato JSON**

Abre el Excel "Credenciales Facturación Patagonica.xlsx" y crea este JSON con todos los usuarios (email + nombre):

```json
{
  "folderId": "ID_DE_CARPETA_FACTURACION_MENSUAL_EN_DRIVE",
  "users": [
    {"email": "amelendez@patagonica.cl", "name": "Alex"},
    {"email": "usuario2@patagonica.cl",  "name": "Nombre2"}
  ]
}
```

Para obtener el `folderId`: abre la carpeta "Facturación Mensual" en Drive → la URL tiene `.../folders/XXXXXXX` → eso es el ID.

- [ ] **Paso 2: Hacer deploy del código actual antes de llamar al endpoint**

```bash
git push
# Esperar que Vercel despliegue (~2 min)
```

- [ ] **Paso 3: Llamar al endpoint init con curl**

```bash
curl -X POST \
  "https://facturacion-patagonica.vercel.app/api/auth?action=init" \
  -H "Authorization: Bearer TU_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"folderId":"ID_CARPETA","users":[{"email":"amelendez@patagonica.cl","name":"Alex"}]}'
```

Esperado:
```json
{"ok":true,"fileId":"1xxxxxxxxxxx","message":"credentials.json creado. Agrega DRIVE_CREDENTIALS_ID=1xxxxxxxxxxx en Vercel."}
```

- [ ] **Paso 4: Agregar DRIVE_CREDENTIALS_ID en Vercel**

1. Ir a Vercel Dashboard → Settings → Environment Variables
2. Agregar `DRIVE_CREDENTIALS_ID` con el valor retornado
3. También agregar las demás variables de la tabla de env vars al inicio del plan
4. Hacer **Redeploy** desde Vercel (sin push — para que las env vars tomen efecto)

---

## Task 5: middleware.js — Edge middleware

**Files:**
- Create: `middleware.js`

- [ ] **Paso 1: Crear middleware.js en la raíz del proyecto**

```javascript
import { next } from '@vercel/edge';

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon\\.ico).*)']
};

const JWT_SECRET = () => process.env.JWT_SECRET || '';

// ── JWT verify (solo HMAC-SHA256, compatible con Edge Runtime) ──────────────
function b64urlDecode(str) {
  return atob(str.replace(/-/g,'+').replace(/_/g,'/'));
}
async function getHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'}, false, ['verify']
  );
}
async function verifyToken(token) {
  const parts = (token||'').split('.');
  if (parts.length !== 3) return null;
  try {
    const [header, body, sig] = parts;
    const key = await getHmacKey(JWT_SECRET());
    const raw = Uint8Array.from(b64urlDecode(sig), c=>c.charCodeAt(0));
    const ok  = await crypto.subtle.verify('HMAC', key, raw,
      new TextEncoder().encode(`${header}.${body}`));
    if (!ok) return null;
    const payload = JSON.parse(decodeURIComponent(escape(b64urlDecode(body))));
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

// ── HTML de login inline ─────────────────────────────────────────────────────
const loginHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Patagónica — Acceso</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
  font-family:system-ui,-apple-system,sans-serif}
.card{background:#fff;border-radius:20px;padding:44px 40px;width:100%;max-width:400px;
  box-shadow:0 20px 60px rgba(0,0,0,.3)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
.logo-icon{width:40px;height:40px;background:linear-gradient(135deg,#4f46e5,#7c3aed);
  border-radius:10px;display:flex;align-items:center;justify-content:center;
  font-size:20px;color:#fff;font-weight:700}
.logo-text{font-size:16px;font-weight:700;color:#1a1a2e}
.logo-sub{font-size:10px;color:#888;font-family:monospace}
h1{font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:6px}
p{color:#666;font-size:13px;margin-bottom:28px}
label{font-size:12px;font-weight:600;color:#444;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
input{width:100%;padding:11px 14px;border:1.5px solid #e0e0e0;border-radius:9px;
  font-size:14px;outline:none;transition:.2s;margin-bottom:16px;color:#1a1a2e}
input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.1)}
button{width:100%;padding:13px;background:#4f46e5;color:#fff;border:none;
  border-radius:9px;font-size:15px;font-weight:600;cursor:pointer;transition:.2s}
button:hover{background:#3730a3}
button:disabled{opacity:.6;cursor:not-allowed}
.forgot{display:block;text-align:center;margin-top:16px;font-size:13px;color:#4f46e5;
  text-decoration:none;cursor:pointer;background:none;border:none;width:100%}
.forgot:hover{text-decoration:underline}
.msg{margin-top:14px;padding:10px 14px;border-radius:8px;font-size:13px;display:none}
.msg.err{background:#fee2e2;color:#991b1b}
.forgot-form{display:none;margin-top:16px}
.back{background:none;border:none;color:#4f46e5;font-size:13px;cursor:pointer;padding:0;margin-bottom:12px}
.back:hover{text-decoration:underline}
</style></head><body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">⬡</div>
    <div><div class="logo-text">Patagónica</div><div class="logo-sub">Portal de Facturación</div></div>
  </div>
  <div id="login-view">
    <h1>Iniciar sesión</h1>
    <p>Ingresa con tu correo corporativo.</p>
    <label>Correo electrónico</label>
    <input type="email" id="email" placeholder="tu@patagonica.cl" autocomplete="email">
    <label>Contraseña</label>
    <input type="password" id="password" placeholder="••••••••" autocomplete="current-password"
      onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()" id="btn-login">Ingresar</button>
    <button class="forgot" onclick="showForgot()">Olvidé mi contraseña</button>
    <div class="msg" id="msg-login"></div>
  </div>
  <div id="forgot-view" style="display:none">
    <button class="back" onclick="showLogin()">← Volver</button>
    <h1>Recuperar contraseña</h1>
    <p>Te enviaremos un link a tu correo.</p>
    <label>Correo electrónico</label>
    <input type="email" id="forgot-email" placeholder="tu@patagonica.cl">
    <button onclick="sendReset()" id="btn-forgot">Enviar link</button>
    <div class="msg" id="msg-forgot"></div>
  </div>
</div>
<script>
function showForgot(){document.getElementById('login-view').style.display='none';document.getElementById('forgot-view').style.display='block';}
function showLogin(){document.getElementById('forgot-view').style.display='none';document.getElementById('login-view').style.display='block';}
function showMsg(id,text,type){const m=document.getElementById(id);m.textContent=text;m.className='msg '+type;m.style.display='block';}
async function login(){
  const btn=document.getElementById('btn-login');
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('password').value;
  if(!email||!password){showMsg('msg-login','Completa todos los campos','err');return;}
  btn.disabled=true;btn.textContent='Ingresando...';
  try{
    const r=await fetch('/api/auth?action=login',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email,password})});
    const d=await r.json();
    if(d.ok){window.location.reload();}
    else{showMsg('msg-login',d.error||'Error al ingresar','err');}
  }catch(e){showMsg('msg-login','Error de conexión','err');}
  finally{btn.disabled=false;btn.textContent='Ingresar';}
}
async function sendReset(){
  const btn=document.getElementById('btn-forgot');
  const email=document.getElementById('forgot-email').value.trim();
  if(!email){showMsg('msg-forgot','Ingresa tu correo','err');return;}
  btn.disabled=true;btn.textContent='Enviando...';
  try{
    await fetch('/api/auth?action=forgot-password',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email})});
    showMsg('msg-forgot','Si tu correo está registrado, recibirás un link en minutos.','ok'.replace('ok',''));
    document.getElementById('msg-forgot').style.background='#d1fae5';
    document.getElementById('msg-forgot').style.color='#065f46';
    document.getElementById('msg-forgot').style.display='block';
    document.getElementById('msg-forgot').textContent='Si tu correo está registrado, recibirás un link en minutos.';
  }catch(e){showMsg('msg-forgot','Error de conexión','err');}
  finally{btn.disabled=false;btn.textContent='Enviar link';}
}
</script></body></html>`;

// ── HTML de cambio obligatorio de contraseña ─────────────────────────────────
const forceChangeHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cambiar contraseña — Patagónica</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
  font-family:system-ui,-apple-system,sans-serif}
.card{background:#fff;border-radius:20px;padding:44px 40px;width:100%;max-width:400px;
  box-shadow:0 20px 60px rgba(0,0,0,.3)}
.badge{display:inline-block;background:#fef3c7;color:#92400e;border-radius:6px;
  font-size:11px;font-weight:700;padding:3px 10px;margin-bottom:20px;text-transform:uppercase}
h1{font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:8px}
p{color:#666;font-size:13px;margin-bottom:24px}
label{font-size:12px;font-weight:600;color:#444;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
input{width:100%;padding:11px 14px;border:1.5px solid #e0e0e0;border-radius:9px;
  font-size:14px;outline:none;transition:.2s;margin-bottom:16px}
input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.1)}
button{width:100%;padding:13px;background:#4f46e5;color:#fff;border:none;
  border-radius:9px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#3730a3}
button:disabled{opacity:.6;cursor:not-allowed}
.msg{margin-top:14px;padding:10px 14px;border-radius:8px;font-size:13px;display:none}
.msg.err{background:#fee2e2;color:#991b1b}
.msg.ok{background:#d1fae5;color:#065f46}
</style></head><body>
<div class="card">
  <div class="badge">Primer ingreso</div>
  <h1>Crea tu contraseña</h1>
  <p>Por seguridad, debes cambiar la contraseña inicial antes de continuar. Mínimo 8 caracteres.</p>
  <label>Nueva contraseña</label>
  <input type="password" id="p1" placeholder="Mínimo 8 caracteres">
  <label>Confirmar contraseña</label>
  <input type="password" id="p2" placeholder="Repite tu contraseña"
    onkeydown="if(event.key==='Enter')cambiar()">
  <button onclick="cambiar()" id="btn">Guardar y entrar</button>
  <div class="msg" id="msg"></div>
</div>
<script>
async function cambiar(){
  const btn=document.getElementById('btn');
  const p1=document.getElementById('p1').value;
  const p2=document.getElementById('p2').value;
  const msg=document.getElementById('msg');
  if(p1.length<8){show('La contraseña debe tener al menos 8 caracteres','err');return;}
  if(p1!==p2){show('Las contraseñas no coinciden','err');return;}
  btn.disabled=true;btn.textContent='Guardando...';
  try{
    const r=await fetch('/api/auth?action=change-password',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({newPassword:p1})});
    const d=await r.json();
    if(d.ok){show('¡Listo! Entrando al portal...','ok');setTimeout(()=>window.location.reload(),1200);}
    else show(d.error||'Error al guardar','err');
  }catch(e){show('Error de conexión','err');}
  finally{btn.disabled=false;btn.textContent='Guardar y entrar';}
}
function show(t,c){const m=document.getElementById('msg');m.textContent=t;m.className='msg '+c;m.style.display='block';}
</script></body></html>`;

// ── Middleware principal ──────────────────────────────────────────────────────
export default async function middleware(request) {
  const url = new URL(request.url);

  // Dejar pasar /api/auth sin verificación de cookie
  if (url.pathname.startsWith('/api/auth')) return next();

  const cookieHeader = request.headers.get('cookie') || '';
  const tokenMatch   = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]*)/);
  const token        = tokenMatch ? tokenMatch[1] : null;
  const payload      = await verifyToken(token);

  // Sin sesión válida → login
  if (!payload) {
    return new Response(loginHtml, {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
  }

  // Primer ingreso → cambio obligatorio de clave
  if (payload.mustChangePassword) {
    return new Response(forceChangeHtml, {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
  }

  return next();
}
```

- [ ] **Paso 2: Verificar que el archivo existe en la raíz**

```bash
ls -la middleware.js
```

Esperado: archivo en la raíz del proyecto (al mismo nivel que `index.html`).

- [ ] **Paso 3: Commit**

```bash
git add middleware.js
git commit -m "feat: add edge middleware for auth protection"
```

---

## Task 6: index.html — Menú de usuario

**Files:**
- Modify: `index.html` (función `Sidebar`, línea ~2766)

Agregar menú de usuario al pie de la sidebar con nombre, "Cambiar contraseña" y "Cerrar sesión".

- [ ] **Paso 1: Agregar CSS para menú usuario**

Justo antes del cierre del bloque `<style>` en `index.html`, agregar:

```css
.user-menu{padding:10px 6px;border-top:1px solid var(--bdr);}
.user-info{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;transition:.15s;white-space:nowrap;overflow:hidden;}
.user-info:hover{background:var(--surf2);}
.user-avatar{width:28px;height:28px;min-width:28px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc2));display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:700;flex-shrink:0;}
.user-name{font-size:11px;font-weight:600;color:var(--tx);}
.user-email{font-size:9px;color:var(--txm);font-family:'DM Mono',monospace;}
.user-dropdown{display:none;position:absolute;bottom:60px;left:6px;right:6px;background:var(--surf);border:1px solid var(--bdr);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:200;overflow:hidden;}
.user-dropdown.open{display:block;}
.user-dropdown button{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:none;background:transparent;text-align:left;font-size:12px;font-weight:500;color:var(--tx);cursor:pointer;font-family:'DM Sans',sans-serif;}
.user-dropdown button:hover{background:var(--surf2);}
.user-dropdown button.danger{color:#e53935;}
```

- [ ] **Paso 2: Agregar estado y lógica de usuario al componente App**

En la función `App()` de `index.html`, agregar el estado del usuario. Busca la línea donde empieza `function App()` y agrega dentro del cuerpo (junto a los demás `useState`):

```javascript
const [currentUser, setCurrentUser] = React.useState(null);
const [showChangePwd, setShowChangePwd] = React.useState(false);
const [userMenuOpen, setUserMenuOpen] = React.useState(false);

// Cargar info de usuario al montar
React.useEffect(()=>{
  fetch('/api/auth?action=me')
    .then(r=>r.ok?r.json():null)
    .then(d=>{ if(d&&d.email) setCurrentUser(d); })
    .catch(()=>{});
},[]);
```

- [ ] **Paso 3: Agregar modal de cambio de contraseña**

En `App()`, antes del `return`, agregar el modal:

```javascript
const ChangePwdModal = () => {
  const [cur, setCur] = React.useState('');
  const [np, setNp]   = React.useState('');
  const [np2, setNp2] = React.useState('');
  const [msg, setMsg] = React.useState('');
  const [ok,  setOk]  = React.useState(false);
  const submit = async () => {
    if (np.length < 8) { setMsg('Mínimo 8 caracteres'); return; }
    if (np !== np2)     { setMsg('Las contraseñas no coinciden'); return; }
    const r = await fetch('/api/auth?action=change-password', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({currentPassword:cur, newPassword:np})
    });
    const d = await r.json();
    if (d.ok) { setOk(true); setMsg('¡Contraseña actualizada!'); setTimeout(()=>setShowChangePwd(false),1500); }
    else setMsg(d.error||'Error');
  };
  return h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}},
    h('div',{style:{background:'var(--surf)',borderRadius:16,padding:32,width:360,boxShadow:'0 20px 60px rgba(0,0,0,.3)'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}},
        h('span',{style:{fontWeight:700,fontSize:16}},'Cambiar contraseña'),
        h('button',{onClick:()=>setShowChangePwd(false),style:{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'var(--txm)'}},'✕')
      ),
      h('label',{style:{fontSize:12,fontWeight:600,color:'var(--txm)',textTransform:'uppercase',letterSpacing:'.05em'}},'Contraseña actual'),
      h('input',{type:'password',value:cur,onChange:e=>setCur(e.target.value),
        style:{width:'100%',padding:'9px 12px',border:'1.5px solid var(--bdr)',borderRadius:8,fontSize:13,marginBottom:12,marginTop:4,background:'var(--bg)',color:'var(--tx)',outline:'none'}}),
      h('label',{style:{fontSize:12,fontWeight:600,color:'var(--txm)',textTransform:'uppercase',letterSpacing:'.05em'}},'Nueva contraseña'),
      h('input',{type:'password',value:np,onChange:e=>setNp(e.target.value),
        style:{width:'100%',padding:'9px 12px',border:'1.5px solid var(--bdr)',borderRadius:8,fontSize:13,marginBottom:12,marginTop:4,background:'var(--bg)',color:'var(--tx)',outline:'none'}}),
      h('label',{style:{fontSize:12,fontWeight:600,color:'var(--txm)',textTransform:'uppercase',letterSpacing:'.05em'}},'Confirmar nueva contraseña'),
      h('input',{type:'password',value:np2,onChange:e=>setNp2(e.target.value),
        onKeyDown:e=>e.key==='Enter'&&submit(),
        style:{width:'100%',padding:'9px 12px',border:'1.5px solid var(--bdr)',borderRadius:8,fontSize:13,marginBottom:16,marginTop:4,background:'var(--bg)',color:'var(--tx)',outline:'none'}}),
      msg && h('div',{style:{padding:'8px 12px',borderRadius:8,marginBottom:12,fontSize:13,
        background:ok?'#d1fae5':'#fee2e2',color:ok?'#065f46':'#991b1b'}},msg),
      h('button',{onClick:submit,style:{width:'100%',padding:'11px',background:'var(--acc)',color:'#fff',border:'none',borderRadius:8,fontWeight:600,cursor:'pointer',fontSize:14}},'Guardar contraseña')
    )
  );
};
```

- [ ] **Paso 4: Modificar la función Sidebar para incluir menú de usuario**

Reemplazar el último `h("div",{className:"sidebar-footer"}...)` en `Sidebar`:

```javascript
// Reemplazar esta línea:
h("div",{className:"sidebar-footer"},h("div",{className:"sidebar-footer-dot"}),h("span",null,VER))

// Por esto (requiere pasar currentUser, onChangePwd, userMenuOpen, setUserMenuOpen como props):
h("div",{className:"user-menu",style:{position:"relative"}},
  userMenuOpen && h("div",{className:"user-dropdown open"},
    h("button",{onClick:()=>{setUserMenuOpen(false);onChangePwd();}},"🔑  Cambiar contraseña"),
    h("button",{className:"danger",onClick:()=>window.location.href='/api/auth?action=logout'},"→  Cerrar sesión")
  ),
  h("div",{className:"user-info",onClick:()=>setUserMenuOpen(o=>!o)},
    h("div",{className:"user-avatar"},currentUser?currentUser.name[0].toUpperCase():"?"),
    h("div",null,
      h("div",{className:"user-name"},currentUser?currentUser.name:"Usuario"),
      h("div",{className:"user-email"},currentUser?currentUser.email:"")
    )
  )
)
```

- [ ] **Paso 5: Actualizar la llamada a Sidebar y el return de App**

En `App()`, actualizar la llamada a `Sidebar` para pasarle los nuevos props:

```javascript
// Agregar props: currentUser, onChangePwd, userMenuOpen, setUserMenuOpen
h(Sidebar,{view,setView,...otrosProps,
  currentUser, onChangePwd:()=>setShowChangePwd(true),
  userMenuOpen, setUserMenuOpen}),
// Agregar el modal y el overlay para cerrar el menú:
showChangePwd && h(ChangePwdModal),
userMenuOpen && h('div',{onClick:()=>setUserMenuOpen(false),
  style:{position:'fixed',inset:0,zIndex:99}})
```

- [ ] **Paso 6: Commit**

```bash
git add index.html
git commit -m "feat: add user menu with change-password and logout"
```

---

## Task 7: Deploy y prueba end-to-end

- [ ] **Paso 1: Push final**

```bash
git push
```

Esperar que Vercel despliegue (~2 min). Verificar que no haya errores en el log de Vercel.

- [ ] **Paso 2: Confirmar variables de entorno en Vercel**

En Vercel → Settings → Environment Variables, verificar que existen:
- `JWT_SECRET` ✓
- `RESEND_API_KEY` ✓
- `RESEND_FROM` ✓
- `DRIVE_CREDENTIALS_ID` ✓
- `GOOGLE_SERVICE_ACCOUNT` ✓ (ya existía)

- [ ] **Paso 3: Prueba — login con contraseña inicial**

1. Abrir `https://facturacion-patagonica.vercel.app` en ventana incógnita
2. Verificar que aparece la pantalla de login (no el portal)
3. Ingresar con tu email y contraseña "123"
4. Verificar que aparece la pantalla de cambio obligatorio
5. Ingresar nueva contraseña (≥8 chars)
6. Verificar que entra al portal

- [ ] **Paso 4: Prueba — sesión y logout**

1. Verificar que el nombre aparece en la sidebar
2. Hacer clic en el nombre → aparece dropdown
3. Clic en "Cerrar sesión" → vuelve a pantalla de login

- [ ] **Paso 5: Prueba — reset de contraseña**

1. Clic en "Olvidé mi contraseña"
2. Ingresar email
3. Verificar que llega el email (revisar spam si no llega)
4. Clic en el link del email → aparece formulario de nueva clave
5. Ingresar nueva clave → verificar que redirige a login
6. Ingresar con nueva clave → verificar acceso

- [ ] **Paso 6: Prueba — APIs protegidas**

```bash
# Sin cookie → debe retornar el HTML de login, no datos
curl https://facturacion-patagonica.vercel.app/api/historial
# Esperado: HTML de login (no JSON)

# La API de auth sí debe estar accesible
curl https://facturacion-patagonica.vercel.app/api/auth?action=me
# Esperado: {"error":"No autenticado"}
```

- [ ] **Paso 7: Dominio Resend — cuando esté verificado**

Cuando el dominio `patagonica.cl` quede verificado en Resend:
1. Ir a Vercel → Settings → Environment Variables
2. Cambiar `RESEND_FROM` de `onboarding@resend.dev` a `no-reply@patagonica.cl`
3. Hacer Redeploy

---

## Checklist final de seguridad

- [ ] Pantalla de login aparece antes de cargar index.html ✓
- [ ] Cookie httpOnly (JS no puede leerla) ✓
- [ ] Cookie Secure + SameSite=Strict ✓
- [ ] JWT firmado con HMAC-SHA256 ✓
- [ ] Contraseñas hasheadas con PBKDF2 (100k iteraciones) + salt único ✓
- [ ] Token de reset hasheado (SHA-256) antes de guardarse en Drive ✓
- [ ] Reset tokens expiran en 1 hora ✓
- [ ] Sesiones expiran en 8 horas ✓
- [ ] Cambio de clave obligatorio en primer ingreso ✓
- [ ] /api/auth accesible sin cookie (para login/reset) ✓
- [ ] Resto de /api/* protegido por middleware ✓
