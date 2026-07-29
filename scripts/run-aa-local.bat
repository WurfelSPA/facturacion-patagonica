@echo off
:: ──────────────────────────────────────────────────────────────────
:: run-aa-local.bat
:: Scrapea Aguas Andinas y actualiza aa-cache.json en GitHub.
:: Configurar en Task Scheduler para correr diariamente a las 6:00 AM.
:: ──────────────────────────────────────────────────────────────────

cd /d C:\Users\amelendez\Documents\GitHub\facturacion-patagonica

:: Credenciales AA (editar con los valores reales)
set AGUAS_RUT=TU_RUT_AA
set AGUAS_CLAVE=TU_CLAVE_AA

:: Correr scraper
node scripts/aa-scraper.js

if %errorlevel% equ 0 (
    echo [OK] Scraper completado. Haciendo push...
    git add aa-cache.json
    git diff --staged --quiet && echo [OK] Sin cambios || git commit -m "chore: actualizar cache AA %date%"
    git push
    echo [OK] Push completado.
) else (
    echo [ERROR] El scraper falló. Revisar logs.
    exit /b 1
)
