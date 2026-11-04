import io
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import zipfile
from scripts.forward_package import LAUNCHER, package_bytes, validate_macho, CPUS


def binary(arch):
    commands = struct.pack("<6I", 0x32, 24, 1, 12 << 16, 12 << 16, 0)
    if arch == "darwin-arm64":
        commands += struct.pack("<4I", 0x1D, 16, 32 + 24 + 16, 12)
    header = struct.pack("<8I", 0xFEEDFACF, CPUS[arch], 0, 2, 2 if arch == "darwin-arm64" else 1, len(commands), 0, 0)
    return header + commands + struct.pack(">3I", 0xFADE0CC0, 12, 0)


class ForwardPackageTests(unittest.TestCase):
    def test_zip_preserves_fixed_entries_modes_and_exact_helper(self):
        for arch in CPUS:
            data = binary(arch)
            with zipfile.ZipFile(io.BytesIO(package_bytes(data, arch))) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(len(archive.infolist()), 3)
                root = "codex-cloud-forward-macos-" + arch.split("-")[1] + "/"
                for name, mode in [("codex-cloud-forward", 0o755), ("Start.command", 0o755), ("README.txt", 0o644)]:
                    entry = archive.getinfo(root + name)
                    self.assertEqual(entry.create_system, 3)
                    self.assertEqual((entry.external_attr >> 16) & 0o777, mode)
                self.assertEqual(archive.read(root + "codex-cloud-forward"), data)
                self.assertEqual(archive.read(root + "Start.command"), LAUNCHER)
                self.assertIn("macOS 12", archive.read(root + "README.txt").decode())
            self.assertEqual(package_bytes(data, arch), package_bytes(data, arch))

    def test_macho_rejects_wrong_architecture_truncation_and_missing_signature(self):
        data = binary("darwin-arm64")
        for invalid in [b"", data[:31], data[:45], data[:-1], b"MZ" + data[2:]]:
            with self.assertRaises(ValueError):
                validate_macho(invalid, "darwin-arm64")
        with self.assertRaises(ValueError):
            validate_macho(data, "darwin-amd64")
        without_signature = bytearray(binary("darwin-amd64"))
        struct.pack_into("<I", without_signature, 4, CPUS["darwin-arm64"])
        with self.assertRaises(ValueError):
            validate_macho(without_signature, "darwin-arm64")

    def test_launcher_preserves_spaces_unicode_and_literal_arguments(self):
        with tempfile.TemporaryDirectory(prefix="codex Mac $() 中文 ") as directory:
            launcher = Path(directory, "Start.command")
            helper = Path(directory, "codex-cloud-forward")
            launcher.write_bytes(LAUNCHER)
            helper.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            launcher.chmod(0o755)
            helper.chmod(0o755)
            args = ["--version", "literal; $(false)", "中文 空格"]
            result = subprocess.run([str(launcher), *args], check=True, text=True, capture_output=True, timeout=5)
            self.assertEqual(result.stdout.splitlines(), args)


if __name__ == "__main__":
    unittest.main()
