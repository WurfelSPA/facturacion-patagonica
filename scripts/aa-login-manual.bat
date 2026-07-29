@echo off
:: --------------------------------------------------------------------
:: aa-login-manual.bat
:: Abre Chrome para que inicies sesion manualmente en Aguas Andinas y
:: guarda la sesion para que el scraper automatico la reutilice.
:: Ejecutar cuando aa-scraper.js avise que la sesion expiro.
:: --------------------------------------------------------------------

cd /d C:\Users\amelendez\Documents\GitHub\facturacion-patagonica

node scripts/aa-login-manual.mjs

pause
