[CmdletBinding()]
param(
    [string]$TokenFile = (Join-Path $env:LOCALAPPDATA 'FitTrack\strava\tokens.json'),
    [string]$RuntimeSid,
    [ValidateRange(1, 365)][int]$Days = 90,
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path $PSScriptRoot -Parent
$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Python environment missing: $python" }
if ((Test-Path -LiteralPath $TokenFile) -and -not $Replace) {
    throw 'Credentials already exist. Stop the Strava sync before rerunning with -Replace.'
}

$directory = Split-Path $TokenFile -Parent
if ((Split-Path $directory -Leaf) -ne 'strava') {
    throw 'Use a dedicated directory named strava so its private ACL cannot change other application files.'
}
if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$fullControl = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
foreach ($sid in $fullControl) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($sid),
        'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
}
if ($RuntimeSid -and $RuntimeSid -notin $fullControl) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($RuntimeSid),
        'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $directory -AclObject $acl

Push-Location $backend
try {
    & $python -m scripts.authorize_strava --token-file $TokenFile --days $Days
    if ($LASTEXITCODE -ne 0) { throw 'Strava authorization failed. No import was started.' }
}
finally {
    Pop-Location
}
