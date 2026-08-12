# This file is published as a static asset at:
#   https://machine-memory.jfa.dev/install.ps1

$ErrorActionPreference = "Stop"

$repo = "jfalava/machine-memory"
$installDirectory = if ($env:MACHINE_MEMORY_INSTALL_DIR) {
  $env:MACHINE_MEMORY_INSTALL_DIR
} else {
  Join-Path $HOME ".local/bin"
}

if ($env:OS -eq "Windows_NT") {
  $platform = "windows"
} else {
  $uname = (& uname -s).Trim()
  $platform = switch ($uname) {
    "Darwin" { "darwin"; break }
    "Linux" { "linux"; break }
    default { throw "Unsupported operating system: $uname" }
  }
}

$rawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
  $env:PROCESSOR_ARCHITEW6432
} elseif ($env:PROCESSOR_ARCHITECTURE) {
  $env:PROCESSOR_ARCHITECTURE
} else {
  (& uname -m).Trim()
}

$architecture = switch ($rawArchitecture.ToLowerInvariant()) {
  { $_ -in @("amd64", "x86_64") } { "x64"; break }
  { $_ -in @("arm64", "aarch64") } { "arm64"; break }
  default { throw "Unsupported architecture: $rawArchitecture" }
}

if ($platform -eq "darwin" -and $architecture -ne "arm64") {
  throw "Unsupported platform: $platform/$architecture (available: macOS arm64)"
}
if ($platform -eq "windows" -and $architecture -ne "x64") {
  throw "Unsupported platform: $platform/$architecture (available: Windows x64)"
}

$asset = "machine-memory-$platform-$architecture.zip"
$binary = if ($platform -eq "windows") { "machine-memory.exe" } else { "machine-memory" }
$downloadUrl = "https://github.com/$repo/releases/latest/download/$asset"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("machine-memory-install-" + [Guid]::NewGuid().ToString("N"))
$archive = Join-Path $temporaryDirectory $asset
$extractedDirectory = Join-Path $temporaryDirectory "extracted"
$temporaryBinary = Join-Path $installDirectory (".$binary." + [Guid]::NewGuid().ToString("N") + ".tmp")

try {
  New-Item -ItemType Directory -Force -Path $extractedDirectory | Out-Null
  Write-Host "Downloading machine-memory for $platform/$architecture..."
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $extractedDirectory -Force

  $sourceBinary = Join-Path $extractedDirectory $binary
  if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
    throw "Release archive did not contain $binary"
  }

  New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
  Copy-Item -LiteralPath $sourceBinary -Destination $temporaryBinary -Force
  Move-Item -LiteralPath $temporaryBinary -Destination (Join-Path $installDirectory $binary) -Force

  Write-Host "Installed machine-memory at $(Join-Path $installDirectory $binary)"
  if (":$($env:PATH):" -notlike "*:$($installDirectory):*") {
    Write-Host "Add $installDirectory to your user PATH if it is not already there."
  }
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $temporaryBinary) {
    Remove-Item -LiteralPath $temporaryBinary -Force -ErrorAction SilentlyContinue
  }
}
