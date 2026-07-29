const btn = document.getElementById('btn');
const statusEl = document.getElementById('status');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Leyendo cookies de aguasandinas.cl...';
  try {
    // "url" replica exactamente qué cookies enviaría el navegador a esa URL
    // (incluye host-only cookies de www.aguasandinas.cl); el filtro "domain"
    // dejaba fuera JSESSIONID/incap_ses_*/reese84 y solo traía 4 de ~24.
    const cookies = await chrome.cookies.getAll({ url: 'https://www.aguasandinas.cl/' });
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
