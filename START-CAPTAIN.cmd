@echo off
cd /d "%~dp0"
node tools\start-demo.mjs
if errorlevel 1 pause
