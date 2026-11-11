"""Use direct Ubuntu archives on disposable GitHub-hosted runners only."""

import os
from pathlib import Path
import re
import subprocess


ARCHIVES = (
    "https://archive.ubuntu.com/ubuntu",
    "https://mirrors.edge.kernel.org/ubuntu",
    "https://mirrors.mit.edu/ubuntu",
)
KEYRING = "/usr/share/keyrings/ubuntu-archive-keyring.gpg"


UBUNTU_URI = re.compile(
    r"(?<!\S)(?:mirror\+file:/+etc/apt/(?:apt|security)-mirrors\.txt"
    r"|https?://(?:azure\.archive|archive|security)\.ubuntu\.com/ubuntu"
    r"|https://mirrors\.(?:edge\.kernel\.org|mit\.edu)/ubuntu)/?(?=\s|$)"
)
APT_CONFIG = """// CI only: bound transient failures and reject incomplete index updates.
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT::Update::Error-Mode "any";
"""


def archive_available(archive):
    try:
        downloaded = subprocess.run([
            "curl", "--proto", "=https", "--proto-redir", "=https", "--fail",
            "--silent", "--show-error", "--location", "--connect-timeout", "8",
            "--max-time", "45", "--max-filesize", "1048576",
            archive + "/dists/noble/InRelease",
        ], capture_output=True, check=True, timeout=50)
        if not 0 < len(downloaded.stdout) <= 1048576:
            return False
        subprocess.run(
            ["gpgv", "--keyring", KEYRING, "-"], input=downloaded.stdout,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def choose_archive(probe=archive_available):
    for archive in ARCHIVES:
        if probe(archive):
            return archive
        print("Archive unreachable or Ubuntu signature verification failed: " + archive, flush=True)
    raise RuntimeError("No reachable Ubuntu archive with a valid Ubuntu signature")


def prepare_apt(apt_root, archive=ARCHIVES[0]):
    if archive not in ARCHIVES:
        raise ValueError("Unsupported CI archive")
    sources = [apt_root / "sources.list"]
    for pattern in ("*.list", "*.sources"):
        sources.extend(sorted((apt_root / "sources.list.d").glob(pattern)))
    updates = []
    found = False
    for path in sources:
        if not path.is_file():
            continue
        original = path.read_text()
        lines = []
        for line in original.splitlines(keepends=True):
            if not line.lstrip().startswith("#"):
                line, count = UBUNTU_URI.subn(lambda match: archive, line)
                found |= count > 0
            lines.append(line)
        updated = "".join(lines)
        if updated != original:
            updates.append((path, updated))
    if not found:
        raise RuntimeError("No supported Ubuntu apt sources found; refusing to continue")
    for path, updated in updates:
        path.write_text(updated)
    (apt_root / "apt.conf.d" / "99-codex-ci-network").write_text(APT_CONFIG)


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("This script only configures disposable GitHub Actions runners")
    release = Path("/etc/os-release").read_text().splitlines()
    if "ID=ubuntu" not in release or 'VERSION_ID="24.04"' not in release:
        raise SystemExit("Expected the pinned Ubuntu 24.04 runner")
    archive = choose_archive()
    prepare_apt(Path("/etc/apt"), archive)
    print("Prepared verified Ubuntu HTTPS archive and bounded apt retries: " + archive)
