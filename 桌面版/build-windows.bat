@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
echo ============================================================
echo  Therapist Workstation - One-Click Windows Build (Full + Lite editions)
echo  (first run auto-installs missing tools; may take a while)
echo ============================================================
cd /d "%~dp0"

rem ---------- Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Node.js not found.
  where winget >nul 2>nul
  if errorlevel 1 ( echo [FAIL] winget not available. Install Node.js 22 LTS from https://nodejs.org then re-run. & pause & exit /b 1 )
  echo [SETUP] Installing Node.js LTS via winget...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements || ( echo [FAIL] Node install failed. & pause & exit /b 1 )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

rem ---------- Rust ----------
where cargo >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Rust/Cargo not found.
  where winget >nul 2>nul
  if errorlevel 1 ( echo [FAIL] winget not available. Install Rust from https://rustup.rs then re-run. & pause & exit /b 1 )
  echo [SETUP] Installing Rust via winget...
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements || ( echo [FAIL] Rust install failed. & pause & exit /b 1 )
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  rustup default stable >nul 2>nul
)

rem ---------- MSVC build tools (needed by SQLCipher native build) ----------
where link >nul 2>nul
if errorlevel 1 (
  echo [SETUP] MSVC linker not found. Installing Visual Studio 2022 Build Tools - this is a large one-time download...
  where winget >nul 2>nul
  if errorlevel 1 ( echo [FAIL] Install "Visual Studio 2022 Build Tools" with the C++ workload, then re-run. & pause & exit /b 1 )
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" || ( echo [FAIL] Build Tools install failed. & pause & exit /b 1 )
  echo [SETUP] Build Tools installed. If the build below still cannot find the linker, restart this script once.
)

rem ---------- Version consistency ----------
node -e "const fs=require('fs');const a=require('./package.json').version;const b=require('./src-tauri/tauri.conf.json').version;const c=fs.readFileSync('src-tauri/Cargo.toml','utf8').match(/^version\s*=\s*"([^"]+)"/m)[1];if(a!==b||a!==c){console.error('[FAIL] Version mismatch: package.json='+a+' tauri.conf.json='+b+' Cargo.toml='+c);process.exit(1)}console.log('[OK] Version '+a)"
if errorlevel 1 ( pause & exit /b 1 )
for /f %%v in ('node -p "require('./package.json').version"') do set "VER=%%v"

echo [1/4] Installing JavaScript dependencies...
call npm install || goto :fail
echo [2/4] Checking Rust backend (full + lite editions)...
call npm run check || goto :fail
call cargo check --manifest-path src-tauri\Cargo.toml --no-default-features || goto :fail
echo [3/4] Building Windows installer (NSIS)...
call npm run build -- --bundles nsis || goto :fail

echo [4/5] Collecting release files into .\release\ ...
if not exist release mkdir release
for %%f in ("src-tauri\target\release\bundle\nsis\*.exe") do (
  copy /y "%%f" "release\TherapistWorkstation-%VER%-Windows-Setup.exe" >nul
)
if not exist "release\TherapistWorkstation-%VER%-Windows-Setup.exe" ( echo [FAIL] Installer not found in bundle output. & goto :fail )
cd release
certutil -hashfile "TherapistWorkstation-%VER%-Windows-Setup.exe" SHA256 | findstr /v "hash CertUtil" > "TherapistWorkstation-%VER%-Windows-Setup.exe.sha256.txt"
cd ..

echo [5/5] Building portable (no-install) package...
set "PDIR=release\TherapistWorkstation-%VER%-Windows-Portable"
if exist "%PDIR%" rmdir /s /q "%PDIR%"
mkdir "%PDIR%"
if not exist "src-tauri\target\release\therapist-workstation.exe" ( echo [FAIL] Portable binary not found. & goto :fail )
copy /y "src-tauri\target\release\therapist-workstation.exe" "%PDIR%\TherapistWorkstation.exe" >nul
type nul > "%PDIR%\portable.mode"
copy /y "便携版说明.md" "%PDIR%\便携版说明.md" >nul
powershell -NoProfile -Command "Compress-Archive -Path '%PDIR%\*' -DestinationPath 'release\TherapistWorkstation-%VER%-Windows-Portable.zip' -Force" || ( echo [FAIL] Portable zip failed. & goto :fail )
certutil -hashfile "release\TherapistWorkstation-%VER%-Windows-Portable.zip" SHA256 | findstr /v "hash CertUtil" > "release\TherapistWorkstation-%VER%-Windows-Portable.zip.sha256.txt"

echo [6/7] Building Lite edition (no AI)...
if exist "src-tauri\target\release\bundle\nsis" rmdir /s /q "src-tauri\target\release\bundle\nsis"
call npm run build -- --bundles nsis --no-default-features --config src-tauri\tauri.lite.conf.json || goto :fail
for %%f in ("src-tauri\target\release\bundle\nsis\*.exe") do (
  copy /y "%%f" "release\TherapistWorkstation-%VER%-Windows-Lite-Setup.exe" >nul
)
if not exist "release\TherapistWorkstation-%VER%-Windows-Lite-Setup.exe" ( echo [FAIL] Lite installer not found in bundle output. & goto :fail )
cd release
certutil -hashfile "TherapistWorkstation-%VER%-Windows-Lite-Setup.exe" SHA256 | findstr /v "hash CertUtil" > "TherapistWorkstation-%VER%-Windows-Lite-Setup.exe.sha256.txt"
cd ..

echo [7/7] Building Lite portable package...
set "LDIR=release\TherapistWorkstation-%VER%-Windows-Lite-Portable"
if exist "%LDIR%" rmdir /s /q "%LDIR%"
mkdir "%LDIR%"
copy /y "src-tauri\target\release\therapist-workstation.exe" "%LDIR%\TherapistWorkstation-Lite.exe" >nul
type nul > "%LDIR%\portable.mode"
copy /y "便携版说明.md" "%LDIR%\便携版说明.md" >nul
powershell -NoProfile -Command "Compress-Archive -Path '%LDIR%\*' -DestinationPath 'release\TherapistWorkstation-%VER%-Windows-Lite-Portable.zip' -Force" || ( echo [FAIL] Lite portable zip failed. & goto :fail )
certutil -hashfile "release\TherapistWorkstation-%VER%-Windows-Lite-Portable.zip" SHA256 | findstr /v "hash CertUtil" > "release\TherapistWorkstation-%VER%-Windows-Lite-Portable.zip.sha256.txt"
echo.
echo ============================================================
echo  BUILD SUCCESSFUL
echo  Full edition : release\TherapistWorkstation-%VER%-Windows-Setup.exe + -Portable.zip
echo  Lite (no AI) : release\TherapistWorkstation-%VER%-Windows-Lite-Setup.exe + -Lite-Portable.zip
echo  Send that single .exe to the counselor. Data is NOT inside
echo  the installer; it stays in the app data folder on their PC.
echo ============================================================
start "" explorer "%CD%\release"
pause
exit /b 0
:fail
echo.
echo BUILD FAILED. Scroll up to the first [FAIL] or error line.
pause
exit /b 1
