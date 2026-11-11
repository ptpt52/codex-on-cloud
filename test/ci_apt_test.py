import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / ".github/scripts/prepare-apt.py"
SPEC = importlib.util.spec_from_file_location("ci_apt", SCRIPT)
CI_APT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI_APT)


class CiAptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="codex-ci-apt-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "sources.list.d").mkdir()
        (self.root / "apt.conf.d").mkdir()

    def test_deb822_mirror_transport_is_replaced_without_changing_suites_or_keys(self):
        source = self.root / "sources.list.d/ubuntu.sources"
        original = (
            "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\n"
            "Suites: noble noble-updates noble-backports noble-security\n"
            "Components: main restricted universe multiverse\n"
            "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
            "\nTypes: deb\nURIs: mirror+file:///etc/apt/security-mirrors.txt\n"
            "Suites: noble-security\nComponents: main\n"
        )
        source.write_text(original)
        CI_APT.prepare_apt(self.root)
        expected = original.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu").replace(
            "mirror+file:///etc/apt/security-mirrors.txt", "https://security.ubuntu.com/ubuntu"
        )
        self.assertEqual(source.read_text(), expected)
        CI_APT.prepare_apt(self.root)
        self.assertEqual(source.read_text(), expected)
        self.assertEqual((self.root / "apt.conf.d/99-codex-ci-network").read_text(), CI_APT.APT_CONFIG)

    def test_legacy_azure_and_http_sources_keep_options_and_third_party_repositories(self):
        source = self.root / "sources.list"
        original = (
            "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] "
            "http://azure.archive.ubuntu.com/ubuntu/ noble main universe\n"
            "deb http://security.ubuntu.com/ubuntu noble-security main\n"
            "deb http://archive.ubuntu.com/ubuntu noble-updates main\n"
            "# deb http://azure.archive.ubuntu.com/ubuntu noble main\n"
        )
        source.write_text(original)
        vendor = self.root / "sources.list.d/vendor.list"
        vendor_text = "deb https://packages.microsoft.com/repos/azure-cli/ noble main\n"
        vendor.write_text(vendor_text)
        CI_APT.prepare_apt(self.root)
        self.assertEqual(source.read_text(), original.replace(
            "http://azure.archive.ubuntu.com/ubuntu/", "https://archive.ubuntu.com/ubuntu", 1
        ).replace("http://security.ubuntu.com/ubuntu", "https://security.ubuntu.com/ubuntu").replace(
            "deb http://archive.ubuntu.com/ubuntu", "deb https://archive.ubuntu.com/ubuntu"
        ))
        self.assertEqual(vendor.read_text(), vendor_text)

    def test_unknown_sources_fail_before_writing_network_configuration(self):
        source = self.root / "sources.list"
        original = "deb https://example.invalid/ubuntu noble main\n"
        source.write_text(original)
        with self.assertRaisesRegex(RuntimeError, "No supported Ubuntu"):
            CI_APT.prepare_apt(self.root)
        self.assertEqual(source.read_text(), original)
        self.assertFalse((self.root / "apt.conf.d/99-codex-ci-network").exists())

    def test_command_refuses_non_ci_hosts_before_touching_apt(self):
        result = subprocess.run(
            ["python3", str(SCRIPT)], env={**os.environ, "GITHUB_ACTIONS": "false"},
            capture_output=True, text=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("only configures disposable GitHub Actions", result.stderr)


if __name__ == "__main__":
    unittest.main()
