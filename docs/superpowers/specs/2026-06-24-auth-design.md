# Diseño: Sistema de Autenticación — Portal Facturación Patagónica

**Fecha:** 2026-06-24  
**Estado:** Aprobado por usuario  
**Autor:** Claude (Cowork)

---

## 1. Contexto y Objetivo

El portal de facturación en `facturacion-patagonica.vercel.app` expone información sensible de clientes y montos sin ningún control de acceso. Se necesita un sistema de login que:

- Permita acceso solo a usuarios aprobados (lista en Google Drive)
- Obligue a cambiar la clave inicial "123" en el primer ingreso
- Soporte reset de contraseña por email (Resend)
- Expire la sesión a las 8 horas
- No exceda el límite de 12 funciones del plan Hobby de Vercel

---

## 2. Arquitectura

```
Browser
  │
  ▼
middleware.js          ← Edge Runtime (corre en CDN, no consume función)
  │
  ├─ Sin cookie válida       → devuelve HTML de login inline
  ├─ mustChangePassword=true → devuelve HTML de cambio de clave obligatorio
  └─ Cookie válida           → pasa al destino normalmente
         │
         ├─ index.html       (portal completo)
         └─ /api/*           (todos los endpoints protegidos)
               │
               └─ /api/auth  ← reemplaza sa-info.js (ya era un 404 muerto)
                    • POST ?action=login
                    • POST ?action=change-password
                    • POST ?action=forgot-password
                    • POST ?action=reset-password
                    • GET  ?action=logout
```

### Por qué Edge Middleware

- Intercepta **todas** las peticiones antes de servir cualquier archivo
- El HTML del portal nunca se entrega a usuarios no autenticados
- No consume ningún slot de función (límite actual: 12/12)
- Puede leer cookies y retornar respuestas HTTP directamente

---

## 3. Almacenamiento de Credenciales

**Archivo:** `credentials.json` en Google Drive  
**Acceso:** Service Account existente (`GOOGLE_SERVICE_ACCOUNT`)  
**ID del archivo:** variable de entorno `DRIVE_CREDENTIALS_ID`

### Estructura

```json
{
  "amelendez@patagonica.cl": {
    "name": "Alex",
    "hash": "<pbkdf2-hex>",
    "salt": "<16-bytes-hex>",
    "mustChangePassword": true,
    "resetToken": null,
    "resetTokenExpiry": null
  }
}
```

### Hashing de contraseñas

- Algoritmo: **PBKDF2-SHA256** con 100.000 iteraciones (Web Crypto API)
- Salt: 16 bytes aleatorios únicos por usuario
- La clave inicial "123" se hashea individualmente para cada usuario con su salt

### Inicialización

El archivo `credentials.json` se genera desde el Excel "Credenciales Facturación Patagonica.xlsx" que está en la carpeta "Facturación Mensual" de Drive. Script de inicialización único que:
1. Lee el Excel (columnas: Email, Nombre)
2. Genera salt + hash de "123" para cada usuario
3. Sube `credentials.json` a Drive
4. Retorna el ID del archivo para la variable de entorno

---

## 4. Seguridad del Token de Sesión (JWT)

- **Algoritmo:** HMAC-SHA256 (Web Crypto API, funciona en Edge Runtime)
- **Secret:** variable de entorno `JWT_SECRET` (64 chars aleatorios)
- **Expiración:** 8 horas desde el login
- **Payload:** `{ email, name, mustChangePassword, exp }`

### Cookie

```
auth_token=<jwt>; HttpOnly; Secure; SameSite=Strict; Max-Age=28800; Path=/
```

- `HttpOnly`: JavaScript no puede leer la cookie (protección XSS)
- `Secure`: solo viaja por HTTPS
- `SameSite=Strict`: protección CSRF

---

## 5. Flujos de Usuario

### 5.1 Primer ingreso (clave "123")

1. Usuario visita el portal → middleware detecta sin cookie → retorna pantalla de login
2. Ingresa email + "123" → `POST /api/auth?action=login`
3. Sistema valida → detecta `mustChangePassword=true` → retorna cookie con flag
4. Middleware intercepta siguiente request → retorna pantalla de cambio obligatorio
5. Usuario ingresa nueva clave (mínimo 8 caracteres) → `POST /api/auth?action=change-password`
6. Sistema actualiza `credentials.json` en Drive (`mustChangePassword=false`)
7. Retorna nueva cookie limpia → usuario entra al portal

### 5.2 Login normal

1. Visita el portal → pantalla de login
2. Ingresa email + contraseña → valida → cookie 8h → acceso al portal
3. Al vencer las 8h, siguiente request vuelve a login automáticamente

### 5.3 Reset de contraseña

1. Clic en "Olvidé mi contraseña" → ingresa email
2. `POST /api/auth?action=forgot-password`
3. Sistema genera token seguro (32 bytes aleatorios), expira en 1 hora, uso único
4. Guarda `SHA256(token)` en `credentials.json` (no el token en texto plano)
5. Envía email via Resend con link: `https://facturacion-patagonica.vercel.app/api/auth?action=reset-form&token=<token>`
6. Usuario hace clic → `/api/auth` no requiere cookie (whitelisted en middleware)
7. `api/auth` valida token → retorna HTML con formulario de nueva clave
8. Usuario ingresa nueva clave → `POST /api/auth?action=reset-password`
9. Sistema valida token, actualiza contraseña en Drive, limpia token → redirige a login

### 5.4 Cambio de contraseña (dentro del portal)

1. Menú de usuario (esquina superior) → "Cambiar contraseña"
2. Modal con: clave actual + nueva clave + confirmar
3. `POST /api/auth?action=change-password` con cookie válida
4. Actualiza Drive → confirma al usuario

### 5.5 Cierre de sesión

- Clic en "Cerrar sesión" → `GET /api/auth?action=logout`
- Servidor retorna `Set-Cookie` con expiración pasada (borra la cookie)
- Redirige a login

---

## 6. Variables de Entorno Requeridas

| Variable | Descripción | Quién la genera |
|---|---|---|
| `JWT_SECRET` | Clave HMAC para firmar tokens | Script aleatorio (64 chars) |
| `RESEND_API_KEY` | API key de Resend | Usuario (resend.com) |
| `RESEND_FROM` | Email remitente | `no-reply@patagonica.cl` |
| `DRIVE_CREDENTIALS_ID` | ID del credentials.json en Drive | Script de inicialización |
| `GOOGLE_SERVICE_ACCOUNT` | Ya configurado | Ya existe |

---

## 7. Archivos a Crear/Modificar

| Archivo | Acción | Descripción |
|---|---|---|
| `middleware.js` | Crear | Edge middleware: valida cookie, sirve login HTML |
| `api/auth.js` | Crear (reemplaza `api/sa-info.js`) | 5 actions de auth |
| `api/sa-info.js` | Eliminar | Ya era un 404 stub |
| `index.html` | Modificar | Menú usuario: cambiar clave + cerrar sesión (sin lógica de reset) |
| `vercel.json` | Modificar | Config middleware, excluir `/api/auth` del check |
| `scripts/init-credentials.js` | Crear (ejecutar una vez) | Poblar credentials.json desde Excel |

---

## 8. Consideraciones y Límites

- **Concurrencia en Drive:** `credentials.json` se lee/escribe en cada login y cambio de clave. Con pocos usuarios (<20) no hay riesgo de conflictos. Si en el futuro hay más usuarios, migrar a KV store (Vercel KV o Upstash).
- **Edge Runtime:** el middleware solo puede usar Web Crypto y fetch. No puede usar Node.js APIs. Todo el código de middleware debe ser compatible con Edge.
- **Función count:** después del cambio (eliminar `sa-info.js`, agregar `api/auth.js`) el total sigue siendo 12/12.
- **Reset token:** se guarda el hash SHA-256 del token en Drive, nunca el token en texto plano. Si alguien accede a credentials.json no puede usar los tokens de reset.

---

## 9. Out of Scope

- Autenticación con Google OAuth (YAGNI por ahora)
- Roles o permisos diferenciados por usuario (todos ven lo mismo)
- Bloqueo por intentos fallidos (YAGNI por ahora)
- Audit log de accesos

---

## 10. Plan de Implementación (siguiente paso)

1. Script de inicialización → genera `credentials.json` en Drive
2. `api/auth.js` → todas las actions
3. `middleware.js` → validación y login HTML
4. `index.html` → menú usuario
5. `vercel.json` → config
6. Variables de entorno → Vercel dashboard
7. Prueba end-to-end

