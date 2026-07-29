@echo off
:: --------------------------------------------------------------------
:: aa-listen-and-refresh.bat
:: 1. Inicia sesion normalmente en aguasandinas.cl (en tu navegador)
:: 2. Corre este .bat
:: 3. Haz clic en el boton de la extension "AA Session Exporter"
:: Se encarga solo del resto: guarda sesion, corre el scraper, sube cambios.
:: --------------------------------------------------------------------

cd /d C:\Users\amelendez\Documents\GitHub\facturacion-patagonica

node scripts/aa-listen-and-refresh.mjs

pause
