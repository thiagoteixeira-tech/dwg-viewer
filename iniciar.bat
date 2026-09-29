@echo off
REM Inicia o DWG Viewer localmente e abre o navegador.
cd /d "%~dp0"
python serve.py %*
