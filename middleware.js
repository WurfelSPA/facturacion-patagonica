import { next } from '@vercel/edge';

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon\\.ico).*)']
};

const JWT_SECRET = () => process.env.JWT_SECRET || '';

// ── JWT verify (HMAC-SHA256, Edge Runtime compatible) ───────────────────────
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
    <button style="background:none;border:none;color:#4f46e5;font-size:13px;cursor:pointer;padding:0;margin-bottom:12px" onclick="showLogin()">← Volver</button>
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
    const m=document.getElementById('msg-forgot');
    m.textContent='Si tu correo está registrado, recibirás un link en minutos.';
    m.style.background='#d1fae5';m.style.color='#065f46';m.style.display='block';
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
