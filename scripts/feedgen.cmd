@echo off
setlocal
set "WSL=wsl -d Ubuntu -u root --"

if "%~1"=="" (
  %WSL% feedgen help
  exit /b %ERRORLEVEL%
)

if /I "%~1"=="up" goto :ensure
if /I "%~1"=="ensure" goto :ensure

%WSL% feedgen %*
exit /b %ERRORLEVEL%

:ensure
echo [feedgen] ensuring services...
%WSL% bash /mnt/c/pro/feedgen/scripts/start-and-verify.sh
exit /b %ERRORLEVEL%
