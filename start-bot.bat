@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"
if not exist "data" mkdir "data"

set "LOCK_FILE=data\bot.lock"
set "LOG_FILE=data\dev.log"

call :find_running_pid RUNNING_PID
if not "!RUNNING_PID!"=="" (
  echo Bot is already running. PID=!RUNNING_PID!
  echo Use stop-bot.bat or restart-bot.bat if needed.
  goto :end
)

if exist "%LOCK_FILE%" del /f /q "%LOCK_FILE%" >nul 2>&1

echo [%date% %time%] ==== start requested ====>> "%LOG_FILE%"
start "discord-codex-bot" /min cmd /c "cd /d ""%~dp0"" && npm run dev >> ""%~dp0data\dev.log"" 2>&1"

for /L %%I in (1,1,12) do (
  ping 127.0.0.1 -n 2 >nul
  call :find_running_pid RUNNING_PID
  if not "!RUNNING_PID!"=="" (
    echo Bot started. PID=!RUNNING_PID!
    goto :end
  )
)

echo Start command sent, but process not confirmed yet.
echo Check data\dev.log for details.

:end
endlocal
exit /b 0

:find_running_pid
setlocal
set "FOUND_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-bot-pid.ps1" -RepoPath "%cd%"`) do (
  set "FOUND_PID=%%P"
  goto :find_done
)
:find_done
endlocal & set "%~1=%FOUND_PID%"
exit /b 0
