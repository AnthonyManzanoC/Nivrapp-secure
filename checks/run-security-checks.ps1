param([switch]$IncludeRatchetPilot)

$ErrorActionPreference = 'Stop'
$securityWorkspace = Split-Path -Parent $PSScriptRoot
function Invoke-Checked([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Security check failed with exit code $LASTEXITCODE." }
}
Push-Location -LiteralPath $securityWorkspace
try {
    Invoke-Checked { dotnet run --project checks/Nivra.SecurityChecks }
    $securityNodeTests = @(
        Get-ChildItem -LiteralPath Nivra.Desktop -Filter '*.test.js' | ForEach-Object FullName
        Get-ChildItem -LiteralPath checks -Filter '*.test.cjs' | ForEach-Object FullName
    )
    Invoke-Checked { node --test @securityNodeTests }
    # Moderate tooling alerts remain visible; high/critical findings fail the run.
    Invoke-Checked { npm.cmd audit --audit-level=high }
    Invoke-Checked { npm.cmd --prefix nivra-app audit --audit-level=high }
    Invoke-Checked { npm.cmd --prefix Nivra.Desktop audit --audit-level=high }
    if ($IncludeRatchetPilot) {
        $securityNodeVersion = [version]((& node -p 'process.versions.node').Trim())
        if ($securityNodeVersion -lt [version]'24.18.1') { throw 'The ratchet pilot requires Node 24.18.1 or later.' }
        Invoke-Checked { npm.cmd --prefix crypto/ratchet-pilot test }
    }
} finally {
    Pop-Location
}
