param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root '.cache'
$tools = Join-Path $root 'tools'
$modelRoot = Join-Path $root 'vendor/mortal'
$manifest = Get-Content (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $cache,$tools,$modelRoot | Out-Null
Set-Location $root

$edgeCandidates = @(
    "${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe",
    "$env:ProgramFiles/Microsoft/Edge/Application/msedge.exe",
    "$env:LOCALAPPDATA/Microsoft/Edge/Application/msedge.exe"
)
if (!($edgeCandidates | Where-Object { Test-Path $_ })) {
    if (!(Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Install Microsoft Edge from https://www.microsoft.com/edge and run setup again.' }
    Write-Output 'Installing Microsoft Edge'
    & winget.exe install --id Microsoft.Edge --exact --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Microsoft Edge installation failed. Run setup again after installing Edge.' }
}

function Download-Asset($asset, $name) {
    $file = Join-Path $cache $name
    if ((Test-Path $file) -and (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -eq $asset.sha256) { return $file }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            Write-Host "Downloading $name (attempt $($attempt+1))"
            $request = [Net.HttpWebRequest]::Create($asset.url)
            $request.Timeout = 60000
            $request.ReadWriteTimeout = 60000
            $request.UserAgent = 'MahjongHelperSetup/0.4'
            $offset = if (Test-Path $file) { (Get-Item $file).Length } else { 0 }
            if ($offset -gt 0) { $request.AddRange($offset) }
            $response = $request.GetResponse()
            $mode = if ($offset -gt 0 -and [int]$response.StatusCode -eq 206) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
            $out = [IO.File]::Open($file, $mode, [IO.FileAccess]::Write)
            try {
                $stream = $response.GetResponseStream()
                $buffer = New-Object byte[] 65536
                $progressTimer = [Diagnostics.Stopwatch]::StartNew()
                while (($count = $stream.Read($buffer,0,$buffer.Length)) -gt 0) {
                    $out.Write($buffer,0,$count)
                    if ($progressTimer.Elapsed.TotalSeconds -ge 5) {
                        Write-Host "$name : $([Math]::Round($out.Length/1MB,1)) MB"
                        $progressTimer.Restart()
                    }
                }
            } finally { $out.Dispose(); $response.Dispose() }
            if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $asset.sha256) {
                Remove-Item -LiteralPath $file
                throw "Checksum mismatch: $name"
            }
            return $file
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 416 -and (Test-Path $file)) { Remove-Item -LiteralPath $file }
            if ($attempt -eq 2) { throw }
            Write-Host $_.Exception.Message
        }
    }
}
function Run($program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}
function Extract($zip, $folder) { Expand-Archive -LiteralPath $zip -DestinationPath $folder -Force }

Write-Output '1/5 Preparing Node.js and Go'
$node = Join-Path $tools "node-v$($manifest.node.version)-win-x64/node.exe"
if (!(Test-Path $node)) { Extract (Download-Asset $manifest.node 'node.zip') $tools }
$npm = Join-Path (Split-Path $node) 'npm.cmd'
$go = Join-Path $tools 'go/bin/go.exe'
if (!(Test-Path $go)) { Extract (Download-Asset $manifest.go 'go.zip') $tools }
$env:PATH = "$(Split-Path $node);$(Split-Path $go);$env:PATH"
$env:GOPROXY = 'https://goproxy.cn,direct'
$env:GOMODCACHE = Join-Path $cache 'go-mod'
$env:GOCACHE = Join-Path $cache 'go-build'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

Write-Output '2/5 Preparing Python and local inference'
if (!(Test-Path "$env:WINDIR/System32/vcruntime140_1.dll") -or !(Test-Path "$env:WINDIR/System32/msvcp140.dll")) {
    $redist = Download-Asset $manifest.vcredist 'VC_redist.x64.exe'
    Write-Output 'Installing Microsoft Visual C++ runtime'
    $installation = Start-Process -FilePath $redist -ArgumentList '/install','/quiet','/norestart' -WindowStyle Hidden -Wait -PassThru
    if ($installation.ExitCode -notin @(0,3010,1638)) { throw "Visual C++ runtime installation failed: $($installation.ExitCode)" }
}
$python = Join-Path $modelRoot 'runtime/python.exe'
if (!(Test-Path $python)) { Extract (Download-Asset $manifest.python 'python.zip') (Split-Path $python) }
$packages = Join-Path (Split-Path $python) 'packages'
New-Item -ItemType Directory -Force -Path $packages | Out-Null
Set-Content -LiteralPath (Join-Path (Split-Path $python) 'python312._pth') -Encoding ASCII -Value "python312.zip`r`n.`r`npackages`r`nimport site`r`n"
$runtimeCheck = Join-Path $PSScriptRoot 'check-runtime.py'
$probe = & $python -B $runtimeCheck
if ($LASTEXITCODE -ne 0) {
    $pipMeta = Invoke-RestMethod 'https://pypi.org/pypi/pip/25.2/json'
    $pipAsset = $pipMeta.urls | Where-Object { $_.filename -eq 'pip-25.2-py3-none-any.whl' } | Select-Object -First 1
    $pipFile = Download-Asset @{url=$pipAsset.url;sha256=$pipAsset.digests.sha256} 'pip.zip'
    Extract $pipFile $packages
    $torchWheel = Download-Asset $manifest.torch $manifest.torch.filename
    Run $python @('-m','pip','install','--disable-pip-version-check','--timeout','90','--retries','5','--cache-dir',(Join-Path $cache 'pip'),'--upgrade','--target',$packages,'-r',(Join-Path $PSScriptRoot 'requirements-mortal.txt'),$torchWheel)
}

Write-Output '3/5 Preparing three-player and four-player policies'
foreach ($asset in $manifest.models) {
    $target = Join-Path $modelRoot "$($asset.players)p"
    $zip = Download-Asset $asset "model-$($asset.players)p.zip"
    $staging = Join-Path $cache "model-$($asset.players)p"
    Extract $zip $staging
    $source = if (Test-Path (Join-Path $staging 'model.py')) { $staging } else {
        (Get-ChildItem $staging -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'model.py') } | Select-Object -First 1).FullName
    }
    if (!$source) { throw 'Invalid model package layout' }
    New-Item -ItemType Directory -Force -Path (Join-Path $target 'libriichi') | Out-Null
    foreach ($name in @('model.py','_libriichi_loader.py','online_status.py','mortal.pth','LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target -Force
    }
    $lib = if ($asset.players -eq 3) { 'libriichi3p' } else { 'libriichi' }
    Copy-Item -LiteralPath (Join-Path $source "libriichi/$lib-3.12-x86_64-pc-windows-msvc.pyd") -Destination (Join-Path $target 'libriichi') -Force
}
Run $python @('-B',$runtimeCheck)

if (!$SkipBuild) {
    Write-Output '4/5 Installing project dependencies and building analysis engine'
    Run $npm @('ci','--no-audit','--no-fund')
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
    Push-Location (Join-Path $root 'engine')
    try { Run $go @('build','-o','../bin/overlay-engine.exe','./cmd/overlay-engine') } finally { Pop-Location }
    Write-Output '5/5 Validating policies and building desktop package'
    Run $node @('scripts/check-models.cjs')
    Run $npm @('run','build','--','--config.electronDist=node_modules/electron/dist')
}
if ($SkipBuild) { Write-Output 'Runtime preparation complete.' }
else { Write-Output 'Setup complete. Application: release/win-unpacked/Mahjong Helper Overlay.exe' }
