const btn = document.getElementById('btn');
const statusEl = document.getElementById('status');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Leyendo cookies de aguasandinas.cl...';
  try {
    // Usamos la URL real de la pestaña activa (no una fija en la raíz "/"):
    // varias cookies clave (JSESSIONID, incap_ses_*, reese84) tienen un Path
    // más específico que "/", así que filtrar por la raíz las dejaba fuera
    // (solo traía 4 de ~24). Pedir por la URL exacta donde estás logueado
    // replica lo que el navegador realmente enviaría en esa página.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('aguasandinas.cl')) {
      statusEl.textContent = 'Abre primero una pestaña en aguasandinas.cl (logueado) y vuelve a intentar.';
      btn.disabled = false;
      return;
    }
    const cookies = await chrome.cookies.getAll({ url: tab.url });
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
