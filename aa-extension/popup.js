const statusEl = document.getElementById('status');

function wireButton(btnId, action, etiqueta) {
  const btn = document.getElementById(btnId);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    statusEl.textContent = `Leyendo cookies de ${etiqueta}...`;
    try {
      const resp = await chrome.runtime.sendMessage({ action });
      if (resp && resp.ok) {
        statusEl.textContent = `✅ Sesión ${etiqueta} enviada a n8n (${resp.count} cookies). El scraping corre en la nube y actualiza el caché solo.`;
      } else {
        statusEl.textContent = '❌ ' + ((resp && resp.error) || 'Error desconocido');
      }
    } catch (e) {
      statusEl.textContent = '❌ No se pudo conectar: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });
}

wireButton('btnAA', 'exportarSesionAA', 'Aguas Andinas');
wireButton('btnEnel', 'exportarSesionEnel', 'Enel');
