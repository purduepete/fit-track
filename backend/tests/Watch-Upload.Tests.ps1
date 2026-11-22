$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\Watch-Upload.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Watch-Upload.ps1 has parse errors: $errors" }
$waitFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-UploadFolder'
}, $true)
Invoke-Expression $waitFunction.Extent.Text

Describe 'Upload folder startup' {
    It 'waits for the folder and records the wait' {
        $folder = Join-Path $TestDrive 'late-drive'
        $log = Join-Path $TestDrive 'watcher.log'
        Mock Start-Sleep { New-Item -ItemType Directory -Path $folder | Out-Null }

        Wait-UploadFolder -Path $folder -Wait -Log $log

        Test-Path -LiteralPath $folder -PathType Container | Should Be $true
        Get-Content -LiteralPath $log | Should Match 'Waiting for watch folder'
        Assert-MockCalled Start-Sleep -Exactly 1 -Scope It -ParameterFilter { $Seconds -eq 30 }
    }

    It 'fails immediately for an interactive launch when the folder is missing' {
        $folder = Join-Path $TestDrive 'missing-drive'
        { Wait-UploadFolder -Path $folder } | Should Throw 'Watch folder not found'
    }

    It 'starts immediately when the folder already exists' {
        $folder = Join-Path $TestDrive 'ready-drive'
        New-Item -ItemType Directory -Path $folder | Out-Null
        Mock Start-Sleep { throw 'Unexpected sleep' }

        Wait-UploadFolder -Path $folder -Wait -Log (Join-Path $TestDrive 'ready.log')

        Assert-MockCalled Start-Sleep -Exactly 0 -Scope It
    }

    It 'records a startup failure before the watcher starts' {
        $backend = Join-Path $TestDrive 'backend'
        $scripts = Join-Path $backend 'scripts'
        New-Item -ItemType Directory -Path $scripts | Out-Null
        Copy-Item -LiteralPath $source -Destination (Join-Path $scripts 'Watch-Upload.ps1')
        $savedUrl = $env:FITTRACK_API_URL
        $savedToken = $env:FITTRACK_TOKEN
        try {
            $env:FITTRACK_API_URL = ''
            $env:FITTRACK_TOKEN = ''
            & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $scripts 'Watch-Upload.ps1') -Background 2>&1 | Out-Null
            $LASTEXITCODE | Should Not Be 0
            Get-Content -LiteralPath (Join-Path $backend 'logs\upload-watcher.log') |
                Should Match 'Startup or watcher error: Set FITTRACK_API_URL and FITTRACK_TOKEN'
        }
        finally {
            $env:FITTRACK_API_URL = $savedUrl
            $env:FITTRACK_TOKEN = $savedToken
        }
    }
}
