@echo off
chcp 65001 >nul
title BPLAY CRM - modo prueba
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta instalar Node.js. Se abre la pagina de descarga:
  echo  baja la version "LTS", instalala con todo por defecto y volve a abrir este archivo.
  start https://nodejs.org/
  pause
  exit /b
)

if not exist ".env" (
  echo ADMIN_PASSWORD=prueba123> .env
  echo ANTHROPIC_API_KEY=>> .env
  echo.
  echo  Se creo el archivo .env. Si tenes API key de Anthropic, pegala ahi
  echo  ^(ANTHROPIC_API_KEY=...^) para probar el bot con IA. Sin key funciona en modo basico.
)

if not exist "node_modules" (
  echo.
  echo  Instalando ^(solo la primera vez, tarda 1 minuto^)...
  call npm install --no-audit --no-fund
)

echo.
echo  ============================================
echo   Panel:  http://localhost:3000/admin   (clave: la de ADMIN_PASSWORD en .env, por defecto prueba123)
echo   Chat:   http://localhost:3000/chat    (abrilo en una ventana de incognito = cliente)
echo   Para cerrar: cerra esta ventana.
echo  ============================================
echo.
start "" http://localhost:3000/admin
start "" http://localhost:3000/chat
call npm start
pause
