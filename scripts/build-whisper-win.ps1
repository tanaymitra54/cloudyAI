# Build whisper.cpp for Windows and stage the binaries for packaging.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-whisper-win.ps1
#   npm run build:whisper:win
#
# Output: vendor/whisper/whisper-cli.exe
#
# The build is deliberately conservative so the installer runs on any Windows 10
# or 11 x64 machine without extra installs:
#   GGML_NATIVE=OFF           -> no AVX-512/AVX2 requirement baked in
#   GGML_OPENMP=OFF           -> no vcomp140.dll dependency
#   BUILD_SHARED_LIBS=OFF     -> whisper/ggml statically linked into one .exe
#   + the MSVC C runtime DLLs are copied next to the exe, because whisper.cpp's
#     CMake minimum (3.5/3.14) is too old to honour CMAKE_MSVC_RUNTIME_LIBRARY,
#     so a bare Windows without the VC++ redistributable would otherwise fail.

param(
  [string]$Ref = $(if ($env:WHISPER_CPP_REF) { $env:WHISPER_CPP_REF } else { 'v1.9.6' }),
  [string]$OutDir = "$PSScriptRoot\..\vendor\whisper",
  [string]$SrcDir = "$PSScriptRoot\..\vendor\whisper-src"
)

$ErrorActionPreference = 'Stop'

function Find-CrtDir {
  $candidates = @()

  if ($env:VCToolsRedistDir) {
    $candidates += Get-ChildItem -Path $env:VCToolsRedistDir -Directory -Recurse -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' }
  }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    $install = & $vswhere -latest -property installationPath
    if ($install) {
      $candidates += Get-ChildItem -Path (Join-Path $install 'VC\Redist\MSVC') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
          Get-ChildItem -Path (Join-Path $_.FullName 'x64') -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue
        }
    }
  }

  if (-not $candidates -and (Test-Path 'C:\Program Files\Microsoft Visual Studio')) {
    $candidates += Get-ChildItem -Path 'C:\Program Files\Microsoft Visual Studio' -Directory -Recurse -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' }
  }

  # Newest redist version wins.
  return ($candidates | Sort-Object FullName -Descending | Select-Object -First 1).FullName
}

Write-Host "whisper.cpp ref: $Ref"

if (-not (Test-Path (Join-Path $SrcDir '.git'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $SrcDir) | Out-Null
  git clone --depth 1 --branch $Ref https://github.com/ggml-org/whisper.cpp.git $SrcDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

Push-Location $SrcDir
try {
  cmake -B build -DCMAKE_BUILD_TYPE=Release `
    -DBUILD_SHARED_LIBS=OFF `
    -DGGML_NATIVE=OFF `
    -DGGML_OPENMP=OFF `
    -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded `
    -DCMAKE_POLICY_DEFAULT_CMP0091=NEW `
    -DWHISPER_BUILD_TESTS=OFF `
    -DWHISPER_BUILD_SERVER=OFF
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }

  cmake --build build --config Release --parallel
  if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

  # Layout changed across releases: build/bin/Release in 1.7+, build/Release before.
  $candidates = @(
    'build\bin\Release\whisper-cli.exe',
    'build\Release\whisper-cli.exe',
    'build\bin\Release\main.exe',
    'build\Release\main.exe'
  )
  $bin = $null
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $SrcDir $c)) { $bin = Join-Path $SrcDir $c; break }
  }
  if (-not $bin) { throw "whisper-cli.exe was not produced by the build" }

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Copy-Item $bin (Join-Path $OutDir 'whisper-cli.exe') -Force
  Write-Host "staged $(Join-Path $OutDir 'whisper-cli.exe')"

  $crt = Find-CrtDir
  if ($crt -and (Test-Path $crt)) {
    Copy-Item (Join-Path $crt '*.dll') $OutDir -Force
    Write-Host "staged C runtime DLLs from $crt"
  } else {
    Write-Warning 'Could not locate the MSVC x64 redistributable DLLs; whisper-cli.exe may need the VC++ 2015-2022 redistributable.'
  }
} finally {
  Pop-Location
}
