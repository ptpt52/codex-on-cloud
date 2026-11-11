"""Use direct Ubuntu archives on disposable GitHub-hosted runners only."""

import os
from pathlib import Path
import re


UBUNTU_URI = re.compile(
    r"(?<!\S)(?:mirror\+file:/+etc/apt/(?:apt|security)-mirrors\.txt"
    r"|https?://(?:azure\.archive|archive|security)\.ubuntu\.com/ubuntu)/?(?=\s|$)"
)
APT_CONFIG = """// CI only: bound transient failures and reject incomplete index updates.
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT::Update::Error-Mode "any";
"""


def direct_uri(match):
    host = "security" if "security" in match.group() else "archive"
    return "https://" + host + ".ubuntu.com/ubuntu"


def prepare_apt(apt_root):
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
                line, count = UBUNTU_URI.subn(direct_uri, line)
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
    prepare_apt(Path("/etc/apt"))
    print("Prepared direct Ubuntu HTTPS archives and bounded apt retries")
