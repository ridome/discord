@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"
set "LOCK_FILE=data\bot.lock"
set "TARGET_PID="

call :find_running_pid TARGET_PID
if "!TARGET_PID!"=="" (
  echo Bot is not running.
  if exist "%LOCK_FILE%" del /f /q "%LOCK_FILE%" >nul 2>&1
  goto :end
)

echo Stopping bot PID=!TARGET_PID! ...
taskkill /PID !TARGET_PID! /F >nul 2>&1
if errorlevel 1 (
  echo Failed to stop PID=!TARGET_PID!. Try running as Administrator.
  goto :end
)

ping 127.0.0.1 -n 3 >nul
if exist "%LOCK_FILE%" del /f /q "%LOCK_FILE%" >nul 2>&1
call :find_running_pid STILL_RUNNING_PID
if "!STILL_RUNNING_PID!"=="" (
  echo Bot stopped.
) else (
  echo Warning: a bot process still appears to be running ^(PID=!STILL_RUNNING_PID!^).
)

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
