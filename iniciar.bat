@echo off
cd /d "%~dp0"
title Sistema de Gestao de Coleta de Pacotes
color 0A

echo =======================================================================
echo     SISTEMA DE GESTAO DE COLETA DE PACOTES (LOGISTICA REVERSA)
echo =======================================================================
echo.
echo [*] Verificando dependencias locais...
if not exist "node_modules\" (
    echo [!] Pasta node_modules nao encontrada. Instalando dependencias locais...
    call npm install --only=production
) else (
    echo [*] Dependencias ja instaladas.
)

echo.
echo [*] Inicializando o Servidor Local...
start "" /B node server.js

echo [*] Aguardando o servidor ligar na porta 3000...
timeout /t 3 /nobreak > nul

echo [*] Abrindo o painel de administracao no navegador...
start http://localhost:3000/admin

echo.
echo [*] Detectando o IP local deste Notebook...
set LOCAL_IP=IP_DO_NOTEBOOK
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike '*Loopback*' -and $_.InterfaceAlias -notlike '*vEthernet*' } | Select-Object -First 1).IPAddress"`) do (
    set LOCAL_IP=%%i
)

echo =======================================================================
echo  O Servidor esta rodando em segundo plano.
echo.
echo  Acesse pelo celular (no mesmo Wi-Fi) pelo link:
echo  http://%LOCAL_IP%:3000/mobile
echo.
echo  Acesse o Painel Administrativo local pelo link:
echo  http://localhost:3000/admin
echo.
echo  Para encerrar o servidor, feche esta janela do prompt de comando.
echo =======================================================================
echo.

:loop
pause
goto loop
