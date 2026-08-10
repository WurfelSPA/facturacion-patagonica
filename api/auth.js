/**
 * /api/auth
 * POST ?action=login           → valida email+password, retorna cookie JWT
 * GET  ?action=logout          → borra cookie
 * GET  ?action=me              → retorna {email, name} desde cookie
 * POST ?action=change-password → cambia contraseña (requiere cookie válida)
 * POST ?action=forgot-password → genera link de reset y envía email via Resend
 * GET  ?action=reset-form&token=XX → sirve HTML formulario de nueva clave
 * POST ?action=reset-password  → valida token JWT y actualiza contraseña en Drive
 *
 * Login: lee de AUTH_CREDS (env var) primero, Drive como fallback.
 * Forgot-password: token JWT firmado con JWT_SECRET (sin almacenamiento externo).
 * Cambio de contraseña: escribe en Drive (SA necesita ser editor del archivo).
 */

export const config = { api: { bodyParser: true } };

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

// ── Helpers PBKDF2 ───────────────────────────────────────────────────────────
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
    {name:'PBKDF2', salt:enc.encode(salt), iterations:10000, hash:'SHA-256'},
    key, 256
  );
  return hexEncode(bits);
}

// ── Expiración de sesión: siempre a la medianoche (hora Chile) ──────────────
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = dtf.formatToParts(date).reduce((a, x) => { if (x.type !== 'literal') a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return (asUTC - date.getTime()) / 60000;
}
function nextMidnightEpochSeconds(tz = 'America/Santiago') {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = dtf.formatToParts(now).reduce((a, x) => { if (x.type !== 'literal') a[x.type] = x.value; return a; }, {});
  const tomorrowUTCGuess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 1, 0, 0, 0);
  const offsetMin = tzOffsetMinutes(new Date(tomorrowUTCGuess), tz);
  return Math.floor((tomorrowUTCGuess - offsetMin * 60000) / 1000);
}

// ── Credenciales desde env var ───────────────────────────────────────────────
function readEnvCredentials() {
  const raw = process.env.AUTH_CREDS;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

// ── Google Drive (SA) ────────────────────────────────────────────────────────
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

async function readDriveCredentials(token) {
  const id = process.env.DRIVE_CREDENTIALS_ID;
  if (!id) throw new Error('DRIVE_CREDENTIALS_ID no configurado');
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,{
    headers:{Authorization:`Bearer ${token}`}
  });
  if (!r.ok) throw new Error('Drive read error: '+r.status+' '+(await r.text()).slice(0,300)+' (fileId='+id+')');
  return r.json();
}

async function writeDriveCredentials(token, data) {
  const id = process.env.DRIVE_CREDENTIALS_ID;
  if (!id) throw new Error('DRIVE_CREDENTIALS_ID no configurado');
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,{
    method:'PATCH',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body: JSON.stringify(data, null, 2)
  });
  if (!r.ok) throw new Error('Drive write error: '+r.status+' '+(await r.text()));
}

async function createDriveCredentialsFile(token, parentFolderId) {
  const boundary = 'auth_creds_boundary_'+Date.now();
  const metadata = { name: 'auth-credentials.json', parents: parentFolderId ? [parentFolderId] : undefined };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n` +
    `--${boundary}--`;
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!r.ok) throw new Error('Drive create error: '+r.status+' '+(await r.text()));
  return r.json();
}

// ── Resend ───────────────────────────────────────────────────────────────────
async function sendResetEmail(to, name, resetUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY no configurado');
  const from = process.env.RESEND_FROM || 'noreply@patagonica.cl';
  const r = await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body: JSON.stringify({
      from, to,
      subject: 'Recuperar contraseña — Portal Patagónica',
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border-radius:12px;border:1px solid #e5e7eb">
          <h2 style="color:#1a1a2e;margin:0 0 8px">Recuperar contraseña</h2>
          <p style="color:#444;margin:0 0 24px">Hola <strong>${name}</strong>, recibimos una solicitud para restablecer tu contraseña en el Portal Patagónica.</p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
            Crear nueva contraseña
          </a>
          <p style="color:#666;font-size:13px;margin:24px 0 4px">El link expira en <strong>1 hora</strong>.</p>
          <p style="color:#999;font-size:12px;margin:0">Si no solicitaste este cambio, ignora este mensaje.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#bbb;font-size:11px;margin:0">${resetUrl}</p>
        </div>
      </body></html>`
    })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Resend error '+r.status+': '+txt);
  }
}

// ── Cookie parser ─────────────────────────────────────────────────────────────
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if (req.method==='OPTIONS') return res.status(200).end();

    const action = req.query.action || '';
    const JWT_SECRET = process.env.JWT_SECRET || '';

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    // Intenta AUTH_CREDS primero (rápido). Si el hash no coincide,
    // cae a Drive como fallback (para contraseñas cambiadas vía reset).
    if (action==='login') {
      const { email='', password='' } = req.body || {};
      if (!email || !password)
        return res.status(400).json({error:'Email y contraseña requeridos'});
      if (!email.toLowerCase().endsWith('@patagonica.cl'))
        return res.status(403).json({error:'Solo se permite acceso con correo corporativo @patagonica.cl'});

      const emailKey = email.toLowerCase();
      let user = null;
      let authenticated = false;

      // Camino rápido: AUTH_CREDS env var
      const envCreds = readEnvCredentials();
      if (envCreds && envCreds[emailKey]) {
        user = envCreds[emailKey];
        const hash = await hashPassword(password, user.salt);
        if (hash === user.hash) authenticated = true;
      }

      // Fallback a Drive (contraseña cambiada vía reset, env var desactualizada)
      if (!authenticated) {
        let driveCreds;
        try {
          const tok = await saToken();
          driveCreds = await readDriveCredentials(tok);
        } catch(e) {
          // Drive no disponible y env var no autenticó
          return res.status(401).json({error:'Email o contraseña incorrectos'});
        }
        user = driveCreds[emailKey];
        if (!user) return res.status(401).json({error:'Email o contraseña incorrectos'});
        const hash = await hashPassword(password, user.salt);
        if (hash !== user.hash) return res.status(401).json({error:'Email o contraseña incorrectos'});
        authenticated = true;
      }

      // Fix: si el env var autenticó pero tiene mustChangePassword:true,
      // verificar en Drive si el usuario ya cambió su contraseña allí.
      // (el env var nunca se actualiza en runtime, puede quedar desactualizado)
      if (authenticated && user.mustChangePassword) {
        try {
          const tok = await saToken();
          const driveCreds = await readDriveCredentials(tok);
          if (driveCreds[emailKey] && driveCreds[emailKey].mustChangePassword === false) {
            user = { ...user, mustChangePassword: false };
          }
        } catch(e) { /* si Drive falla, respetar el env var */ }
      }

      const sessionExp = nextMidnightEpochSeconds();
      const payload = {
        email: emailKey, name: user.name,
        mustChangePassword: !!user.mustChangePassword,
        exp: sessionExp
      };
      const jwt = await signToken(payload, JWT_SECRET);
      res.setHeader('Set-Cookie', makeCookie(jwt, sessionExp - Math.floor(Date.now()/1000)));
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
      return res.status(200).json({
        email:payload.email, name:payload.name,
        mustChangePassword:!!payload.mustChangePassword
      });
    }

    // ── CHANGE-PASSWORD ───────────────────────────────────────────────────────
    if (action==='change-password') {
      const cookieToken = parseCookie(req.headers.cookie, 'auth_token');
      const payload = await verifyToken(cookieToken, JWT_SECRET);
      if (!payload) return res.status(401).json({error:'No autenticado'});

      const { currentPassword='', newPassword='' } = req.body || {};
      if (newPassword.length < 8)
        return res.status(400).json({error:'La nueva contraseña debe tener al menos 8 caracteres'});

      // Leer credenciales SIEMPRE desde Drive para no sobreescribir cambios de otros usuarios.
      // (leer del env var y luego escribir a Drive revertiría los cambios de los demás)
      let creds;
      try {
        const tok = await saToken();
        creds = await readDriveCredentials(tok);
      } catch(e) {
        // Solo fallback a env var si Drive no está disponible
        const envCreds = readEnvCredentials();
        if (envCreds) {
          creds = envCreds;
        } else {
          return res.status(500).json({error:'No se pudo leer credenciales'});
        }
      }

      const user = creds[payload.email];
      if (!user) return res.status(404).json({error:'Usuario no encontrado'});

      // Saltar verificación si JWT o Drive indican mustChangePassword
      const skipCurrentCheck = !!payload.mustChangePassword || !!user.mustChangePassword;
      if (!skipCurrentCheck) {
        if (!currentPassword) return res.status(400).json({error:'Contraseña actual requerida'});
        const currentHash = await hashPassword(currentPassword, user.salt);
        if (currentHash !== user.hash)
          return res.status(401).json({error:'Contraseña actual incorrecta'});
      }

      const salt = generateSalt();
      const hash = await hashPassword(newPassword, salt);
      creds[payload.email] = {...user, hash, salt, mustChangePassword: false};

      // Guardar en Drive
      try {
        const tok = await saToken();
        await writeDriveCredentials(tok, creds);
      } catch(e) {
        return res.status(500).json({error:'No se pudo guardar la nueva contraseña: '+e.message});
      }

      const sessionExp2 = nextMidnightEpochSeconds();
      const newPayload = {
        email:payload.email, name:payload.name, mustChangePassword:false,
        exp: sessionExp2
      };
      const jwt = await signToken(newPayload, JWT_SECRET);
      res.setHeader('Set-Cookie', makeCookie(jwt, sessionExp2 - Math.floor(Date.now()/1000)));
      return res.status(200).json({ok:true});
    }

    // ── FORGOT-PASSWORD ───────────────────────────────────────────────────────
    // Token JWT firmado (sin almacenamiento externo)
    if (action==='forgot-password') {
      const { email='' } = req.body || {};
      if (!email) return res.status(400).json({error:'Email requerido'});
      if (!email.toLowerCase().endsWith('@patagonica.cl'))
        return res.status(200).json({ok:true}); // no revelar si existe

      const emailKey = email.toLowerCase();

      // Buscar usuario (env var primero, luego Drive)
      let user = null;
      const envCreds = readEnvCredentials();
      if (envCreds && envCreds[emailKey]) user = envCreds[emailKey];
      if (!user) {
        try {
          const tok = await saToken();
          const driveCreds = await readDriveCredentials(tok);
          user = driveCreds[emailKey];
        } catch(e) { /* ignorar */ }
      }
      if (!user) return res.status(200).json({ok:true}); // no revelar

      // Generar token JWT firmado (expira en 1 hora)
      const resetPayload = {
        email: emailKey,
        action: 'password-reset',
        exp: Math.floor(Date.now()/1000) + 3600
      };
      const resetToken = await signToken(resetPayload, JWT_SECRET);

      const baseUrl = process.env.APP_URL || 'https://facturacion-patagonica.vercel.app';
      const resetUrl = `${baseUrl}/api/auth?action=reset-form&token=${encodeURIComponent(resetToken)}`;

      try {
        await sendResetEmail(emailKey, user.name, resetUrl);
      } catch(e) {
        console.error('sendResetEmail error:', e.message);
        return res.status(500).json({error:'No se pudo enviar el email: '+e.message});
      }

      return res.status(200).json({ok:true});
    }

    // ── RESET-FORM ────────────────────────────────────────────────────────────
    if (action==='reset-form') {
      const { token='' } = req.query;
      const payload = await verifyToken(decodeURIComponent(token), JWT_SECRET);
      const valid = payload && payload.action === 'password-reset';
      const userName = valid ? (readEnvCredentials()?.[payload.email]?.name || payload.email) : '';

      const safeToken = token.replace(/"/g,'&quot;');
      const html = valid
        ? `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nueva contraseña — Patagónica</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f7;font-family:system-ui,sans-serif}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:8px}
p{color:#666;font-size:14px;margin-bottom:24px}
label{font-size:13px;font-weight:600;color:#444;display:block;margin-bottom:6px}
input{width:100%;padding:10px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:14px;outline:none;transition:.2s;margin-bottom:16px}
input:focus{border-color:#4f46e5}
button{width:100%;padding:12px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s}
button:hover{background:#3730a3}
button:disabled{opacity:.6;cursor:not-allowed}
.msg{margin-top:16px;padding:10px 14px;border-radius:8px;font-size:13px;display:none}
.msg.ok{background:#d1fae5;color:#065f46}
.msg.err{background:#fee2e2;color:#991b1b}
</style></head><body>
<div class="card">
  <h1>Nueva contraseña</h1>
  <p>Hola <strong>${userName}</strong>, ingresa tu nueva contraseña.</p>
  <label for="p1">Nueva contraseña</label>
  <input type="password" id="p1" placeholder="Mínimo 8 caracteres" minlength="8" autocomplete="new-password">
  <label for="p2">Confirmar contraseña</label>
  <input type="password" id="p2" placeholder="Repite la contraseña" autocomplete="new-password">
  <button id="btn" onclick="doSubmit()">Guardar contraseña</button>
  <div class="msg" id="msg"></div>
</div>
<script>
async function doSubmit(){
  var p1=document.getElementById('p1').value;
  var p2=document.getElementById('p2').value;
  var btn=document.getElementById('btn');
  if(p1.length<8){showMsg('La contraseña debe tener al menos 8 caracteres','err');return;}
  if(p1!==p2){showMsg('Las contraseñas no coinciden','err');return;}
  btn.disabled=true;btn.textContent='Guardando...';
  try{
    var r=await fetch('/api/auth?action=reset-password',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:"${safeToken}",newPassword:p1})
    });
    var d=await r.json();
    if(d.ok){showMsg('Contraseña actualizada. Redirigiendo...','ok');setTimeout(function(){location.href='/'},2000);}
    else{showMsg(d.error||'Error al actualizar','err');btn.disabled=false;btn.textContent='Guardar contraseña';}
  }catch(e){showMsg('Error de conexión','err');btn.disabled=false;btn.textContent='Guardar contraseña';}
}
function showMsg(t,c){var m=document.getElementById('msg');m.textContent=t;m.className='msg '+c;m.style.display='block';}
document.getElementById('p1').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('p2').focus();});
document.getElementById('p2').addEventListener('keydown',function(e){if(e.key==='Enter')doSubmit();});
</script></body></html>`
        : `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Link inválido — Patagónica</title>
<style>body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#f5f5f7}
.card{background:#fff;border-radius:16px;padding:40px;max-width:360px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#991b1b;margin-bottom:12px;font-size:20px}
p{color:#666;font-size:14px;margin-bottom:24px}
a{display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600}
</style></head><body>
<div class="card">
  <h1>Link expirado</h1>
  <p>Este link ya no es válido. Los links de recuperación expiran en 1 hora y son de un solo uso.</p>
  <a href="/">Volver al portal</a>
</div></body></html>`;

      res.setHeader('Content-Type','text/html; charset=utf-8');
      return res.status(valid?200:400).send(html);
    }

    // ── RESET-PASSWORD ────────────────────────────────────────────────────────
    if (action==='reset-password') {
      const { token='', newPassword='' } = req.body || {};
      if (!token || !newPassword)
        return res.status(400).json({error:'Datos incompletos'});
      if (newPassword.length < 8)
        return res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres'});

      // Verificar token JWT
      const payload = await verifyToken(decodeURIComponent(token), JWT_SECRET);
      if (!payload || payload.action !== 'password-reset')
        return res.status(400).json({error:'Link inválido o expirado'});

      // Leer credenciales de Drive
      let creds;
      try {
        const tok = await saToken();
        creds = await readDriveCredentials(tok);
      } catch(e) {
        return res.status(500).json({error:'No se pudo leer credenciales: '+e.message});
      }

      const user = creds[payload.email];
      if (!user) return res.status(400).json({error:'Usuario no encontrado'});

      // Actualizar hash
      const salt = generateSalt();
      const hash = await hashPassword(newPassword, salt);
      creds[payload.email] = {...user, hash, salt, mustChangePassword:false, resetToken:null, resetTokenExpiry:null};

      // Escribir en Drive
      try {
        const tok = await saToken();
        await writeDriveCredentials(tok, creds);
      } catch(e) {
        return res.status(500).json({error:'No se pudo guardar la nueva contraseña: '+e.message});
      }

      return res.status(200).json({ok:true});
    }

    // ── ADMIN-INIT-STORE ──────────────────────────────────────────────────────
    // Crea el archivo Drive de credenciales (uso único, si DRIVE_CREDENTIALS_ID
    // está mal configurado o el archivo no existe). Protegido por ADMIN_SEED_SECRET.
    if (action==='admin-init-store') {
      const secret = req.headers['x-seed-secret'] || (req.body||{}).secret || '';
      const expected = process.env.ADMIN_SEED_SECRET || '';
      if (!expected || secret !== expected)
        return res.status(403).json({error:'No autorizado'});
      try {
        const tok = await saToken();
        const parent = (req.body||{}).parentFolderId || null;
        const file = await createDriveCredentialsFile(tok, parent);
        return res.status(200).json({ok:true, fileId:file.id, name:file.name});
      } catch(e) {
        return res.status(500).json({error:'No se pudo crear el archivo: '+e.message});
      }
    }

    // ── ADMIN-ADD-USER ────────────────────────────────────────────────────────
    // Crea o actualiza un usuario directamente en Drive (no toca AUTH_CREDS).
    // Protegido por ADMIN_SEED_SECRET — solo para agregar cuentas autorizadas.
    if (action==='admin-add-user') {
      const secret = req.headers['x-seed-secret'] || (req.body||{}).secret || '';
      const expected = process.env.ADMIN_SEED_SECRET || '';
      if (!expected || secret !== expected)
        return res.status(403).json({error:'No autorizado'});

      const { email='', password='', name='' } = req.body || {};
      const emailKey = email.toLowerCase().trim();
      if (!emailKey.endsWith('@patagonica.cl'))
        return res.status(400).json({error:'El correo debe ser del dominio @patagonica.cl'});
      if (!password || password.length < 6)
        return res.status(400).json({error:'Contraseña requerida (mínimo 6 caracteres)'});

      let creds;
      try {
        const tok = await saToken();
        creds = await readDriveCredentials(tok);
      } catch(e) {
        let saEmail = null;
        try { saEmail = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT).client_email; } catch(_) {}
        return res.status(500).json({error:'No se pudo leer credenciales de Drive: '+e.message, hint:'Comparte el archivo (DRIVE_CREDENTIALS_ID) como Editor con: '+saEmail});
      }

      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      creds[emailKey] = { name: name||emailKey, hash, salt, mustChangePassword:false };

      try {
        const tok = await saToken();
        await writeDriveCredentials(tok, creds);
      } catch(e) {
        return res.status(500).json({error:'No se pudo guardar en Drive: '+e.message});
      }

      return res.status(200).json({ok:true, email:emailKey});
    }

    return res.status(400).json({error:'Action desconocida: '+action});

  } catch(e) {
    console.error('auth handler error:', e);
    return res.status(500).json({error: String(e.message||e)});
  }
}
