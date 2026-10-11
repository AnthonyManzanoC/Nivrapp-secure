param([string]$Fixture, [string]$ExpectedPin)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$checker = Join-Path $PSScriptRoot '../tools/check-api-cluster.ps1'

# Each fixture runs the real checker in a child PowerShell process so its exit
# code is exercised. The mocked HTTP command cannot contact any real host.
if ($Fixture) {
    function Invoke-RestMethod {
        param($Method, [string]$Uri, $TimeoutSec, $MaximumRedirection, $Headers)
        $hostName = ([Uri]$Uri).Host
        if ($hostName -notin @('first.example.test', 'second.example.test')) { throw 'Unexpected fixture origin.' }
        if ($hostName -eq 'first.example.test' -and $Fixture.StartsWith('operational-')) { throw 'Fixture primary returned HTTP 503.' }
        $health = @{
            status = 'ok'; version = 'fixture'; failoverProtocol = 1; callProtocol = 2; minimumCallProtocol = 2
            apiFailoverReady = $true; multiInstanceReady = $true; sharedStorageReady = $true
            realtimeSharedReady = $true; durableSigningKeyReady = $true; pushProjectConfigured = $true
            pushFcmReady = $true; pushWebReady = $true; clusterFingerprint = ('a' * 64)
        }
        if ($hostName -eq 'second.example.test') {
            switch ($Fixture) {
                'no-fcm' { $health.pushFcmReady = $false; $health.multiInstanceReady = $false }
                'no-web-push' { $health.pushWebReady = $false; $health.multiInstanceReady = $false }
                'no-project' { $health.pushProjectConfigured = $false; $health.multiInstanceReady = $false }
                'no-redis' { $health.realtimeSharedReady = $false }
                'no-storage' { $health.sharedStorageReady = $false }
                'no-signing-key' { $health.durableSigningKeyReady = $false }
                'no-database' { $health.status = 'unavailable' }
                'core-unready' { $health.apiFailoverReady = $false }
                'legacy-readiness' { $health.Remove('apiFailoverReady') }
                'legacy-no-redis' { $health.Remove('apiFailoverReady'); $health.realtimeSharedReady = $false }
                'legacy-no-storage' { $health.Remove('apiFailoverReady'); $health.sharedStorageReady = $false }
                'legacy-no-signing-key' { $health.Remove('apiFailoverReady'); $health.durableSigningKeyReady = $false }
                'legacy-invalid-status' { $health.Remove('apiFailoverReady'); $health.status = 'OK' }
                'null-core-readiness' { $health.apiFailoverReady = $null }
                'invalid-readiness-type' { $health.apiFailoverReady = 'true' }
                'wrong-pin' { $health.clusterFingerprint = ('b' * 64) }
                'invalid-pin' { $health.clusterFingerprint = 'invalid' }
                'wrong-protocol' { $health.minimumCallProtocol = 3 }
                'unavailable' { throw 'Fixture API unavailable.' }
                'operational-backup' { $health.pushFcmReady = $false; $health.multiInstanceReady = $false }
                'operational-mismatch' { $health.clusterFingerprint = ('b' * 64) }
                'operational-explicit-false' { $health.apiFailoverReady = $false }
                'operational-legacy' { $health.Remove('apiFailoverReady'); $health.pushFcmReady = $false; $health.multiInstanceReady = $false }
                'operational-legacy-no-redis' { $health.Remove('apiFailoverReady'); $health.realtimeSharedReady = $false }
                'operational-wrong-protocol' { $health.minimumCallProtocol = 3 }
                'expected-mismatch' { $health.clusterFingerprint = ('b' * 64) }
            }
        }
        return [pscustomobject]$health
    }
    $checkerArgs = @{ ApiBaseUrl = @('https://first.example.test', 'https://second.example.test') }
    if ($PSBoundParameters.ContainsKey('ExpectedPin')) { $checkerArgs.ExpectedClusterFingerprint = $ExpectedPin }
    & $checker @checkerArgs
    exit $LASTEXITCODE
}

$shellPath = (Get-Process -Id $PID).Path
$cases = @(
    @{ Name = 'full-ready'; Exit = 0; Contains = 'Accepted API push configuration: all report multiInstanceReady=true' }
    @{ Name = 'no-fcm'; Exit = 0; Contains = 'notification configuration pending: FCM.' }
    @{ Name = 'no-web-push'; Exit = 0; Contains = 'notification configuration pending: Web Push.' }
    @{ Name = 'no-project'; Exit = 0; Contains = 'notification configuration pending: FCM project.' }
    @{ Name = 'legacy-readiness'; Exit = 0; Contains = 'Core cluster compatible:' }
    @{ Name = 'expected-baseline'; Pin = ('a' * 64); Exit = 0; Contains = 'Operational failover available: 2 configured API(s)' }
    @{ Name = 'operational-backup'; Pin = ('a' * 64); Exit = 0; Contains = 'Operational failover available: 1 configured API(s)' }
    @{ Name = 'operational-legacy'; Pin = ('a' * 64); Exit = 0; Contains = 'Operational failover available: 1 configured API(s)' }
    @{ Name = 'expected-mismatch'; Pin = ('a' * 64); Exit = 0; Contains = 'Operational failover available: 1 configured API(s)' }
    @{ Name = 'invalid-expected-pin'; Pin = ('A' * 64); Exit = 1; Contains = 'ExpectedClusterFingerprint' }
)
foreach ($name in @('no-redis', 'no-storage', 'no-signing-key', 'no-database', 'core-unready', 'legacy-no-redis', 'legacy-no-storage', 'legacy-no-signing-key', 'legacy-invalid-status', 'null-core-readiness', 'invalid-readiness-type', 'wrong-pin', 'invalid-pin', 'wrong-protocol', 'unavailable', 'operational-backup-no-pin')) {
    $cases += @{ Name = $name; Exit = 2; Contains = 'Core cluster not ready:' }
}
foreach ($name in @('operational-mismatch', 'operational-explicit-false', 'operational-legacy-no-redis', 'operational-wrong-protocol')) {
    $cases += @{ Name = $name; Pin = ('a' * 64); Exit = 2; Contains = 'Operational failover unavailable:' }
}
foreach ($case in $cases) {
    $fixtureArgs = @('-NoProfile', '-File', $PSCommandPath, '-Fixture', $case.Name)
    if ($case.ContainsKey('Pin')) { $fixtureArgs += @('-ExpectedPin', $case.Pin) }
    $output = & $shellPath @fixtureArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($code -ne $case.Exit -or -not $output.Contains($case.Contains)) {
        throw "Fixture $($case.Name) failed (exit $code, expected $($case.Exit)): $output"
    }
    if ($case.Exit -eq 0 -and -not $case.ContainsKey('Pin') -and -not $output.Contains('Core cluster compatible:')) {
        throw "Fixture $($case.Name) did not confirm core compatibility: $output"
    }
    if ($case.Name -in @('no-fcm', 'no-web-push', 'no-project', 'operational-backup', 'operational-legacy') -and -not $output.Contains('Accepted API push configuration remains incomplete')) {
        throw "Fixture $($case.Name) did not preserve incomplete full readiness: $output"
    }
    if ($case.Name -in @('operational-backup', 'operational-legacy', 'expected-mismatch') -and
        (-not $output.Contains('excluded from operational failover') -or -not $output.Contains('All-node cluster health remains unconfirmed') -or $output.Contains('Core cluster compatible:'))) {
        throw "Fixture $($case.Name) did not distinguish operational recovery from all-node cluster readiness: $output"
    }
    Write-Output "PASS $($case.Name)"
}
Write-Output "$($cases.Count) local cluster checker fixtures passed. No network requests were sent."
