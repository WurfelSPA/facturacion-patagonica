@echo off
:: --------------------------------------------------------------------
:: run-aa-local.bat
:: Scrapea Aguas Andinas y actualiza aa-cache.json en GitHub.
:: Configurar en Task Scheduler para correr diariamente a las 6:00 AM.
:: --------------------------------------------------------------------

cd /d "C:\Users\ALEX MELENDEZ\Documents\GitHub\facturacion-patagonica"

:: git no esta en el PATH del sistema en este equipo -- se usa el git
:: embebido en GitHub Desktop.
set GIT="C:\Users\ALEX MELENDEZ\AppData\Local\GitHubDesktop\app-3.6.5\resources\app\git\cmd\git.exe"

:: Ya no requiere credenciales: reutiliza la sesion guardada en
:: scripts\aa-session.json (generada por aa-login-manual.bat). Si el
:: scraper avisa que la sesion expiro, correr aa-login-manual.bat primero.

:: Correr scraper
node scripts/aa-scraper.js

if %errorlevel% equ 0 (
    echo [OK] Scraper completado. Haciendo push...
    %GIT% add aa-cache.json
    %GIT% diff --staged --quiet && echo [OK] Sin cambios || %GIT% commit -m "chore: actualizar cache AA %date%"
    %GIT% push
    echo [OK] Push completado.
) else (
    echo [ERROR] El scraper fallo. Revisar logs.
    exit /b 1
)
