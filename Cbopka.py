#!/usr/bin/env python3
"""Variant 1 helper: start the local Cbopka server and open the system browser.
The real 87MB portable build is the Node SEA exe produced by GitHub Actions.
"""
import os
import sys
import time
import webbrowser
import subprocess
from pathlib import Path

def main():
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
    node = "node"
    server = base / "server" / "index.js"
    env = os.environ.copy()
    env["PORT"] = "3000"
    env["CLIENT_DIST_PATH"] = str(base / "client" / "dist")
    env.setdefault("DISABLE_SQLITE", "1")
    env.setdefault("DISABLE_MULTER", "1")
    env["CBOPKA_OPEN_BROWSER"] = "1"
    if not server.exists():
        print("server/index.js не найден")
        return 1
    proc = subprocess.Popen([node, str(server)], env=env, cwd=str(base))
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:3000")
    return proc.wait()

if __name__ == "__main__":
    raise SystemExit(main())
