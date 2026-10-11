param(
    [string[]]$ApiBaseUrl = @('https://nivra-webapp-secure.onrender.com', 'https://nivrapp-secure.onrender.com'),
    [ValidateRange(1,2147483647)][int]$ExpectedCallProtocol = 2,
    [ValidatePattern('(?-i)\A[0-9a-f]{64}\z')][string]$ExpectedClusterFingerprint
)
$ErrorActionPreference = 'Stop'
function Test-ReadyFlag($Value) { return $Value -is [bool] -and $Value }
function Test-CoreReadiness($Row) {
    return $Row.ApiFailover -and $Row.Database -and $Row.Storage -and $Row.Redis -and $Row.DurableKey -and $Row.Protocol -and $Row.Pin
}
if (@($ApiBaseUrl | Select-Object -Unique).Count -lt 2) { throw 'Configure at least two distinct API origins to verify a failover cluster.' }
$rows = foreach ($base in $ApiBaseUrl) {
    $uri = [Uri]$base
    if ($uri.Scheme -ne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'Use an HTTPS API origin without credentials, path, query, fragment or a custom port.'
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $health = Invoke-RestMethod -Method Get -Uri ($base.TrimEnd('/') + '/health/ready') -TimeoutSec 15 -MaximumRedirection 0 -Headers @{ 'Cache-Control' = 'no-cache' }
        $protocolReady = ($health.failoverProtocol -is [int] -or $health.failoverProtocol -is [long]) -and $health.failoverProtocol -eq 1 -and
            ($health.callProtocol -is [int] -or $health.callProtocol -is [long]) -and $health.callProtocol -ge $ExpectedCallProtocol -and
            ($health.minimumCallProtocol -is [int] -or $health.minimumCallProtocol -is [long]) -and $health.minimumCallProtocol -ge 1 -and $health.minimumCallProtocol -le $ExpectedCallProtocol
        # Legacy 2.1 health has no core readiness field. Only an absent property
        # permits its strict dependency fallback; explicit false/null is final.
        $apiFailoverReady = Test-ReadyFlag $health.apiFailoverReady
        if ($health.PSObject.Properties.Name -cnotcontains 'apiFailoverReady') {
            $apiFailoverReady = $health.status -ceq 'ok' -and (Test-ReadyFlag $health.sharedStorageReady) -and
                (Test-ReadyFlag $health.realtimeSharedReady) -and (Test-ReadyFlag $health.durableSigningKeyReady)
        }
        [pscustomobject]@{
            Api = $base; Version = $health.version; Database = $health.status -ceq 'ok';
            ApiFailover = $apiFailoverReady; MultiInstance = Test-ReadyFlag $health.multiInstanceReady;
            Storage = Test-ReadyFlag $health.sharedStorageReady; Redis = Test-ReadyFlag $health.realtimeSharedReady;
            DurableKey = Test-ReadyFlag $health.durableSigningKeyReady; PushProject = Test-ReadyFlag $health.pushProjectConfigured;
            Fcm = Test-ReadyFlag $health.pushFcmReady; WebPush = Test-ReadyFlag $health.pushWebReady;
            Protocol = $protocolReady; Pin = $health.clusterFingerprint -is [string] -and $health.clusterFingerprint -cmatch '\A[0-9a-f]{64}\z';
            ClusterFingerprint = $health.clusterFingerprint; Milliseconds = $timer.ElapsedMilliseconds
        }
    } catch {
        [pscustomobject]@{ Api=$base; Version=$null; Database=$false; ApiFailover=$false; MultiInstance=$false; Storage=$false; Redis=$false; DurableKey=$false; PushProject=$false; Fcm=$false; WebPush=$false; Protocol=$false; Pin=$false; ClusterFingerprint=$null; Milliseconds=$timer.ElapsedMilliseconds }
    }
}
$rows | Format-Table Api,Version,Database,ApiFailover,MultiInstance,Storage,Redis,DurableKey,Fcm,WebPush,Protocol,Pin,Milliseconds -AutoSize
$pins = @($rows | Where-Object { $_.Pin } | Select-Object -ExpandProperty ClusterFingerprint -Unique)
$coreReadyRows = @($rows | Where-Object { Test-CoreReadiness $_ })
if ($ExpectedClusterFingerprint) {
    $acceptedRows = @($coreReadyRows | Where-Object { $_.ClusterFingerprint -ceq $ExpectedClusterFingerprint })
    $excludedRows = @($rows | Where-Object { -not (Test-CoreReadiness $_) -or $_.ClusterFingerprint -cne $ExpectedClusterFingerprint })
    foreach ($row in $excludedRows) {
        Write-Warning ($row.Api + ': excluded from operational failover because readiness, protocol or the supplied trusted pin did not match.')
    }
    if ($acceptedRows.Count -eq 0) {
        Write-Output 'Operational failover unavailable: no configured API is core-ready with compatible protocols and the supplied trusted pin. No credentials were sent or settings changed.'
        exit 2
    }
    Write-Output ('Operational failover available: ' + $acceptedRows.Count + ' configured API(s) are core-ready and match the supplied trusted pin.')
    $acceptedRows | ForEach-Object { Write-Output ('Operational API: ' + $_.Api) }
    Write-Output ('Expected public cluster fingerprint: ' + $ExpectedClusterFingerprint)
    if ($excludedRows.Count -gt 0) {
        Write-Warning 'All-node cluster health remains unconfirmed while configured nodes are excluded.'
    }
} elseif ($coreReadyRows.Count -eq $rows.Count -and $pins.Count -eq 1) {
    $acceptedRows = $rows
    Write-Output 'Core cluster compatible: every configured API is ready for API failover and shares the same compatibility pin.'
    Write-Output ('Public cluster fingerprint: ' + $pins[0])
} else {
    Write-Output 'Core cluster not ready: require core readiness, shared dependencies, compatible protocols and matching pins on every configured API before initial activation. An unavailable API does not prove compatibility. No credentials were sent or settings changed.'
    exit 2
}
foreach ($row in $acceptedRows) {
    $missingPush = @()
    if (-not $row.PushProject) { $missingPush += 'FCM project' }
    if (-not $row.Fcm) { $missingPush += 'FCM' }
    if (-not $row.WebPush) { $missingPush += 'Web Push' }
    if ($missingPush.Count -gt 0) {
        Write-Warning ($row.Api + ': notification configuration pending: ' + ($missingPush -join ', ') + '. API failover is ready; background notification delivery is not confirmed.')
    }
}
if (@($acceptedRows | Where-Object { -not $_.MultiInstance }).Count -eq 0) {
    Write-Output 'Accepted API push configuration: all report multiInstanceReady=true. Push flags describe configuration, not an end-to-end delivery test.'
} else {
    Write-Warning 'Accepted API push configuration remains incomplete (multiInstanceReady=false). Review notification configuration separately.'
}
exit 0
