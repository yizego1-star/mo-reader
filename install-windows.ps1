# 墨读 Windows 一键安装器。运行：irm <GitHub raw URL> | iex
$ErrorActionPreference = 'Stop'
$Repository = 'https://github.com/yizego1-star/mo-reader'
$Ref = if ($env:MO_READER_REF) { $env:MO_READER_REF } else { 'agent/local-sentence-translation' }
$InstallDir = if ($env:MO_READER_INSTALL_DIR) { $env:MO_READER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA '墨读' }
$ArchiveUrl = "$Repository/archive/refs/heads/$Ref.zip"
$ChinaMode = $env:MO_READER_CN -eq '1'

function Write-Mo([string]$Message) { Write-Host "`n墨读  $Message" -ForegroundColor Green }
function Fail([string]$Message) { throw "安装失败：$Message" }
function Test-Command([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

function Install-WingetPackage([string]$Id) {
  if (-not (Test-Command 'winget')) { Fail '缺少 winget，无法自动安装运行环境。请在 Windows 10/11 中安装“应用安装程序”后重试。' }
  & winget install --id $Id --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Fail "winget 无法安装 $Id" }
}

if ($env:OS -ne 'Windows_NT') { Fail '此安装器只支持 Windows。' }
if (Test-Path -LiteralPath $InstallDir) { Fail "安装目录已存在：$InstallDir`n如需重新安装，请先移走该文件夹，或设置 MO_READER_INSTALL_DIR。" }

if ($ChinaMode) {
  # 脚本本身仍由 GitHub 原站下载；仅把较大的依赖与资源切换到镜像。
  $ArchiveUrl = if ($env:MO_READER_ARCHIVE_URL) { $env:MO_READER_ARCHIVE_URL } else { "https://ghfast.top/$Repository/archive/refs/heads/$Ref.zip" }
  $env:npm_config_registry = 'https://registry.npmmirror.com'
  $env:PIP_INDEX_URL = 'https://mirrors.aliyun.com/pypi/simple'
  $env:PAPER_READER_DICTIONARY_URL = 'https://ghfast.top/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'
  Write-M '已启用中国大陆加速镜像。'
}

if (-not (Test-Command 'node')) {
  Write-M '正在安装 Node.js…'
  Install-WingetPackage 'OpenJS.NodeJS.LTS'
  $nodeFallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $nodeFallback) { $env:Path = "$(Split-Path $nodeFallback);$env:Path" }
}
if (-not (Test-Command 'py') -and -not (Test-Command 'python')) {
  Write-M '正在安装 Python…'
  Install-WingetPackage 'Python.Python.3.12'
}

$Node = (Get-Command 'node' -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $Node)) { Fail 'Node.js 安装后仍不可用，请关闭并重新打开 PowerShell 后重试。' }
if (Test-Command 'py') {
  $PythonExe = 'py'
  $PythonArgs = @('-3')
} elseif (Test-Command 'python') {
  $PythonExe = 'python'
  $PythonArgs = @()
} else {
  Fail 'Python 安装后仍不可用，请关闭并重新打开 PowerShell 后重试。'
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mo-reader-" + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  $Archive = Join-Path $TempDir 'mo-reader.zip'
  Write-M '正在下载墨读…'
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile $Archive
  Expand-Archive -LiteralPath $Archive -DestinationPath $TempDir
  $Source = Get-ChildItem -LiteralPath $TempDir -Directory | Where-Object { $_.Name -like 'mo-reader-*' } | Select-Object -First 1
  if (-not $Source) { Fail '下载包结构不正确。' }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Get-ChildItem -LiteralPath $Source.FullName -Force | Move-Item -Destination $InstallDir

  Write-M '正在安装阅读器依赖…'
  Push-Location $InstallDir
  try {
    $npm = Join-Path (Split-Path $Node) 'npm.cmd'
    & $npm install --omit=dev
    if ($LASTEXITCODE -ne 0 -and $ChinaMode) {
      Write-M 'npm 镜像暂时不可用，正在回退官方源…'
      $env:npm_config_registry = 'https://registry.npmjs.org'
      & $npm install --omit=dev
    }
    if ($LASTEXITCODE -ne 0) { Fail 'npm 依赖安装失败。' }
    & $PythonExe @($PythonArgs + @('-m', 'venv', '.venv'))
    & "$InstallDir\.venv\Scripts\python.exe" -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0 -and $ChinaMode) {
      Write-M 'Python 镜像暂时不可用，正在回退官方源…'
      $env:PIP_INDEX_URL = ''
      & "$InstallDir\.venv\Scripts\python.exe" -m pip install --upgrade pip
    }
    if ($LASTEXITCODE -ne 0) { Fail 'pip 升级失败。' }
    & "$InstallDir\.venv\Scripts\python.exe" -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0 -and $ChinaMode) {
      Write-M 'Python 镜像暂时不可用，正在回退官方源…'
      $env:PIP_INDEX_URL = ''
      & "$InstallDir\.venv\Scripts\python.exe" -m pip install -r requirements.txt
    }
    if ($LASTEXITCODE -ne 0) { Fail 'Python 依赖安装失败。' }
    Write-M '正在准备离线词典与句子翻译模型（首次约需下载 130MB）…'
    & "$InstallDir\.venv\Scripts\python.exe" setup_local_dictionary.py
    $env:ARGOS_PACKAGES_DIR = "$InstallDir\.paper-reader-data\translation-models"
    & "$InstallDir\.venv\Scripts\python.exe" setup_local_translation.py
  } finally { Pop-Location }

  Write-M '正在创建桌面启动方式…'
  $launcher = @'
@echo off
setlocal
set "APP_DIR=%~dp0"
set "PORT=4317"
set "PAPER_READER_PYTHON=%APP_DIR%.venv\Scripts\python.exe"
set "PAPER_READER_ARGOS_PACKAGES_DIR=%APP_DIR%.paper-reader-data\translation-models"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:%PORT%/api/papers | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "墨读服务" /b node "%APP_DIR%server.mjs" > "%APP_DIR%.paper-reader-data\server.log" 2>&1
  timeout /t 2 /nobreak >nul
)
start "" "http://127.0.0.1:%PORT%"
endlocal
'@
  $launcherPath = Join-Path $InstallDir '启动墨读.cmd'
  Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding ASCII
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop '墨读.lnk'))
  $shortcut.TargetPath = $launcherPath
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description = '墨读 · 论文精读'
  $shortcut.Save()
  Start-Process $launcherPath
  Write-Host "`n安装完成。桌面已创建“墨读”快捷方式。安装位置：$InstallDir" -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $TempDir) { Remove-Item -LiteralPath $TempDir -Recurse -Force }
}
