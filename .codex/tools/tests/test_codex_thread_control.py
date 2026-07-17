#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex_thread_control.py"
SPEC = importlib.util.spec_from_file_location("codex_thread_control", MODULE_PATH)
assert SPEC and SPEC.loader
thread_control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(thread_control)


class CodexExecutableDiscoveryTests(unittest.TestCase):
    def make_executable(self, root: Path, name: str) -> Path:
        path = root / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o700)
        return path

    def test_explicit_override_wins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            override = self.make_executable(root, "override-codex")
            bundle = self.make_executable(root, "bundle-codex")

            resolved = thread_control.resolve_codex_executable(
                env={"CRATE_CODEX_EXECUTABLE": str(override)},
                candidates=(bundle,),
                which=lambda _name: None,
            )

            self.assertEqual(resolved, override.resolve())

    def test_current_bundle_precedes_legacy_bundle_and_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = self.make_executable(root, "chatgpt-codex")
            legacy = self.make_executable(root, "legacy-codex")
            path_binary = self.make_executable(root, "path-codex")

            resolved = thread_control.resolve_codex_executable(
                env={},
                candidates=(current, legacy),
                which=lambda _name: str(path_binary),
            )

            self.assertEqual(resolved, current.resolve())

    def test_path_binary_is_used_when_bundles_are_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path_binary = self.make_executable(root, "path-codex")

            resolved = thread_control.resolve_codex_executable(
                env={},
                candidates=(root / "missing-chatgpt", root / "missing-codex"),
                which=lambda _name: str(path_binary),
            )

            self.assertEqual(resolved, path_binary.resolve())

    def test_relative_override_and_path_results_become_absolute(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            override = self.make_executable(root, "relative-override")
            path_binary = self.make_executable(root, "relative-path")
            previous_cwd = Path.cwd()
            os.chdir(root)
            try:
                override_result = thread_control.resolve_codex_executable(
                    env={"CRATE_CODEX_EXECUTABLE": override.name},
                    candidates=(),
                    which=lambda _name: None,
                )
                path_result = thread_control.resolve_codex_executable(
                    env={},
                    candidates=(),
                    which=lambda _name: path_binary.name,
                )
            finally:
                os.chdir(previous_cwd)

            self.assertEqual(override_result, override.resolve())
            self.assertEqual(path_result, path_binary.resolve())
            self.assertTrue(override_result.is_absolute())
            self.assertTrue(path_result.is_absolute())

    def test_invalid_explicit_override_fails_closed_without_echoing_path(self) -> None:
        private_path = "/private/example/does-not-exist/codex"

        with self.assertRaisesRegex(RuntimeError, "CRATE_CODEX_EXECUTABLE is not an executable file") as error:
            thread_control.resolve_codex_executable(
                env={"CRATE_CODEX_EXECUTABLE": private_path},
                candidates=(),
                which=lambda _name: None,
            )

        self.assertNotIn(private_path, str(error.exception))

    def test_missing_binary_reports_safe_remediation(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Set CRATE_CODEX_EXECUTABLE") as error:
            thread_control.resolve_codex_executable(
                env={},
                candidates=(),
                which=lambda _name: None,
            )

        self.assertNotIn(str(Path.home()), str(error.exception))

    def test_temp_server_start_uses_resolved_executable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = self.make_executable(Path(directory), "resolved-codex")
            server = thread_control.AppServer()
            process = mock.Mock()
            process.poll.return_value = None

            with (
                mock.patch.object(thread_control, "resolve_codex_executable", return_value=executable) as resolve,
                mock.patch.object(server, "_can_connect", return_value=True),
                mock.patch.object(thread_control.subprocess, "Popen", return_value=process) as popen,
            ):
                server._start_temp_server()

            resolve.assert_called_once_with()
            self.assertEqual(popen.call_args.args[0][0], str(executable))
            self.assertEqual(popen.call_args.args[0][1:3], ["app-server", "--listen"])

    def test_temp_server_launch_error_does_not_echo_executable_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = self.make_executable(root, "private-codex")
            server = thread_control.AppServer()
            launch_error = FileNotFoundError(2, "missing", str(executable))

            with (
                mock.patch.object(thread_control, "SOCKET_PATH", root / "control.sock"),
                mock.patch.object(thread_control, "resolve_codex_executable", return_value=executable),
                mock.patch.object(thread_control.subprocess, "Popen", side_effect=launch_error),
            ):
                with self.assertRaisesRegex(RuntimeError, "Unable to start the Codex app server") as error:
                    server._start_temp_server()

            self.assertNotIn(str(executable), str(error.exception))


if __name__ == "__main__":
    unittest.main()
