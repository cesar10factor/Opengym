# Watches origin/main; when it moves, rebuilds and redeploys the local docker compose
# stack from it. Meant to be run every few minutes from Windows Task Scheduler (see
# docs/DESPLIEGUE.md for how it's registered).
#
# Safety rules, in order:
#  - Never touches anything if origin/main hasn't moved since the last successful deploy
#    (tracked in .git/auto-deploy/last-sha — outside the working tree, so it can never be
#    committed and never collides with anything git itself manages).
#  - Never checks out main over uncommitted work. A dirty tree just means "skip this run,
#    try again next time" — whatever you're in the middle of always wins.
#  - Only ever fast-forwards (git merge --ff-only). If main and the local ref have
#    diverged, that is a merge conflict growing somewhere and no script should silently
#    paper over it — it stops and logs instead.
#  - Restores whatever branch was checked out before the deploy, so this never leaves the
#    working directory sitting on main when you were actually working on something else.
#
# Deliberately does NOT redirect native commands' stderr (no 2>&1 / *>): under Windows
# PowerShell 5.1 that wraps every stderr line (git and docker both narrate routine
# progress on stderr) as a NativeCommandError, which is noisy and, combined with 'Stop',
# turns a successful `git fetch` into a thrown exception. $LASTEXITCODE is checked
# explicitly after every native call instead.

$repo = 'C:\Users\cesar\Escritorio\Opengym'
$stateDir = Join-Path $repo '.git\auto-deploy'
$logFile = Join-Path $stateDir 'deploy.log'
$shaFile = Join-Path $stateDir 'last-sha'
$lockFile = Join-Path $stateDir 'lock'
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
if ($env:Path -notlike "*$dockerBin*") { $env:Path = "$dockerBin;$env:Path" }

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

# A build can run past a single 5-minute tick; a stale lock (left behind by a crash)
# should not wedge every future run, so it expires rather than blocking forever.
if (Test-Path $lockFile) {
  $age = (Get-Date) - (Get-Item $lockFile).LastWriteTime
  if ($age.TotalMinutes -lt 30) {
    Log "lock held (age $([int]$age.TotalMinutes) min) - a run may still be building, skipping"
    exit 0
  }
  Log "stale lock (age $([int]$age.TotalMinutes) min) - clearing it and continuing"
}
New-Item -ItemType File -Path $lockFile -Force | Out-Null

try {
  Set-Location $repo

  git fetch origin main
  if ($LASTEXITCODE -ne 0) { Log "git fetch origin main failed (exit $LASTEXITCODE)"; exit 1 }

  $remoteSha = (git rev-parse origin/main).Trim()
  $lastDeployed = if (Test-Path $shaFile) { (Get-Content $shaFile -Raw).Trim() } else { '' }
  if ($remoteSha -eq $lastDeployed) { exit 0 }   # nothing new - stay quiet, no log spam

  $dirty = git status --porcelain
  if ($dirty) {
    Log "origin/main moved to $remoteSha but the working tree is dirty - skipping, will retry next run"
    exit 0
  }

  $originalBranch = (git rev-parse --abbrev-ref HEAD).Trim()
  Log "origin/main -> $remoteSha (currently on $originalBranch) - deploying"

  git checkout main
  if ($LASTEXITCODE -ne 0) { Log "git checkout main failed"; exit 1 }

  git merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) {
    Log "FAST-FORWARD FAILED - local main has diverged from origin/main, needs a human"
    git checkout $originalBranch
    exit 1
  }

  docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
  $buildOk = $LASTEXITCODE -eq 0

  if ($originalBranch -ne 'main') {
    git checkout $originalBranch
  }

  if ($buildOk) {
    Set-Content -Path $shaFile -Value $remoteSha -NoNewline
    Log "deploy OK - now serving $remoteSha"
  } else {
    Log "docker compose build/up FAILED (exit $LASTEXITCODE) - still serving the previous build"
  }
}
finally {
  Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
