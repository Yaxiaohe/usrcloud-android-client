@echo off
rem ============================================================
rem  Build script (portable).  Usage:  build.bat assembleRelease
rem
rem  Requires BEFORE running:
rem    JAVA_HOME        -> JDK 17
rem    ANDROID_SDK_ROOT -> Android SDK (compileSdk 34)
rem    gradle           -> on PATH (Gradle 8.x)
rem
rem  !! THIS FILE MUST STAY ASCII-ONLY !!
rem  cmd.exe reads .bat as GBK: UTF-8 non-ASCII comments corrupt
rem  parsing and silently truncate lines (symptom: "%JAVA_HOME"
rem  losing its leading %J). Keep comments in English.
rem ============================================================
setlocal

if "%JAVA_HOME%"=="" (
  echo [!] JAVA_HOME is not set. Point it at a JDK 17 install.
  exit /b 1
)
if "%ANDROID_SDK_ROOT%"=="" (
  echo [!] ANDROID_SDK_ROOT is not set. Point it at the Android SDK.
  exit /b 1
)
where gradle >nul 2>&1
if errorlevel 1 (
  echo [!] gradle not found on PATH.
  exit /b 1
)

cd /d "%~dp0"
gradle %* --no-daemon
exit /b %ERRORLEVEL%
