<#
.SYNOPSIS
  Download + flatten Oracle Instant Client into src-tauri/resources/instantclient/
  so `tauri build` bundles it (see that folder's README.md).

.DESCRIPTION
  Fetches the free, no-login "Basic Light" package for Windows x64 from Oracle's
  OTN CDN, extracts it, and flattens the inner instantclient_* folder directly
  into the resources folder (so oci.dll sits at the top level). Idempotent: skips
  the download when oci.dll is already present. Use -Force to re-download.

  For other platforms/arches, download the matching Basic (or Basic Light) package
  from https://www.oracle.com/database/technologies/instant-client/downloads.html
  and unzip its contents into the same folder.
#>
[CmdletBinding()]
param(
  # Basic Light Windows x64 (small, English + a few charsets, no login required).
  # For full NLS use the "Basic" package URL instead.
  [string]$Url = 'https://download.oracle.com/otn_software/nt/instantclient/2380000/instantclient-basiclite-windows.x64-23.8.0.25.04.zip',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$dest = Join-Path $repoRoot 'src-tauri/resources/instantclient'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

if ((Test-Path (Join-Path $dest 'oci.dll')) -and -not $Force) {
  Write-Host "Instant Client already present at $dest (use -Force to re-download)."
  exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ic_" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'ic.zip'
  Write-Host "Downloading $Url ..."
  Invoke-WebRequest -Uri $Url -OutFile $zip

  Write-Host "Extracting ..."
  Expand-Archive -Path $zip -DestinationPath $tmp -Force

  # The zip extracts to instantclient_<ver>/ — flatten its contents into $dest.
  $inner = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'instantclient*' } | Select-Object -First 1
  if (-not $inner) { throw "Could not find an instantclient_* folder inside the archive." }

  Get-ChildItem -Path $inner.FullName -Force | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $dest $_.Name) -Recurse -Force
  }

  if (-not (Test-Path (Join-Path $dest 'oci.dll'))) {
    throw "oci.dll not found after extraction — the download may be incomplete or the wrong package."
  }
  Write-Host "Instant Client ready at $dest"
}
finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
