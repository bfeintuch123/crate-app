#!/usr/bin/env python3
"""Crate local readiness doctor.

Read-only preflight for Crate ops loops. The doctor reports whether the local
machine is ready for repo work, release-gate checks, Cloudflare deploys, and
thread-control workflows without printing secret values.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(os.environ.get("CRATE_REPO", "/Users/bryantfeintuchclaw/Projects")).expanduser().resolve()
EXPECTED_REMOTE = "bfeintuch123/crate-app"
EXPECTED_BRANCH = "v2.4.x"
KEYCHAIN_SERVICE = "crate-cloudflare-api-token"
CRATE_OPS_SOURCE_ROOT = Path.home() / "plugins" / "crate-ops"
CRATE_OPS_CACHE_ROOT = Path.home() / ".codex" / "plugins" / "cache" / "personal" / "crate-ops"
MIB = 1024 * 1024


@dataclass
class Check:
    name: str
    status: str
    detail: str


def run(args: list[str], cwd: Path = ROOT, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def ok(name: str, detail: str) -> Check:
    return Check(name, "pass", detail)


def warn(name: str, detail: str) -> Check:
    return Check(name, "warn", detail)


def fail(name: str, detail: str) -> Check:
    return Check(name, "fail", detail)


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def is_regular_file_without_plugin_symlinks(path: Path, plugin_root: Path) -> bool:
    """Return true only for regular files reached without plugin-local symlinks."""
    try:
        relative = path.relative_to(plugin_root)
    except ValueError:
        return False

    current = plugin_root
    if current.is_symlink() or not current.is_dir():
        return False
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return False
    return current.is_file()


def coherent_crate_ops_plugin(plugin_root: Path, expected_version: str | None = None) -> bool:
    """Validate the minimum self-contained Crate Ops thread-control contract."""
    manifest_path = plugin_root / ".codex-plugin" / "plugin.json"
    mcp_config_path = plugin_root / ".mcp.json"
    server_path = plugin_root / "mcp" / "crate_thread_control_server.py"
    bridge_path = plugin_root / "mcp" / "codex_thread_control.py"
    required_files = (manifest_path, mcp_config_path, server_path, bridge_path)
    if not all(is_regular_file_without_plugin_symlinks(path, plugin_root) for path in required_files):
        return False

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        mcp_config = json.loads(mcp_config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False

    if not isinstance(manifest, dict) or not isinstance(mcp_config, dict):
        return False
    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        return False
    if manifest.get("name") != "crate-ops" or manifest.get("mcpServers") != "./.mcp.json":
        return False
    if expected_version is not None and version != expected_version:
        return False

    servers = mcp_config.get("mcpServers")
    if not isinstance(servers, dict):
        return False
    server = servers.get("crate-thread-control")
    if not isinstance(server, dict):
        return False
    return (
        server.get("cwd") == "."
        and server.get("command") == "python3"
        and server.get("args") == ["./mcp/crate_thread_control_server.py"]
    )


def coherent_installed_crate_ops_plugin(cache_root: Path) -> bool:
    if cache_root.is_symlink() or not cache_root.is_dir():
        return False
    try:
        candidates = tuple(cache_root.iterdir())
    except OSError:
        return False
    return any(
        candidate.is_dir()
        and not candidate.is_symlink()
        and coherent_crate_ops_plugin(candidate, expected_version=candidate.name)
        for candidate in candidates
    )


def human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < MIB:
        return f"{size / 1024:.1f} KiB"
    return f"{size / MIB:.1f} MiB"


def directory_summary(path: Path) -> tuple[int, int, int]:
    """Return aggregate file count and bytes without exposing private names."""
    count = 0
    size = 0
    errors = 0
    if not path.exists():
        return count, size, errors

    def onerror(_error: OSError) -> None:
        nonlocal errors
        errors += 1

    for current, directories, files in os.walk(path, followlinks=False, onerror=onerror):
        directories[:] = [name for name in directories if not (Path(current) / name).is_symlink()]
        for name in files:
            candidate = Path(current) / name
            try:
                if candidate.is_symlink():
                    continue
                size += candidate.stat().st_size
                count += 1
            except OSError:
                errors += 1
    return count, size, errors


def check_repo() -> list[Check]:
    checks: list[Check] = []
    if not ROOT.exists():
        return [fail("repo.path", f"missing {ROOT}")]

    top = run(["git", "rev-parse", "--show-toplevel"])
    if top.returncode != 0:
        return [fail("repo.identity", "not a git repo")]
    checks.append(ok("repo.path", top.stdout.strip()))

    remote = run(["git", "remote", "get-url", "origin"])
    remote_url = remote.stdout.strip()
    if EXPECTED_REMOTE in remote_url:
        checks.append(ok("repo.remote", "origin matches crate-app"))
    else:
        checks.append(fail("repo.remote", f"origin is {remote_url or 'unknown'}"))

    branch = run(["git", "branch", "--show-current"]).stdout.strip()
    if branch == EXPECTED_BRANCH:
        checks.append(ok("repo.branch", branch))
    else:
        checks.append(warn("repo.branch", f"current branch is {branch or 'detached'}"))

    status = run(["git", "status", "--short", "--branch"]).stdout.strip().splitlines()
    dirty_count = max(len(status) - 1, 0)
    if dirty_count:
        checks.append(warn("repo.working_tree", f"{dirty_count} changed entries"))
    else:
        checks.append(ok("repo.working_tree", "clean"))

    package_json = ROOT / "package.json"
    if package_json.exists():
        try:
            version = json.loads(package_json.read_text(encoding="utf-8")).get("version")
            checks.append(ok("repo.package_version", str(version)))
        except (json.JSONDecodeError, OSError) as exc:
            checks.append(fail("repo.package_version", str(exc)))
    else:
        checks.append(fail("repo.package_version", "package.json missing"))

    return checks


def check_tools() -> list[Check]:
    checks: list[Check] = []
    for tool in ["node", "npm", "npx", "git", "gh", "security"]:
        if command_exists(tool):
            checks.append(ok(f"tool.{tool}", "available"))
        else:
            checks.append(fail(f"tool.{tool}", "missing from PATH"))

    for tool in ["xcrun", "codesign"]:
        if command_exists(tool):
            checks.append(ok(f"tool.{tool}", "available"))
        else:
            checks.append(warn(f"tool.{tool}", "missing; release signing/notary gates cannot run here"))

    if coherent_crate_ops_plugin(CRATE_OPS_SOURCE_ROOT) or coherent_installed_crate_ops_plugin(CRATE_OPS_CACHE_ROOT):
        checks.append(ok("tool.thread_control", "coherent self-contained Crate Ops thread bridge present"))
    else:
        checks.append(warn("tool.thread_control", "coherent self-contained Crate Ops thread bridge missing"))

    return checks


def check_auth() -> list[Check]:
    checks: list[Check] = []

    if command_exists("gh"):
        gh = run(["gh", "auth", "status"], timeout=15)
        if gh.returncode == 0:
            checks.append(ok("auth.github", "gh auth available"))
        else:
            checks.append(warn("auth.github", "gh auth not ready or not accessible"))

    if command_exists("security"):
        token = run(
            [
                "security",
                "find-generic-password",
                "-a",
                os.environ.get("USER", ""),
                "-s",
                KEYCHAIN_SERVICE,
            ],
            timeout=15,
        )
        if token.returncode == 0:
            checks.append(ok("auth.cloudflare_keychain", "token exists in Keychain"))
        else:
            checks.append(warn("auth.cloudflare_keychain", "token not found in Keychain"))

    return checks


def check_hygiene() -> list[Check]:
    checks: list[Check] = []
    thresholds = {
        "research": (ROOT / ".codex" / "research", 25 * MIB),
        "outputs": (ROOT / "outputs", 500 * MIB),
        "proof_bundles": (ROOT / ".codex" / "proof-bundles", 50 * MIB),
        "codex_logs": (Path.home() / ".codex" / "logs", 500 * MIB),
        "codex_worktrees": (Path.home() / ".codex" / "worktrees", 2 * 1024 * MIB),
    }
    for label, (path, threshold) in thresholds.items():
        count, size, errors = directory_summary(path)
        detail = f"{count} files, {human_size(size)}"
        if errors:
            checks.append(warn(f"hygiene.{label}", f"{detail}; {errors} unreadable entries, result incomplete"))
        elif size > threshold:
            checks.append(warn(f"hygiene.{label}", f"{detail}; review before cleanup"))
        else:
            checks.append(ok(f"hygiene.{label}", detail))

    worktrees = run(["git", "worktree", "list", "--porcelain"])
    worktree_count = sum(1 for line in worktrees.stdout.splitlines() if line.startswith("worktree "))
    if worktree_count > 12:
        checks.append(warn("hygiene.worktrees", f"{worktree_count} registered worktrees; review stale entries"))
    else:
        checks.append(ok("hygiene.worktrees", f"{worktree_count} registered worktrees"))

    temp_count = 0
    temp_size = 0
    for candidate in Path("/private/tmp").glob("crate-*"):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        count, size, errors = directory_summary(candidate)
        temp_count += 1
        temp_size += size
        if errors:
            checks.append(warn("hygiene.temp_workspaces_access", "one or more temporary workspace entries were unreadable"))
    temp_detail = f"{temp_count} directories, {human_size(temp_size)} aggregate"
    if temp_count > 20 or temp_size > 2 * 1024 * MIB:
        checks.append(warn("hygiene.temp_workspaces", f"{temp_detail}; review before cleanup"))
    else:
        checks.append(ok("hygiene.temp_workspaces", temp_detail))

    include = ROOT / ".worktreeinclude"
    if not include.exists():
        checks.append(warn("hygiene.worktreeinclude", "missing explicit managed-worktree policy"))
    else:
        entries = [
            line.strip()
            for line in include.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        sensitive_terms = (
            ".env",
            "secret",
            "token",
            "credential",
            "diagnostic",
            "research",
            "tester",
            "package",
            "signing",
            "certificate",
            "provision",
            "private",
            ".pem",
            ".p12",
            ".key",
            ".npmrc",
            ".mobileprovision",
        )
        sensitive = [entry for entry in entries if any(word in entry.lower() for word in sensitive_terms)]
        if sensitive:
            checks.append(fail("hygiene.worktreeinclude", "contains a sensitive-file pattern"))
        else:
            checks.append(ok("hygiene.worktreeinclude", f"{len(entries)} approved ignored-file patterns; no sensitive patterns"))
    return checks


def check_automation_registry() -> list[Check]:
    path = ROOT / ".codex" / "ops" / "crate-automations.json"
    if not path.is_file():
        return [warn("automation.registry", "privacy-safe automation registry is missing")]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return [fail("automation.registry", "automation registry is unreadable or invalid JSON")]
    entries = payload.get("automations")
    if not isinstance(entries, list):
        return [fail("automation.registry", "automations must be a JSON array")]
    status = payload.get("inventory_status", "unknown")
    detail = f"{len(entries)} registered automations; status={status}"
    return [warn("automation.registry", f"{detail}; repo metadata cannot prove live state, verify through the automation tool")]


def main() -> int:
    checks = check_repo() + check_tools() + check_auth() + check_hygiene() + check_automation_registry()
    failures = [check for check in checks if check.status == "fail"]
    warnings = [check for check in checks if check.status == "warn"]

    print("# Crate Doctor")
    print()
    for check in checks:
        marker = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[check.status]
        print(f"- {marker} {check.name}: {check.detail}")
    print()
    print(f"Summary: {len(failures)} failed, {len(warnings)} warnings, {len(checks)} checks.")

    if failures:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
