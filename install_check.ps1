<#
.SYNOPSIS
  Install the InfiniSynapse CLI (agent_infini) on Windows and distribute its
  Skill file to any detected AI tool (.cursor / .codex / .gemini / .claude).

.DESCRIPTION
  1. Detects the OS/arch and downloads the matching agent_infini binary from OSS.
  2. Installs it to %USERPROFILE%\.infini\bin and adds that dir to the user PATH.
  3. Writes a SKILL.md into each detected AI tool's skills directory.

.PARAMETER Version
  CLI version to download. Default: 0.9.0

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.9.0
#>

[CmdletBinding()]
param(
    [string]$Version = "0.9.0"
)

$ErrorActionPreference = "Stop"
$BaseUrl   = "https://infinisynapse.oss-cn-shanghai.aliyuncs.com/plugins/infini_cli"
$SkillUrl  = "https://infinisynapse.oss-cn-shanghai.aliyuncs.com/cli-install/SKILL.md"
$InstallDir = Join-Path $HOME ".infini\bin"
$SkillName  = "agent_infini"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. Detect platform -> OSS directory + file name
# ---------------------------------------------------------------------------
function Get-PlatformDir {
    # OSS only ships win32-x64 for Windows; x64 binary also runs on ARM64 Windows.
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "ARM64") {
        Write-Warn2 "Detected Windows ARM64; using win32-x64 binary (runs via emulation)."
    }
    return "win32-x64"
}

$platformDir = Get-PlatformDir
$fileName    = "agent_infini.exe"
$downloadUrl = "$BaseUrl/$platformDir/$Version/$fileName"
$targetPath  = Join-Path $InstallDir $fileName

# ---------------------------------------------------------------------------
# 2. Download binary
# ---------------------------------------------------------------------------
Write-Step "Downloading agent_infini $Version ($platformDir)"
Write-Host "    $downloadUrl"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $targetPath -UseBasicParsing -TimeoutSec 120
} catch {
    throw "Download failed: $($_.Exception.Message)"
}

if (-not (Test-Path $targetPath) -or (Get-Item $targetPath).Length -eq 0) {
    throw "Downloaded file is missing or empty: $targetPath"
}
Write-Ok "Installed to $targetPath"

# ---------------------------------------------------------------------------
# 3. Add install dir to user PATH
# ---------------------------------------------------------------------------
Write-Step "Updating PATH"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$pathEntries = $userPath.Split(';') | Where-Object { $_ -ne "" }
if ($pathEntries -notcontains $InstallDir) {
    $newPath = (@($pathEntries) + $InstallDir) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$env:Path;$InstallDir"
    Write-Ok "Added $InstallDir to user PATH (restart shell to take effect)."
} else {
    Write-Ok "$InstallDir already on PATH."
}

# ---------------------------------------------------------------------------
# 4. Distribute SKILL.md to detected AI tools
# ---------------------------------------------------------------------------
Write-Step "Distributing Skill file to detected AI tools"

# Resolve a SKILL.md source: local file next to script > download from server >
# embedded fallback. Use a temp file so Chinese/UTF-8 content stays byte-accurate.
$skillSrc = Join-Path ([System.IO.Path]::GetTempPath()) "agent_infini_SKILL.md"
$gotSkill = $false
$localSkill = if ($PSScriptRoot) { Join-Path $PSScriptRoot "SKILL.md" } else { $null }
if ($localSkill -and (Test-Path $localSkill)) {
    Copy-Item $localSkill $skillSrc -Force
    $gotSkill = $true
    Write-Ok "Using local SKILL.md"
} else {
    try {
        Invoke-WebRequest -Uri $SkillUrl -OutFile $skillSrc -UseBasicParsing -TimeoutSec 60
        if ((Test-Path $skillSrc) -and (Get-Item $skillSrc).Length -gt 0) {
            $gotSkill = $true
            Write-Ok "Downloaded SKILL.md from server"
        }
    } catch { }
}
if (-not $gotSkill) {
    Write-Warn2 "Falling back to embedded SKILL content."
    Set-Content -Path $skillSrc -Encoding UTF8 -Value @'
---
name: agent_infini
description: Use the InfiniSynapse CLI (agent_infini) to run multi-turn AI data-analysis tasks, manage database/RAG context, and work with task workspace files from the terminal. Use when the user mentions InfiniSynapse, agent_infini, or wants AI-driven database / RAG analysis from the command line.
---

# agent_infini (InfiniSynapse CLI)

`agent_infini` is a CLI that talks to the InfiniSynapse backend REST API to run multi-turn AI tasks, manage data sources / RAG knowledge bases, and handle task workspace files.

Binary default location: `~/.infini/bin/agent_infini` (Windows: `%USERPROFILE%\.infini\bin\agent_infini.exe`). If `agent_infini` is not on PATH, call it by full path.

## Setup (run once)
    agent_infini init --api-key "your_api_key"
Writes ~/.agent_infini/config.txt (server, api-key, console, prefer-language).

## Recommended workflow
1. agent_infini init --api-key "your_api_key"
2. agent_infini db ls / agent_infini rag ls
3. agent_infini task context  (enable with db enable / rag enable if needed)
4. agent_infini task new "..."  then  agent_infini task ask <taskId> "..."
5. agent_infini task ls / show / file / download

## Commands
    init --api-key sk-xxx [--server URL] [--prefer-language zh_CN]
    task new <query> | task ask <taskId> <query>
    task ls [--page N] [--page-size N] [--search Q]
    task show <taskId> | task context | task cancel <taskId> | task rm <id...>
    task file <taskId> | task preview <taskId> <file> | task download <taskId> <file> [-o dir]
    db ls [--type T] [--enabled] [--disabled] | db enable <id...> | db disable <id...>
    rag ls [--keyword K] [--enabled] [--disabled] | rag enable <id...> | rag disable <id...>
    skill | version

DB types: mysql, postgres, sqlite, sqlserver, clickhouse, snowflake, doris,
starrocks, gbase, kingbase, dm, supabase, deltalake, file

## Global flags
--json (default) | --table | --skill | --version,-v | --help,-h
--api-key | --server | --console | --prefer-language | --default-output
Priority: --table > --json > config default-output > json

## Output (JSON default)
    {"success": true, "data": { ... }}
    {"success": false, "error": "message"}
Pipe to jq, e.g.: agent_infini task ls | jq '.items[].task_name'

## Errors
- Token expired: re-run agent_infini init or edit ~/.agent_infini/config.txt
- Server unreachable: check --server URL and network
- Task not found: use task ls
- No enabled resources: task context, then db enable / rag enable

Run `agent_infini skill` for the full specification.
'@
}

$aiTools = @(".cursor", ".codex", ".gemini", ".claude")
$distributed = 0
foreach ($tool in $aiTools) {
    $toolDir = Join-Path $HOME $tool
    if (Test-Path $toolDir) {
        $skillDir = Join-Path $toolDir "skills\$SkillName"
        New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
        $skillPath = Join-Path $skillDir "SKILL.md"
        Copy-Item $skillSrc $skillPath -Force
        Write-Ok "$tool  -> $skillPath"
        $distributed++
    }
}
if ($distributed -eq 0) {
    Write-Warn2 "No AI tool folders (.cursor/.codex/.gemini/.claude) found under $HOME; skipped Skill distribution."
}

Write-Host ""
Write-Step "Done. Next steps:"
Write-Host "    1) Open a new terminal (PATH was updated)."
Write-Host "    2) Run: agent_infini init --api-key `"your_api_key`""
Write-Host "    3) Run: agent_infini version"
