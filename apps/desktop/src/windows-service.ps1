param(
  [Parameter(Mandatory=$true)][ValidateSet('install','uninstall','status','start','stop')][string]$Action,
  [string]$ServiceName = 'MonaAgent',
  [string]$DisplayName = 'Mona Agent',
  [string]$Description = 'Policy-governed Mona AI execution agent',
  [string]$BinaryPath = '',
  [string]$WorkingDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows only' }
if ($ServiceName -ne 'MonaAgent') { throw 'Invalid service name' }
function Out($obj) { $obj | ConvertTo-Json -Compress }
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
switch ($Action) {
  'status' {
    if ($null -eq $svc) { Out @{ ok=$true; action=$Action; installed=$false; running=$false; state='missing'; serviceName=$ServiceName }; exit 0 }
    Out @{ ok=$true; action=$Action; installed=$true; running=($svc.Status -eq 'Running'); state=[string]$svc.Status; serviceName=$ServiceName }; exit 0
  }
  'install' {
    if (-not [IO.Path]::IsPathRooted($BinaryPath)) { throw 'BinaryPath must be absolute' }
    if (-not [IO.Path]::IsPathRooted($WorkingDirectory)) { throw 'WorkingDirectory must be absolute' }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw 'WorkingDirectory does not exist' }
    if ($null -eq $svc) { New-Service -Name $ServiceName -BinaryPathName $BinaryPath -DisplayName $DisplayName -Description "$Description; managed service schema v1" -StartupType Automatic | Out-Null }
    & sc.exe config $ServiceName start= delayed-auto | Out-Null
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
    Start-Service -Name $ServiceName
    Out @{ ok=$true; action=$Action; installed=$true; serviceName=$ServiceName }; exit 0
  }
  'start' { Start-Service -Name $ServiceName; Out @{ ok=$true; action=$Action; serviceName=$ServiceName }; exit 0 }
  'stop' { Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue; Out @{ ok=$true; action=$Action; serviceName=$ServiceName }; exit 0 }
  'uninstall' { Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue; if ($null -ne $svc) { sc.exe delete $ServiceName | Out-Null }; Out @{ ok=$true; action=$Action; serviceName=$ServiceName }; exit 0 }
}
