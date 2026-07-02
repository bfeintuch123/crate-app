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


ROOT = Path("/Users/bryantfeintuchclaw/Projects")
EXPECTED_REMOTE = "bfeintuch123/crate-app"
EXPECTED_BRANCH = "v2.4.x"
KEYCHAIN_SERVICE = "crate-cloudflare-api-token"


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

    if (ROOT / ".codex" / "tools" / "codex_thread_control.py").exists():
        checks.append(ok("tool.thread_control", "local Codex thread bridge present"))
    else:
        checks.append(warn("tool.thread_control", "local Codex thread bridge missing"))

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


def main() -> int:
    checks = check_repo() + check_tools() + check_auth()
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
