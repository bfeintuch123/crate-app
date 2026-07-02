#!/usr/bin/env python3
"""Minimal local Codex app-server thread control helper.

This is a Crate workflow tool, not Crate app code. It speaks the local Codex
app-server protocol over the default Unix control socket and exposes a small
subset of thread operations for the Crate source-of-truth workflow.

The helper starts a temporary app-server when one is not already running.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import signal
import socket
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


CODEX = Path("/Applications/Codex.app/Contents/Resources/codex")
CODEX_HOME = Path.home() / ".codex"
SOCKET_PATH = CODEX_HOME / "app-server-control" / "app-server-control.sock"
DEFAULT_CWD = "/Users/bryantfeintuchclaw/Projects"


class ProtocolError(RuntimeError):
    pass


def encode_ws_text(payload: str) -> bytes:
    data = payload.encode("utf-8")
    first = 0x80 | 0x1
    mask_bit = 0x80
    if len(data) < 126:
        header = bytes([first, mask_bit | len(data)])
    elif len(data) < (1 << 16):
        header = bytes([first, mask_bit | 126]) + struct.pack("!H", len(data))
    else:
        header = bytes([first, mask_bit | 127]) + struct.pack("!Q", len(data))
    mask = secrets.token_bytes(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return header + mask + masked


def recv_exact(sock: socket.socket, n: int) -> bytes:
    chunks: list[bytes] = []
    remaining = n
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ProtocolError("socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def recv_ws(sock: socket.socket) -> str | None:
    first, second = recv_exact(sock, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    mask = recv_exact(sock, 4) if masked else b""
    payload = recv_exact(sock, length) if length else b""
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    if opcode == 8:
        return None
    if opcode == 9:
        # Ping. The helper only performs short-lived calls, so ignore.
        return recv_ws(sock)
    if opcode not in (1, 2):
        return recv_ws(sock)
    return payload.decode("utf-8")


class AppServer:
    def __init__(self) -> None:
        self.proc: subprocess.Popen[str] | None = None
        self.sock: socket.socket | None = None

    def __enter__(self) -> "AppServer":
        if not self._can_connect():
            self._start_temp_server()
        self.sock = self._connect()
        self._initialize()
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)

    def _can_connect(self) -> bool:
        try:
            sock = self._connect()
            sock.close()
            return True
        except OSError:
            return False

    def _start_temp_server(self) -> None:
        SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(
            [str(CODEX), "app-server", "--listen", "unix://"],
            cwd=DEFAULT_CWD,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"app-server exited with code {self.proc.returncode}")
            if self._can_connect():
                return
            time.sleep(0.1)
        raise TimeoutError("app-server socket did not become ready")

    def _connect(self) -> socket.socket:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(str(SOCKET_PATH))
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            "GET / HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            response += sock.recv(4096)
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise ProtocolError(response.decode("utf-8", "replace"))
        return sock

    def _send(self, payload: dict[str, Any]) -> None:
        if not self.sock:
            raise RuntimeError("not connected")
        self.sock.sendall(encode_ws_text(json.dumps(payload)))

    def _recv_json(self, timeout: float | None = None) -> dict[str, Any]:
        if not self.sock:
            raise RuntimeError("not connected")
        if timeout is not None:
            self.sock.settimeout(timeout)
        raw = recv_ws(self.sock)
        if raw is None:
            raise ProtocolError("websocket closed")
        return json.loads(raw)

    def _initialize(self) -> None:
        request_id = str(uuid.uuid4())
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "crate-thread-control",
                        "title": "Crate Thread Control",
                        "version": "1",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "requestAttestation": False,
                        "optOutNotificationMethods": [
                            "command/exec/outputDelta",
                            "item/agentMessage/delta",
                            "item/plan/delta",
                            "item/fileChange/outputDelta",
                            "item/reasoning/summaryTextDelta",
                            "item/reasoning/textDelta",
                        ],
                    },
                },
            }
        )
        while True:
            msg = self._recv_json(timeout=15)
            if msg.get("id") == request_id:
                if "error" in msg:
                    raise ProtocolError(json.dumps(msg["error"], indent=2))
                break
        self._send({"jsonrpc": "2.0", "method": "initialized"})

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30) -> Any:
        request_id = str(uuid.uuid4())
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        while True:
            msg = self._recv_json(timeout=timeout)
            if msg.get("id") != request_id:
                continue
            if "error" in msg:
                raise ProtocolError(json.dumps(msg["error"], indent=2))
            return msg.get("result")

    def wait_turn_completed(self, thread_id: str, turn_id: str, timeout: float) -> dict[str, Any] | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self._recv_json(timeout=max(1, min(10, deadline - time.time())))
            except socket.timeout:
                continue
            if msg.get("method") == "turn/completed":
                params = msg.get("params") or {}
                turn = params.get("turn") or {}
                if params.get("threadId") == thread_id and turn.get("id") == turn_id:
                    return params
        return None


def cmd_list(args: argparse.Namespace) -> None:
    params = {
        "limit": args.limit,
        "archived": args.archived,
        "cwd": args.cwd,
        "sortKey": "updated_at",
        "sortDirection": "desc",
    }
    with AppServer() as server:
        print(json.dumps(server.request("thread/list", params), indent=2))


def cmd_read(args: argparse.Namespace) -> None:
    with AppServer() as server:
        print(
            json.dumps(
                server.request("thread/read", {"threadId": args.thread_id, "includeTurns": args.include_turns}),
                indent=2,
            )
        )


def cmd_start(args: argparse.Namespace) -> None:
    params = {
        "cwd": args.cwd,
        "runtimeWorkspaceRoots": [args.cwd],
        "approvalPolicy": args.approval_policy,
        "sandbox": args.sandbox,
        "threadSource": "appServer",
    }
    with AppServer() as server:
        result = server.request("thread/start", params)
        thread = result["thread"]
        if args.title:
            server.request("thread/name/set", {"threadId": thread["id"], "name": args.title})
            thread["name"] = args.title
        print(json.dumps(result, indent=2))
        if args.message:
            start_turn(server, thread["id"], args.message, args.wait)


def start_turn(server: AppServer, thread_id: str, message: str, wait_seconds: int) -> None:
    result = server.request(
        "turn/start",
        {
            "threadId": thread_id,
            "input": [{"type": "text", "text": message, "text_elements": []}],
        },
    )
    print(json.dumps(result, indent=2))
    turn_id = result.get("turn", {}).get("id")
    if wait_seconds and turn_id:
        completed = server.wait_turn_completed(thread_id, turn_id, wait_seconds)
        if completed is None:
            print(
                json.dumps(
                    {
                        "warning": "turn did not complete before timeout",
                        "threadId": thread_id,
                        "turnId": turn_id,
                    },
                    indent=2,
                )
            )
        else:
            print(json.dumps(completed, indent=2))


def cmd_send(args: argparse.Namespace) -> None:
    with AppServer() as server:
        server.request(
            "thread/resume",
            {
                "threadId": args.thread_id,
                "cwd": DEFAULT_CWD,
                "runtimeWorkspaceRoots": [DEFAULT_CWD],
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "excludeTurns": True,
            },
        )
        start_turn(server, args.thread_id, args.message, args.wait)


def cmd_name(args: argparse.Namespace) -> None:
    with AppServer() as server:
        print(json.dumps(server.request("thread/name/set", {"threadId": args.thread_id, "name": args.title}), indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Crate local Codex app-server thread control")
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("list", help="List Codex app-server threads")
    p.add_argument("--cwd", default=DEFAULT_CWD)
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--archived", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("read", help="Read a thread")
    p.add_argument("thread_id")
    p.add_argument("--include-turns", action="store_true")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("start", help="Start a new thread")
    p.add_argument("--cwd", default=DEFAULT_CWD)
    p.add_argument("--title")
    p.add_argument("--message")
    p.add_argument("--wait", type=int, default=0)
    p.add_argument("--approval-policy", default="never")
    p.add_argument("--sandbox", default="danger-full-access")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("send", help="Send a turn to an existing thread")
    p.add_argument("thread_id")
    p.add_argument("message")
    p.add_argument("--wait", type=int, default=120)
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("name", help="Set a thread name")
    p.add_argument("thread_id")
    p.add_argument("title")
    p.set_defaults(func=cmd_name)

    args = parser.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
