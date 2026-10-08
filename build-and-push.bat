@echo off
setlocal EnableDelayedExpansion

REM =============================================================================
REM Build dan Push Docker Image (Nuxt 4 fullstack: frontend + Nitro server)
REM =============================================================================
REM Usage:
REM   build-and-push.bat patch
REM   build-and-push.bat minor
REM   build-and-push.bat major
REM
REM Tag yang dihasilkan: v<versi>-<shortSHA>   (contoh: v1.0.1-a1b2c3d)
REM Versi dibaca & di-bump dari app.version.txt, disimpan HANYA jika build+push sukses.
REM =============================================================================

REM -----------------------------
REM Config
REM -----------------------------
set REPO=davidnathanael/berca-netops-webapp
set VERSION_FILE=app.version.txt
set CONTEXT=.

set BUMP=%1

REM -----------------------------
REM Parse & validate argument
REM -----------------------------
if "%BUMP%"=="" goto :usage
call :validateBump "%BUMP%"
if errorlevel 1 exit /b 1

REM -----------------------------
REM Hitung versi baru dari file
REM -----------------------------
call :processVersion "%VERSION_FILE%" "%BUMP%" NEW_VERSION
if errorlevel 1 exit /b 1

REM -----------------------------
REM Ambil git commit (short SHA)
REM -----------------------------
for /f "delims=" %%i in ('git rev-parse --short HEAD 2^>nul') do set SHA=%%i
if "!SHA!"=="" (
    echo ERROR: Gagal ambil git commit.
    exit /b 1
)

REM -----------------------------
REM Build tag
REM -----------------------------
set TAG=v!NEW_VERSION!-!SHA!

echo ==============================================
echo Build ^& Push Docker Image
echo ==============================================
echo Repo    : %REPO%
echo Version : !NEW_VERSION!   (bump: %BUMP%)
echo Commit  : !SHA!
echo Tag     : !TAG!
echo ==============================================
echo.

REM -----------------------------
REM Build
REM -----------------------------
echo [BUILD] Building image...
docker build -t %REPO%:!TAG! "%CONTEXT%"
if errorlevel 1 goto :error
echo [BUILD] Build complete.
echo.

REM -----------------------------
REM Push
REM -----------------------------
echo [PUSH] Pushing image...
docker push %REPO%:!TAG!
if errorlevel 1 goto :error
echo [PUSH] Push complete.
echo.

REM -----------------------------
REM Simpan version baru hanya jika sukses
REM -----------------------------
> "%VERSION_FILE%" echo !NEW_VERSION!

echo ==============================================
echo SUCCESS.
echo ==============================================
echo   - %REPO%:!TAG!
echo ==============================================
goto :end

:error
echo.
echo ==============================================
echo ERROR. Build atau push gagal.
echo Version file tidak diupdate.
echo ==============================================
exit /b 1

:usage
echo.
echo Usage:
echo   build-and-push.bat major^|minor^|patch
echo.
echo Contoh:
echo   build-and-push.bat patch
echo   build-and-push.bat minor
echo   build-and-push.bat major
echo.
exit /b 1

:validateBump
set TMP_BUMP=%~1
if /I "%TMP_BUMP%"=="major" exit /b 0
if /I "%TMP_BUMP%"=="minor" exit /b 0
if /I "%TMP_BUMP%"=="patch" exit /b 0
echo ERROR: bump type hanya boleh major / minor / patch
exit /b 1

:processVersion
set FILE=%~1
set BUMP=%~2
set RETURN_VAR=%~3

if not exist "%FILE%" (
    echo ERROR: File %FILE% tidak ditemukan.
    exit /b 1
)

set /p CURRENT_VERSION=<"%FILE%"

for /f "tokens=1,2,3 delims=." %%a in ("%CURRENT_VERSION%") do (
    set VMAJOR=%%a
    set VMINOR=%%b
    set VPATCH=%%c
)

if "!VMAJOR!"=="" (
    echo ERROR: Format version di %FILE% tidak valid.
    exit /b 1
)
if "!VMINOR!"=="" (
    echo ERROR: Format version di %FILE% tidak valid.
    exit /b 1
)
if "!VPATCH!"=="" (
    echo ERROR: Format version di %FILE% tidak valid.
    exit /b 1
)

if /I "%BUMP%"=="major" (
    set /a VMAJOR+=1
    set VMINOR=0
    set VPATCH=0
)

if /I "%BUMP%"=="minor" (
    set /a VMINOR+=1
    set VPATCH=0
)

if /I "%BUMP%"=="patch" (
    set /a VPATCH+=1
)

set NEW_VER=!VMAJOR!.!VMINOR!.!VPATCH!
set %RETURN_VAR%=!NEW_VER!
exit /b 0

:end
endlocal
