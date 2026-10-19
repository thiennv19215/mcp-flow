param([ValidateSet('Start', 'Stop')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$launchMutex = $null
$hasLaunchLock = $false
try {
    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $studioEntry = Join-Path $repoRoot 'dist\studio.js'
    $flowPort = 8799
    if ($env:FLOW_MCP_PORT) { $flowPort = [int]$env:FLOW_MCP_PORT }
    if ($flowPort -lt 1 -or $flowPort -gt 65535) { throw 'Invalid FLOW_MCP_PORT.' }
    # Serialize simultaneous double-clicks, including the build and readiness wait.
    $launchMutex = New-Object System.Threading.Mutex($false, "Local\FlowMCPStudioPort$flowPort")
    try { $hasLaunchLock = $launchMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $hasLaunchLock = $true }
    if (!$hasLaunchLock) {
        Write-Host "Another Start/Stop is already handling port $flowPort. No second process started."
        exit 0
    }
    $studioUrl = "http://127.0.0.1:$flowPort"
    $listeners = @(Get-NetTCPConnection -LocalPort $flowPort -State Listen -ErrorAction SilentlyContinue)
    if ($Action -eq 'Stop') {
        if (!$listeners.Count) { Write-Host "Port $flowPort is already closed."; exit 0 }
        foreach ($ownerId in ($listeners.OwningProcess | Sort-Object -Unique)) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId"
            if ($owner.Name -ne 'node.exe' -or !$owner.CommandLine.Contains($studioEntry)) {
                throw "Port $flowPort belongs to another launcher/process (PID $ownerId). Close its original terminal first."
            }
            Stop-Process -Id $ownerId -ErrorAction Stop
        }
        Write-Host "Flow Studio stopped. Port $flowPort released."
        exit 0
    }
    if ($listeners.Count) {
        $health = Invoke-RestMethod "$studioUrl/api/health" -TimeoutSec 3
        if ($health.name -ne 'flow-mcp') { throw "Port $flowPort is used by another app." }
        Start-Process $studioUrl
        Write-Host "Flow Studio is already running: $studioUrl"
        exit 0
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
        Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    }
    if (!(Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js 22 or newer, then try again.' }
    $compiler = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'
    if (!(Test-Path -LiteralPath $compiler)) { throw 'Run npm install in this repo first.' }
    Push-Location $repoRoot
    try {
        & $nodePath $compiler
        if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the errors above.' }
    } finally { Pop-Location }
    $logDir = Join-Path $env:LOCALAPPDATA "FlowMCP\port-$flowPort"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $started = Start-Process -FilePath $nodePath -ArgumentList ('"' + $studioEntry + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'stdout.log') -RedirectStandardError (Join-Path $logDir 'stderr.log') -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        $started.Refresh()
        if ($started.HasExited) { throw "Studio exited. See $logDir\stderr.log" }
        try { $health = Invoke-RestMethod "$studioUrl/api/health" -TimeoutSec 1 } catch { continue }
        if ($health.name -eq 'flow-mcp') { Write-Host "Flow Studio started: $studioUrl"; exit 0 }
    }
    throw "Studio did not become ready. See $logDir\stderr.log"
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($hasLaunchLock) { $launchMutex.ReleaseMutex() }
    if ($launchMutex) { $launchMutex.Dispose() }
}
