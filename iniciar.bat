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
echo =======================================================================
echo  O Servidor esta rodando em segundo plano.
echo  Acesse pelo celular no mesmo Wi-Fi usando o IP local do Notebook.
echo  Para encerrar o servidor, feche esta janela do prompt de comando.
echo =======================================================================
echo.

:loop
pause
goto loop
