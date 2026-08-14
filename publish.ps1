# ClipTube — one-shot publish: create GitHub repo, push, build Win+Mac installers via CI, download them.
# Prereq: run `gh auth login` once first.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

gh auth status
if (-not $?) { Write-Host "Run 'gh auth login' first."; exit 1 }

# Create the repo and push (skips creation if it already exists)
try {
    gh repo create cliptube --private --source . --push --description "Download exactly the part you need from any YouTube video" 2>$null
} catch {}
git push -u origin main

# Tag v1.0.0 → triggers the CI build for Windows + macOS
git tag -f v1.0.0
git push -f origin v1.0.0

Write-Host "Waiting for CI to pick up the tag..."
Start-Sleep 20
$runId = gh run list --workflow build.yml --limit 1 --json databaseId -q ".[0].databaseId"
Write-Host "Watching run $runId (Win + Mac builds take ~5-10 min)..."
gh run watch $runId --exit-status

New-Item -ItemType Directory -Force dist\release | Out-Null
gh run download $runId -D dist\release
Write-Host "`nInstallers downloaded:"
Get-ChildItem dist\release -Recurse -File | Select-Object FullName, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
