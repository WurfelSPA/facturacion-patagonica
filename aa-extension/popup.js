const btn = document.getElementById('btn');
const statusEl = document.getElementById('status');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Leyendo cookies de aguasandinas.cl...';
  try {
    // Filtrar por url/domain dejaba fuera cookies clave (JSESSIONID,
    // incap_ses_*, reese84) por diferencias de Path/Domain que no logramos
    // calzar exactamente (solo traía 4 de ~24, siempre las mismas 4).
    // chrome.cookies.getAll({}) sin filtro devuelve TODO lo que la extensión
    // puede ver — y ese alcance ya está acotado por host_permissions en el
    // manifest, así que no perdemos nada filtrando en código.
    const todas = await chrome.cookies.getAll({});
    const cookies = todas.filter(c => c.domain && c.domain.includes('aguasandinas'));
    if (!cookies.length) {
      statusEl.textContent = 'No se encontraron cookies. ¿Estás logueado en aguasandinas.cl?';
      btn.disabled = false;
      return;
    }
    statusEl.textContent = `Enviando ${cookies.length} cookies a scripts\\aa-listen-and-refresh...`;
    const res = await fetch('http://127.0.0.1:8934/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies })
    });
    if (res.ok) {
      statusEl.textContent = '✅ Sesión enviada. Revisa la terminal: ya está corriendo el scraper y el push automáticamente.';
    } else {
      statusEl.textContent = '❌ El listener respondió con error ' + res.status;
    }
  } catch (e) {
    statusEl.textContent = '❌ No se pudo conectar (' + e.message + '). ¿Corriste scripts\\aa-listen-and-refresh.bat antes de hacer clic?';
  } finally {
    btn.disabled = false;
  }
});
