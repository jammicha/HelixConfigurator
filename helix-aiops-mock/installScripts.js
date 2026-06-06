// helix-aiops-mock/installScripts.js
// Render the platform install one-liners. They detect the platform, download
// the matching pre-built zip from GitHub Releases (static latest/download URL),
// write the templated .env, and launch — no Docker required.
const sanitize = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-');
const base = (repo) => `https://github.com/${repo}/releases/latest/download`;

function renderBashInstaller({ session, repo }) {
  const x = sanitize(session.xSource);
  return `#!/usr/bin/env bash
set -e
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac
PLATFORM="$OS-$ARCH"
TARGET="$(pwd)/helix-configurator-${x}"
echo "Installing Helix Configurator ($PLATFORM) into $TARGET"
mkdir -p "$TARGET" && cd "$TARGET"
curl -fsSL "${base(repo)}/helix-configurator-$PLATFORM.zip" -o pkg.zip
unzip -oq pkg.zip && rm pkg.zip
cd helix-configurator
# Write templated config only on first install (preserve real creds on re-run).
if [ ! -s .env ] || grep -q 'placeholder' .env 2>/dev/null; then
cat > .env <<'ENVEOF'
HELIX_ENDPOINT=${session.endpoint}
HELIX_API_KEY=${session.apiKey}
X_SOURCE=${x}
BUSINESS_SERVICE_KEY=
PORT=8765
ENVEOF
fi
chmod +x ./node ./start.sh ./start.command 2>/dev/null || true
[ "$(uname)" = "Darwin" ] && ./start.command || ./start.sh
`;
}

function renderPowerShellInstaller({ session, repo }) {
  const x = sanitize(session.xSource);
  const platform = 'windows-amd64';
  return `$ErrorActionPreference='Stop'
$Platform='${platform}'
$Target=Join-Path $PWD.Path "helix-configurator-${x}"
Write-Host "Installing Helix Configurator ($Platform) into $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null; Set-Location $Target
Invoke-WebRequest -UseBasicParsing -Uri "${base(repo)}/helix-configurator-${platform}.zip" -OutFile pkg.zip
Expand-Archive -Force -Path pkg.zip -DestinationPath .; Remove-Item pkg.zip
Set-Location helix-configurator
if (-not (Test-Path .env) -or (Select-String -Path .env -Pattern 'placeholder' -Quiet)) {
@'
HELIX_ENDPOINT=${session.endpoint}
HELIX_API_KEY=${session.apiKey}
X_SOURCE=${x}
BUSINESS_SERVICE_KEY=
PORT=8765
'@ | Set-Content .env
}
.\\start.bat
`;
}
module.exports = { renderBashInstaller, renderPowerShellInstaller };
