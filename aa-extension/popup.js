const btn = document.getElementById('btn');
const diagBtn = document.getElementById('diag');
const statusEl = document.getElementById('status');

diagBtn.addEventListener('click', async () => {
  diagBtn.disabled = true;
  statusEl.textContent = 'Probando distintas formas de buscar cookies...';
  const lineas = [];
  const objetivo = ['JSESSIONID', 'reese84'];

  async function probar(etiqueta, filtro) {
    try {
      const cs = await chrome.cookies.getAll(filtro);
      const encontradas = objetivo.filter(nombre => cs.some(c => c.name === nombre));
      lineas.push(`${etiqueta}: ${cs.length} cookies | encontró: ${encontradas.length ? encontradas.join(',') : 'ninguna'}`);
    } catch (e) {
      lineas.push(`${etiqueta}: ERROR ${e.message}`);
    }
  }

  await probar('domain=aguasandinas.cl', { domain: 'aguasandinas.cl' });
  await probar('domain=www.aguasandinas.cl', { domain: 'www.aguasandinas.cl' });
  await probar('url=https://www.aguasandinas.cl/', { url: 'https://www.aguasandinas.cl/' });
  await probar('sin filtro (getAll({}))', {});

  // Buscar en TODAS las cookies visibles (aunque no sean de aguasandinas) por si
  // el Domain real no contiene ese texto.
  try {
    const todas = await chrome.cookies.getAll({});
    for (const nombre of objetivo) {
      const c = todas.find(c => c.name === nombre);
      lineas.push(c ? `${nombre} SÍ existe → domain real: "${c.domain}", path: "${c.path}"` : `${nombre} no aparece en NINGUNA cookie visible para la extensión`);
    }
  } catch (e) {}

  // chrome.cookies.get() por nombre exacto (distinto de getAll) — probar con
  // varias combinaciones de url, por si el matching de getAll es el problema.
  const urlsAProbar = [
    'https://www.aguasandinas.cl/',
    'https://www.aguasandinas.cl',
    'https://aguasandinas.cl/'
  ];
  for (const nombre of objetivo) {
    for (const url of urlsAProbar) {
      try {
        const c = await chrome.cookies.get({ url, name: nombre });
        lineas.push(`get(${nombre}, ${url}) → ${c ? 'ENCONTRADA valor=' + c.value.slice(0, 20) + '...' : 'null'}`);
      } catch (e) {
        lineas.push(`get(${nombre}, ${url}) → ERROR ${e.message}`);
      }
    }
  }

  // Listar los cookie stores disponibles (por si hay más de uno y estamos
  // consultando el que no corresponde a la pestaña real).
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    lineas.push('Cookie stores: ' + JSON.stringify(stores.map(s => ({ id: s.id, tabIds: s.tabIds }))));
  } catch (e) {
    lineas.push('getAllCookieStores ERROR: ' + e.message);
  }

  statusEl.textContent = lineas.join('\n');
  diagBtn.disabled = false;
});

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Leyendo cookies de aguasandinas.cl...';
  try {
    // getAll({}) trae la mayoría, pero por alguna rareza de la API de Chrome
    // omite JSESSIONID y reese84 aunque SÍ existen (confirmado con
    // chrome.cookies.get() por nombre exacto, que a esas dos sí las
    // encuentra). Se combinan ambos resultados para no perder las críticas.
    const todas = await chrome.cookies.getAll({});
    const cookies = todas.filter(c => c.domain && c.domain.includes('aguasandinas'));

    const criticas = ['JSESSIONID', 'reese84'];
    for (const nombre of criticas) {
      if (cookies.some(c => c.name === nombre)) continue;
      const c = await chrome.cookies.get({ url: 'https://www.aguasandinas.cl/', name: nombre }).catch(() => null);
      if (c) cookies.push(c);
    }

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
