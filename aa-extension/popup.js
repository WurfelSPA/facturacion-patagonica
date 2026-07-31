const btn = document.getElementById('btn');
const statusEl = document.getElementById('status');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Leyendo cookies de aguasandinas.cl...';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'exportarSesionAA' });
    if (resp && resp.ok) {
      statusEl.textContent = `✅ Sesión enviada a n8n (${resp.count} cookies). El scraping corre en la nube y actualiza aa-cache.json solo.`;
    } else {
      statusEl.textContent = '❌ ' + ((resp && resp.error) || 'Error desconocido');
    }
  } catch (e) {
    statusEl.textContent = '❌ No se pudo conectar: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});
