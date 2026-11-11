import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


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
            "mirror+file:///etc/apt/security-mirrors.txt", "https://archive.ubuntu.com/ubuntu"
        )
        self.assertEqual(source.read_text(), expected)
        CI_APT.prepare_apt(self.root)
        self.assertEqual(source.read_text(), expected)
        self.assertTrue((self.root / "apt.conf.d/99-codex-ci-network").read_text().startswith(CI_APT.APT_CONFIG))

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
        ).replace("http://security.ubuntu.com/ubuntu", "https://archive.ubuntu.com/ubuntu").replace(
            "deb http://archive.ubuntu.com/ubuntu", "deb https://archive.ubuntu.com/ubuntu"
        ))
        self.assertEqual(vendor.read_text(), vendor_text)

    def test_dns_failure_uses_an_independent_verified_mirror_and_is_idempotent(self):
        probes = []
        def probe(archive):
            probes.append(archive)
            return archive == CI_APT.ARCHIVES[1]
        archive = CI_APT.choose_archive(probe)
        self.assertEqual(probes, list(CI_APT.ARCHIVES[:2]))
        source = self.root / "sources.list.d/ubuntu.sources"
        original = "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-security\nComponents: main\n"
        source.write_text(original)
        CI_APT.prepare_apt(self.root, archive)
        self.assertEqual(source.read_text(), original.replace("mirror+file:/etc/apt/apt-mirrors.txt", archive))
        CI_APT.prepare_apt(self.root, archive)
        self.assertEqual(source.read_text(), original.replace("mirror+file:/etc/apt/apt-mirrors.txt", archive))
        with self.assertRaisesRegex(RuntimeError, "No reachable Ubuntu archive"):
            CI_APT.choose_archive(lambda archive: False)

    def test_archive_probe_requires_a_bounded_download_and_valid_ubuntu_signature(self):
        downloaded = subprocess.CompletedProcess([], 0, stdout=b"signed-index")
        verified = subprocess.CompletedProcess([], 0)
        with patch.object(CI_APT.subprocess, "run", side_effect=[downloaded, verified]) as run:
            self.assertTrue(CI_APT.archive_available(CI_APT.ARCHIVES[1]))
            self.assertIn("--max-filesize", run.call_args_list[0].args[0])
            self.assertEqual(run.call_args_list[1].args[0], ["gpgv", "--keyring", CI_APT.KEYRING, "-"])
        with patch.object(CI_APT.subprocess, "run", side_effect=[downloaded, subprocess.CalledProcessError(1, "gpgv")]):
            self.assertFalse(CI_APT.archive_available(CI_APT.ARCHIVES[1]))
        with patch.object(CI_APT.subprocess, "run", side_effect=subprocess.TimeoutExpired("curl", 50)):
            self.assertFalse(CI_APT.archive_available(CI_APT.ARCHIVES[1]))

    def test_effective_apt_sources_and_indexes_remain_pinned_if_runner_sources_change(self):
        source = self.root / "sources.list"
        original = "deb mirror+file:/etc/apt/apt-mirrors.txt noble main\n"
        source.write_text(original)
        archive = CI_APT.ARCHIVES[1]
        CI_APT.prepare_apt(self.root, archive)
        # Reproduce a source reset between prepare and Playwright's apt calls.
        source.write_text(original)
        config = str(self.root / "apt.conf.d/99-codex-ci-network")
        result = subprocess.run(["apt-get", "-c", config, "--print-uris", "update"], check=True, capture_output=True, text=True, timeout=10)
        self.assertIn(archive + "/dists/noble/InRelease", result.stdout)
        self.assertIn(archive + "/dists/noble-security/InRelease", result.stdout)
        self.assertNotIn("mirror+file", result.stdout)
        self.assertNotIn("azure.archive", result.stdout)
        dumped = subprocess.run(["apt-config", "-c", config, "dump"], check=True, capture_output=True, text=True, timeout=10).stdout
        self.assertIn(str(self.root / "codex-ci-lists"), dumped)
        generated = (self.root / "codex-ci.sources").read_text()
        self.assertIn("Components: main restricted universe multiverse", generated)
        self.assertIn("Signed-By: " + CI_APT.KEYRING, generated)

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
