[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ExtraArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if ($env:OS -ne "Windows_NT") {
    throw "This script must be run on Windows."
}

Push-Location $RepoRoot
try {
    Write-Host "Installing frontend dependencies..."
    npm --prefix ui ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "Building unsigned Windows .msi and NSIS .exe installers..."
    $TauriArgs = @("tauri", "build", "--ci", "--no-sign", "--bundles", "msi,nsis")
    if ($ExtraArgs) { $TauriArgs += $ExtraArgs }
    & cargo @TauriArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host ""
    Write-Host "Windows installers are available under:"
    Get-ChildItem -Path "$RepoRoot\target" -Directory -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*\release\bundle" } |
        ForEach-Object { Write-Host "  $($_.FullName)\" }
}
finally {
    Pop-Location
}
