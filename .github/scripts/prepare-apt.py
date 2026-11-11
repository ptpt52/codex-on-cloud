"""Use direct Ubuntu archives on disposable GitHub-hosted runners only."""

import os
from pathlib import Path
import re
import subprocess
import json


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
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
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


def prepare_apt(apt_root, archive=ARCHIVES[0], lists_root=None):
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
    # Install commands must not switch back to the runner's mirror transport,
    # or lose the freshly downloaded indexes to an image cleanup hook.
    source = apt_root / "codex-ci.sources"
    parts = apt_root / "codex-ci-sources.list.d"
    parts.mkdir(exist_ok=True)
    lists_root = lists_root or apt_root / "codex-ci-lists"
    (lists_root / "partial").mkdir(parents=True, exist_ok=True)
    source.write_text(
        "Types: deb\nURIs: " + archive + "\n"
        "Suites: noble noble-updates noble-backports noble-security\n"
        "Components: main restricted universe multiverse\nArchitectures: amd64\n"
        "Signed-By: " + KEYRING + "\n"
    )
    configured = APT_CONFIG + "".join(
        key + " " + json.dumps(str(path)) + ";\n" for key, path in (
            ("Dir::Etc::sourcelist", source), ("Dir::Etc::sourceparts", parts),
            ("Dir::State::lists", lists_root),
        )
    )
    (apt_root / "apt.conf.d" / "99-codex-ci-network").write_text(configured)


def verify_effective_sources(archive):
    result = subprocess.run(["apt-get", "--print-uris", "update"], capture_output=True, text=True, check=True, timeout=15)
    urls = re.findall(r"'([^']+)'", result.stdout)
    if len(result.stdout) > 65536 or not urls or any(not url.startswith(archive + "/dists/") for url in urls):
        raise RuntimeError("Effective apt sources differ from the verified CI archive")


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("This script only configures disposable GitHub Actions runners")
    release = Path("/etc/os-release").read_text().splitlines()
    if "ID=ubuntu" not in release or 'VERSION_ID="24.04"' not in release:
        raise SystemExit("Expected the pinned Ubuntu 24.04 runner")
    archive = choose_archive()
    prepare_apt(Path("/etc/apt"), archive, Path("/var/lib/apt/codex-ci-lists"))
    verify_effective_sources(archive)
    print("Prepared verified Ubuntu HTTPS archive and bounded apt retries: " + archive)
