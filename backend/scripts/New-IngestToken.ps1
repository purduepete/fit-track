<#
.SYNOPSIS
    Generate a fittrack API token locally and store its hash in Azure SQL.

.DESCRIPTION
    Thin, friendly wrapper around scripts/token_admin.py. Activates the backend
    virtual environment (if present) and creates a token with the requested
    scope. The raw token is printed once — paste it into the Health Auto Export
    app (ingest scope) or the web dashboard (read scope).

.PARAMETER Name
    A label for the token (e.g. "iphone-hae", "dashboard").

.PARAMETER Scope
    all | ingest | read. Default: all.

.EXAMPLE
    .\New-IngestToken.ps1 -Name iphone-hae -Scope ingest
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [ValidateSet('all', 'ingest', 'read')][string]$Scope = 'all'
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path $PSScriptRoot -Parent
Push-Location $backend
try {
    $venvPython = Join-Path $backend '.venv\Scripts\python.exe'
    $python = if (Test-Path $venvPython) { $venvPython } else { 'python' }
    & $python -m scripts.token_admin add --name $Name --scope $Scope
}
finally {
    Pop-Location
}
