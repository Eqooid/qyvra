<#
.SYNOPSIS
Start QYVRA locally with optional AI assets and Elasticsearch.
.EXAMPLE
.\scripts\start-local.ps1 -AI -Search
.EXAMPLE
.\scripts\start-local.ps1 -AI -ValidateOnly
#>
[CmdletBinding()]
param(
    [switch]$All,
    [switch]$AI,
    [switch]$Search,
    [switch]$OllamaHost,
    [switch]$NoBuild,
    [switch]$ValidateOnly,
    [switch]$OpenBrowser,
    [ValidateRange(30, 1800)]
    [int]$WaitTimeoutSeconds = 360
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($All) { $AI = $true; $Search = $true }

function Get-LocalSetting {
    param([string]$Name)
    $inherited = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($inherited)) { return $inherited }
    foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $projectRoot '.env'))) {
        if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=(.*)$')) {
            return $Matches[1].Trim().Trim([char[]]'"''')
        }
    }
    return ''
}

function Set-LocalSetting {
    param([string]$Name, [string]$Value)
    $envPath = Join-Path $projectRoot '.env'
    $content = [System.IO.File]::ReadAllText($envPath)
    $pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
    if ([regex]::IsMatch($content, $pattern)) { $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) "$Name=$Value" }) }
    else { $content += "`n$Name=$Value`n" }
    [System.IO.File]::WriteAllText($envPath, $content, (New-Object System.Text.UTF8Encoding $false))
}

function Wait-Docker {
    $engineType = Get-DockerEngine
    $probeExitCode = $script:dockerProbeExitCode
    if ($probeExitCode -ne 0) {
        $desktop = Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktop)) { throw 'Start Docker with Linux containers, then try again.' }
        Write-Host 'Starting Docker Desktop...'
        Start-Process -FilePath $desktop -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds($WaitTimeoutSeconds)
        do {
            Start-Sleep -Seconds 3
            $engineType = Get-DockerEngine
            $probeExitCode = $script:dockerProbeExitCode
            if ($probeExitCode -eq 0) { break }
        } while ((Get-Date) -lt $deadline)
        if ($probeExitCode -ne 0) { throw 'Docker did not become ready. Open Docker Desktop, resolve its startup error, then try again.' }
    }
    if (($engineType -join '').Trim() -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then try again.' }
}

function Get-DockerEngine {
    # A stopped daemon writes stderr. Treat that as a probe result on Windows
    # PowerShell too, rather than letting NativeCommandError terminate setup.
    $ErrorActionPreference = 'Continue'
    & docker info --format '{{.OSType}}' 2>$null
    $script:dockerProbeExitCode = $LASTEXITCODE
}

function Prepare-LocalSecrets {
    $names = @('SEARCH_BOOTSTRAP_PASSWORD_FILE', 'SEARCH_RUNTIME_PASSWORD_FILE')
    $missing = @($names | Where-Object { [string]::IsNullOrWhiteSpace((Get-LocalSetting $_)) })
    if ($missing.Count -eq 0) { return }
    $projectName = Get-LocalSetting 'COMPOSE_PROJECT_NAME'
    if (-not $projectName) { $projectName = 'qyvra' }
    $volume = Get-LocalSetting 'SEARCH_VOLUME_NAME'
    if (-not $volume) { $volume = $projectName + '_search_data' }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $existing = & docker volume inspect $volume --format '{{.Name}}' 2>$null
        $volumeExists = $LASTEXITCODE -eq 0
    } finally { $ErrorActionPreference = $previousPreference }
    if ($volumeExists) { throw 'Elasticsearch data already exists but a password-file setting is missing. Restore its original secret-file paths in .env; passwords will not be replaced.' }
    $secretRoot = Join-Path $env:USERPROFILE '.qyvra-secrets'
    [System.IO.Directory]::CreateDirectory($secretRoot) | Out-Null
    foreach ($name in $missing) {
        $fileName = if ($name -eq 'SEARCH_BOOTSTRAP_PASSWORD_FILE') { 'search-bootstrap.txt' } else { 'search-runtime.txt' }
        $filePath = Join-Path $secretRoot $fileName
        if (-not (Test-Path -LiteralPath $filePath)) {
            $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $bytes = New-Object byte[] 32; $random.GetBytes($bytes) }
            finally { $random.Dispose() }
            $password = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
            $stream = [System.IO.File]::Open($filePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
            try { $data = [System.Text.Encoding]::ASCII.GetBytes($password); $stream.Write($data, 0, $data.Length) }
            finally { $stream.Dispose() }
            $password = $null
        }
        Set-LocalSetting $name $filePath.Replace('\', '/')
    }
    Write-Host 'Local search password files configured. Existing files were preserved.'
}

function Start-LocalOllama {
    # Leave operator-managed remote inference alone. Start only the Windows-host
    # endpoint used by the documented Docker Desktop local configuration.
    $endpoint = Get-LocalSetting 'GENERATION_ENDPOINT'
    if ($endpoint -notmatch '^http://host\.docker\.internal:11434/') { return }
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollama) { throw 'Install Ollama for Windows, then run Start QYVRA.cmd again.' }
    try { $catalog = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5 }
    catch {
        Write-Host 'Starting Ollama...'
        Start-Process -FilePath $ollama.Source -ArgumentList 'serve' -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(30)
        $catalog = $null
        do {
            Start-Sleep -Seconds 2
            try { $catalog = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 }
            catch { $catalog = $null }
        } while ($null -eq $catalog -and (Get-Date) -lt $deadline)
        if ($null -eq $catalog) { throw 'Ollama did not start. Open the Ollama app and try again.' }
    }
    $models = @()
    if ((Get-LocalSetting 'EMBEDDING_PROFILE_FINGERPRINT') -eq 'd974061c6457904b1bc92abd1ec496798cb8d39d2939383621f6d8a624d7cf92') { $models += 'nomic-embed-text:v1.5' }
    if ((Get-LocalSetting 'GENERATION_MODEL') -eq 'qwen3:0.6b') { $models += 'qwen3:0.6b' }
    foreach ($model in $models) {
        if ($model -notin @($catalog.models | ForEach-Object { $_.name })) {
            Write-Host "Downloading missing local model $model (first run only)..."
            & $ollama.Source pull $model
            if ($LASTEXITCODE -ne 0) { throw "Could not download $model. Check your internet connection and disk space, then try again." }
        }
    }
}

function Invoke-LocalSearchSetup {
    param([string]$Phase)
    $helper = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'local-search-setup.cjs'))
    $arguments = @('run', '--rm', '--no-deps', '-T', '-e', "QYVRA_LOCAL_SETUP_PHASE=$Phase", '-e', "QYVRA_LOCAL_WAIT_SECONDS=$WaitTimeoutSeconds", '-e', 'KEYWORD_SEARCH_ENABLED=false', '-e', 'HYBRID_SEARCH_ENABLED=false', '-e', 'SEARCH_ENROLLMENT_ENABLED=false', 'api', 'node')
    $result = $helper | & docker @composeArguments @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Local search setup stopped. Your data was retained. See the setup message above, correct the cause, and rerun Start QYVRA.cmd.' }
    $line = @($result | Where-Object { $_ -like 'QYVRA_LOCAL_RESULT=*' })
    if ($line.Count -ne 1) { throw 'Search setup did not return a verified configuration.' }
    return $line[0].Substring('QYVRA_LOCAL_RESULT='.Length) | ConvertFrom-Json
}

function Invoke-Compose {
    param([string[]]$CommandArguments)
    & docker @composeArguments @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed (exit $LASTEXITCODE). Fix the reported error and rerun this script."
    }
}

function Get-ServiceSetting {
    param($Service, [string]$Name)
    $property = $Service.environment.PSObject.Properties[$Name]
    if ($null -ne $property) { return [string]$property.Value }
    return ''
}

Push-Location -LiteralPath $projectRoot
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker was not found. Install Docker Desktop with Linux containers and Compose v2.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env') -PathType Leaf)) {
        throw 'Missing root .env. Copy .env.example to .env and replace the PostgreSQL password placeholder first.'
    }
    if ($OllamaHost -and -not $AI) {
        throw '-OllamaHost requires -AI. Docker Desktop already provides host.docker.internal; this option is for native Linux Docker.'
    }

    if ($All -and -not $ValidateOnly) {
        Wait-Docker
        if ((Get-LocalSetting 'NODE_ENV') -notin @('', 'development')) { throw '-All automatic setup is for local development only. Use explicit -AI/-Search switches for operator-managed deployments.' }
        $backupRoot = Join-Path $projectRoot '.tools/start-local'
        [System.IO.Directory]::CreateDirectory($backupRoot) | Out-Null
        $backupFile = Join-Path $backupRoot 'env-before-all.backup'
        if (-not (Test-Path -LiteralPath $backupFile)) { Copy-Item -LiteralPath (Join-Path $projectRoot '.env') -Destination $backupFile }
        Prepare-LocalSecrets
    }

    $composeArguments = @('compose', '--project-directory', $projectRoot, '-f', 'docker-compose.yml')
    if ($AI) { $composeArguments += @('-f', 'docker-compose.local-ai.yml') }
    if ($Search) { $composeArguments += @('-f', 'docker-compose.search.yml') }
    if ($OllamaHost) { $composeArguments += @('-f', 'docker-compose.ollama-host.yml') }

    Write-Host 'Validating Compose configuration...'
    Invoke-Compose -CommandArguments @('config', '--quiet')
    # Capture resolved settings in memory only: config output contains credentials.
    $configurationJson = & docker @composeArguments config --format json
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve Compose configuration.' }
    $configuration = ($configurationJson -join "`n") | ConvertFrom-Json
    $api = $configuration.services.api

    if (-not $All -or $ValidateOnly) {
        foreach ($pair in @(@('SEARCH_ENROLLMENT_ENABLED', 'SEARCH_GENERATION_FINGERPRINT'), @('KEYWORD_SEARCH_ENABLED', 'KEYWORD_SEARCH_GENERATION_FINGERPRINT'))) {
            if ((Get-ServiceSetting $api $pair[0]) -eq 'true' -and (Get-ServiceSetting $api $pair[1]) -notmatch '^[0-9a-f]{64}$') {
                throw "$($pair[1]) is missing or invalid. For automatic local search setup, double-click Start QYVRA.cmd or run this script with -All."
            }
        }
    }

    if ($AI) {
        $assetMount = @($api.volumes | Where-Object { $_.target -eq '/run/qyvra-ai' })
        if ($assetMount.Count -ne 1 -or -not (Test-Path -LiteralPath $assetMount[0].source -PathType Container)) {
            throw 'LOCAL_AI_ASSETS_DIR must point to an existing directory containing the prepared tokenizer bundles. See docs/development/local-ai.md.'
        }
        foreach ($setting in @('EMBEDDING_TOKENIZER_PATH', 'GENERATION_TOKENIZER_PATH')) {
            $containerPath = Get-ServiceSetting $api $setting
            if ($containerPath.StartsWith('/run/qyvra-ai/')) {
                $relativePath = $containerPath.Substring('/run/qyvra-ai/'.Length)
                $assetPath = [System.IO.Path]::GetFullPath((Join-Path $assetMount[0].source $relativePath))
                $assetRoot = [System.IO.Path]::GetFullPath($assetMount[0].source).TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
                if (-not $assetPath.StartsWith($assetRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
                    throw "Missing mounted tokenizer file for $setting. Prepare the bundles described in docs/development/local-ai.md."
                }
            }
        }
        if ((Get-ServiceSetting $api 'EMBEDDING_ENABLED') -ne 'true' -or (Get-ServiceSetting $api 'RAG_ENABLED') -ne 'true') {
            if ($All) { throw 'Local AI has not been configured yet. Install the verified models and prepare profiles/assets using docs/development/local-ai.md, then double-click Start QYVRA.cmd again.' }
            Write-Warning '-AI mounts assets; AI features still follow .env flags. Complete docs/development/local-ai.md to enable ingestion, semantic search and answers.'
        }
    }

    if ($Search) {
        $secretValues = @()
        foreach ($name in @('search_bootstrap_password', 'search_runtime_password')) {
            $secretPath = $configuration.secrets.$name.file
            if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
                throw "Missing $name file. Configure SEARCH_BOOTSTRAP_PASSWORD_FILE and SEARCH_RUNTIME_PASSWORD_FILE in .env; see docs/phase-5-elasticsearch.md."
            }
            $secret = [System.IO.File]::ReadAllText($secretPath).TrimEnd([char[]]"`n")
            if ($secret -cnotmatch '^[a-zA-Z0-9]{16,128}$') {
                throw "$name must contain 16-128 alphanumeric characters, optionally followed by LF. Secret contents were not printed."
            }
            $secretValues += $secret
        }
        if ($secretValues[0] -ceq $secretValues[1]) { throw 'Search bootstrap and runtime passwords must differ.' }
        $secretValues = $null
        $secret = $null
        if ((Get-ServiceSetting $api 'KEYWORD_SEARCH_ENABLED') -ne 'true') {
            Write-Warning '-Search starts Elasticsearch; Keyword/Hybrid serving still requires a provisioned generation, indexing and .env flags. See docs/phase-5-search-operations.md.'
        }
    }

    if ($ValidateOnly) {
        Write-Host 'Configuration and local files validated. No containers were started; database profiles, provider connectivity and model compatibility were not checked.'
        return
    }

    if ($All) { Start-LocalOllama }

    $engineType = & docker info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is unavailable. Start Docker Desktop with Linux containers, then rerun this script.' }
    if (($engineType -join '').Trim() -ne 'linux') { throw 'QYVRA requires Docker running Linux containers.' }

    if ($Search) {
        Write-Host 'Starting Elasticsearch and waiting for health...'
        Invoke-Compose -CommandArguments @('up', '-d', '--wait', '--wait-timeout', "$WaitTimeoutSeconds", 'elasticsearch')
        Write-Host 'Provisioning Elasticsearch runtime credentials (repeatable)...'
        Invoke-Compose -CommandArguments @('run', '--rm', '--no-deps', 'search-setup')
    }

    if ($All) {
        if (-not $NoBuild) { Invoke-Compose -CommandArguments @('build', 'api', 'worker', 'outbox', 'web', 'nginx') }
        Invoke-Compose -CommandArguments @('up', '-d', '--wait', '--wait-timeout', "$WaitTimeoutSeconds", 'postgres', 'rabbitmq', 'redis', 'qdrant')
        Invoke-Compose -CommandArguments @('run', '--rm', '--no-deps', 'migrate')
        Write-Host 'Preparing local search indexes and document processing...'
        $searchConfiguration = Invoke-LocalSearchSetup 'prepare'
        Set-LocalSetting 'SEARCH_GENERATION_FINGERPRINT' $searchConfiguration.fingerprint
        Set-LocalSetting 'KEYWORD_SEARCH_GENERATION_FINGERPRINT' $searchConfiguration.fingerprint
        Set-LocalSetting 'SEARCH_ENROLLMENT_ENABLED' 'true'
        # Keep serving off until the operator service verifies publication/cutover.
        Set-LocalSetting 'KEYWORD_SEARCH_ENABLED' 'false'
        Set-LocalSetting 'HYBRID_SEARCH_ENABLED' 'false'
    }

    $startArguments = @('up', '-d', '--wait', '--wait-timeout', "$WaitTimeoutSeconds")
    if ($NoBuild -or $All) { $startArguments += '--no-build' }
    else { $startArguments += '--build' }
    # One-shot helpers run separately or through service_completed_successfully dependencies.
    $services = @($configuration.services.PSObject.Properties.Name | Where-Object { $_ -notin @('migrate', 'search-setup') })
    Write-Host 'Starting QYVRA and waiting for services...'
    Invoke-Compose -CommandArguments ($startArguments + $services)
    if ($All) {
        Write-Host 'Waiting for document search indexes, then verifying search readiness...'
        $null = Invoke-LocalSearchSetup 'finish'
        Set-LocalSetting 'KEYWORD_SEARCH_ENABLED' 'true'
        if ((Get-ServiceSetting $api 'SEMANTIC_SEARCH_ENABLED') -eq 'true') { Set-LocalSetting 'HYBRID_SEARCH_ENABLED' 'true' }
        Invoke-Compose -CommandArguments @('up', '-d', '--no-build', '--wait', '--wait-timeout', "$WaitTimeoutSeconds", 'api', 'worker')
    }
    Invoke-Compose -CommandArguments @('ps', '--all')
    Write-Host 'QYVRA started. Use your configured PUBLIC_APP_URL (default http://localhost:8080).'
    if ($AI) { Write-Host 'Ollama runs separately. Model installation, database profiles and document indexing use the existing local AI setup guide.' }
    if ($All) { Write-Host 'Next time, double-click Start QYVRA.cmd. Persistent volumes are retained.' }
    else { Write-Host 'Rerun with the same -AI/-Search options. Persistent volumes are retained.' }
    if ($OpenBrowser) {
        $url = Get-LocalSetting 'PUBLIC_APP_URL'
        if (-not $url) { $url = 'http://localhost:8080' }
        $parsed = $null
        if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -notin @('http', 'https')) { throw 'PUBLIC_APP_URL must be an absolute HTTP(S) address.' }
        Start-Process $parsed.AbsoluteUri
    }
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
finally {
    Pop-Location
}
