@echo off
rem ============================================================
rem  Build script (Windows).
rem
rem  !! READ THIS BEFORE EDITING !!
rem  1. This file MUST stay ASCII-only. cmd.exe reads .bat as GBK,
rem     so UTF-8 Chinese comments corrupt parsing and silently
rem     truncate lines (symptom: "%%JAVA_HOME" losing its leading %%J).
rem  2. Never hardcode the project path. It may contain non-ASCII
rem     characters. %%~dp0 always points at this script's directory.
rem
rem  Usage:
rem    build.bat assembleRelease
rem    build.bat assembleDebug
rem
rem  Environment (optional, auto-detected when not set):
rem    JAVA_HOME          - JDK 17+
rem    ANDROID_SDK_ROOT   - Android SDK (compileSdk 34)
rem    TC                 - toolchain root; when set, JDK / SDK / Gradle
rem                         are looked up under %%TC%%\jdk, %%TC%%\sdk,
rem                         %%TC%%\gradle-8.7
rem
rem  The Gradle Wrapper is bundled in this repo, so a system-wide
rem  Gradle install is NOT required (first run downloads Gradle 8.7).
rem ============================================================
setlocal
cd /d "%~dp0"

rem ---- 1) JDK ----
if defined JAVA_HOME goto :sdk
if defined TC if exist "%TC%\jdk" (
    for /d %%D in ("%TC%\jdk\*") do set "JAVA_HOME=%%~fD"
)
if not defined JAVA_HOME (
    for /d %%D in ("%USERPROFILE%\.workbuddy\*\*\_toolchain\jdk\*") do set "JAVA_HOME=%%~fD"
)
if not defined JAVA_HOME (
    echo [ERROR] JAVA_HOME not found. Point it at a JDK 17+ install.
    exit /b 1
)

rem ---- 2) Android SDK ----
:sdk
if defined ANDROID_SDK_ROOT goto :build
if defined TC if exist "%TC%\sdk" set "ANDROID_SDK_ROOT=%TC%\sdk"
if not defined ANDROID_SDK_ROOT if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_SDK_ROOT=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_SDK_ROOT if exist "%~dp0local.properties" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0local.properties") do (
        if "%%A"=="sdk.dir" set "ANDROID_SDK_ROOT=%%B"
    )
)
if not defined ANDROID_SDK_ROOT (
    echo [ERROR] ANDROID_SDK_ROOT not found. Install the Android SDK
    echo         ^(compileSdk 34^), or set ANDROID_SDK_ROOT, or write
    echo         sdk.dir=... into local.properties.
    exit /b 1
)

rem ---- 3) Build ----
:build
echo JAVA_HOME        = %JAVA_HOME%
echo ANDROID_SDK_ROOT = %ANDROID_SDK_ROOT%
if exist "%~dp0gradlew.bat" (
    call "%~dp0gradlew.bat" %* --no-daemon
) else (
    gradle %* --no-daemon
)
endlocal
