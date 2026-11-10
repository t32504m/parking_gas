@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。README.txt の「用意するもの」を見て、Node.js を入れてください。
  pause
  exit /b 1
)
set LOCAL_OPEN=1
node tools\serve-local.js
pause
