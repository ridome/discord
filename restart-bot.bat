@echo off
setlocal

cd /d "%~dp0"
call "%~dp0stop-bot.bat"
ping 127.0.0.1 -n 2 >nul
call "%~dp0start-bot.bat"

endlocal
