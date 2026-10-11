param(
    [string[]]$ApiBaseUrl = @('https://nivra-webapp-secure.onrender.com', 'https://nivrapp-secure.onrender.com'),
    [ValidateRange(1,2147483647)][int]$ExpectedCallProtocol = 2
)
$ErrorActionPreference = 'Stop'
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
        [pscustomobject]@{
            Api = $base; Version = $health.version; Database = $health.status -eq 'ok';
            MultiInstance = $health.multiInstanceReady -eq $true; Storage = $health.sharedStorageReady -eq $true;
            Redis = $health.realtimeSharedReady -eq $true; Fcm = $health.pushFcmReady -eq $true; WebPush = $health.pushWebReady -eq $true;
            Protocol = $protocolReady; Pin = $health.clusterFingerprint -cmatch '^[0-9a-f]{64}$';
            ClusterFingerprint = $health.clusterFingerprint; Milliseconds = $timer.ElapsedMilliseconds
        }
    } catch {
        [pscustomobject]@{ Api=$base; Version=$null; Database=$false; MultiInstance=$false; Storage=$false; Redis=$false; Fcm=$false; WebPush=$false; Protocol=$false; Pin=$false; ClusterFingerprint=$null; Milliseconds=$timer.ElapsedMilliseconds }
    }
}
$rows | Format-Table Api,Version,Database,MultiInstance,Storage,Redis,Fcm,WebPush,Protocol,Pin,Milliseconds -AutoSize
$pins = @($rows | Where-Object { $_.Pin } | Select-Object -ExpandProperty ClusterFingerprint -Unique)
$ready = @($rows | Where-Object { $_.MultiInstance -and $_.Database -and $_.Storage -and $_.Redis -and $_.Fcm -and $_.WebPush -and $_.Protocol -and $_.Pin }).Count -eq $rows.Count
if ($ready -and $pins.Count -eq 1) {
    Write-Output 'Cluster compatible: every configured API is ready and shares the same compatibility pin.'
    Write-Output ('Public cluster fingerprint: ' + $pins[0])
    exit 0
}
Write-Output 'Cluster not ready: configure the shared dependencies and matching credentials before enabling failover. No credentials were sent or settings changed.'
exit 2
