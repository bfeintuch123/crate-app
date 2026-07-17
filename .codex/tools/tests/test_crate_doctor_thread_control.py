import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


DOCTOR_PATH = Path(__file__).resolve().parents[1] / "crate_doctor.py"
SPEC = importlib.util.spec_from_file_location("crate_doctor", DOCTOR_PATH)
assert SPEC and SPEC.loader
crate_doctor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = crate_doctor
SPEC.loader.exec_module(crate_doctor)


def write_plugin(root: Path, version: str = "0.11.1") -> None:
    (root / ".codex-plugin").mkdir(parents=True)
    (root / "mcp").mkdir()
    (root / ".codex-plugin" / "plugin.json").write_text(
        json.dumps({"name": "crate-ops", "version": version, "mcpServers": "./.mcp.json"}),
        encoding="utf-8",
    )
    (root / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "crate-thread-control": {
                        "cwd": ".",
                        "command": "python3",
                        "args": ["./mcp/crate_thread_control_server.py"],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    (root / "mcp" / "crate_thread_control_server.py").write_text("# server\n", encoding="utf-8")
    (root / "mcp" / "codex_thread_control.py").write_text("# bridge\n", encoding="utf-8")


class CrateDoctorThreadControlTests(unittest.TestCase):
    def test_coherent_source_plugin_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "crate-ops"
            write_plugin(root)
            self.assertTrue(crate_doctor.coherent_crate_ops_plugin(root))

    def test_symlinked_bridge_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "crate-ops"
            write_plugin(root)
            bridge = root / "mcp" / "codex_thread_control.py"
            target = root / "bridge-target.py"
            target.write_text("# target\n", encoding="utf-8")
            bridge.unlink()
            bridge.symlink_to(target)
            self.assertFalse(crate_doctor.coherent_crate_ops_plugin(root))

    def test_symlinked_mcp_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "crate-ops"
            write_plugin(root)
            real_mcp = base / "real-mcp"
            (root / "mcp").rename(real_mcp)
            (root / "mcp").symlink_to(real_mcp, target_is_directory=True)
            self.assertFalse(crate_doctor.coherent_crate_ops_plugin(root))

    def test_cache_manifest_must_match_version_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory) / "crate-ops"
            candidate = cache_root / "0.11.1"
            write_plugin(candidate, version="0.11.0")
            self.assertFalse(crate_doctor.coherent_installed_crate_ops_plugin(cache_root))

    def test_source_manifest_requires_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "crate-ops"
            write_plugin(root)
            (root / ".codex-plugin" / "plugin.json").write_text(
                json.dumps({"name": "crate-ops", "mcpServers": "./.mcp.json"}),
                encoding="utf-8",
            )
            self.assertFalse(crate_doctor.coherent_crate_ops_plugin(root))

    def test_non_object_manifest_is_rejected_without_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "crate-ops"
            write_plugin(root)
            (root / ".codex-plugin" / "plugin.json").write_text("[]", encoding="utf-8")
            self.assertFalse(crate_doctor.coherent_crate_ops_plugin(root))

    def test_non_object_mcp_server_map_is_rejected_without_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "crate-ops"
            write_plugin(root)
            (root / ".mcp.json").write_text(json.dumps({"mcpServers": []}), encoding="utf-8")
            self.assertFalse(crate_doctor.coherent_crate_ops_plugin(root))

    def test_legacy_cache_without_bundled_bridge_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory) / "crate-ops"
            candidate = cache_root / "0.11.1"
            write_plugin(candidate)
            (candidate / "mcp" / "codex_thread_control.py").unlink()
            self.assertFalse(crate_doctor.coherent_installed_crate_ops_plugin(cache_root))


if __name__ == "__main__":
    unittest.main()
