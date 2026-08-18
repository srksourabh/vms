@echo off
REM Starts the on-premise Secure Gate stack, then keeps the window open so logs are visible.
cd /d "%~dp0\..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
