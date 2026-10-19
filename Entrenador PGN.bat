@echo off
rem Abre el Entrenador PGN en el navegador.
rem El servidor vive mientras la pestana este abierta y se cierra solo despues.
rem Si ya estaba abierto, solo abre otra pestana.
cd /d "%~dp0"
where pyw >nul 2>nul
if %errorlevel%==0 (
  start "" pyw -3 "%~dp0server.py"
) else (
  start "Entrenador PGN" /min py -3 "%~dp0server.py"
)
