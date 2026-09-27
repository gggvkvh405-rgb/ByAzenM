#!/usr/bin/env python3
"""Cbopka Native — real window via pywebview (WebView2 / WebKit), not a browser tab.

Build:
  pip install pywebview pyinstaller
  pyinstaller --onefile --windowed --name Cbopka-App-Native Cbopka-Native.py
"""
import os
import sys
import time
import subprocess
from pathlib import Path

try:
    import webview
    HAS_WEBVIEW = True
except ImportError:
    HAS_WEBVIEW = False


def base_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


def find_node():
    for candidate in ("node", "nodejs", "node.exe"):
        try:
            subprocess.run([candidate, "--version"], capture_output=True, timeout=3, check=False)
            return candidate
        except Exception:
            continue
    return None


def find_server(base):
    for rel in (
        Path("electron") / "server-bundle.cjs",
        Path("server") / "index.js",
        Path("sea") / "sea-bundle.cjs",
    ):
        p = base / rel
        if p.exists():
            return p
    return None


def find_dist(base):
    for rel in (Path("client") / "dist", Path("client-dist"), Path("dist")):
        p = base / rel
        if (p / "index.html").exists():
            return p
    return base / "client" / "dist"


def start_server():
    base = base_dir()
    node = find_node()
    server = find_server(base)
    if not node or not server:
        print("Node или сервер не найдены — откроется локальный файл, если он есть")
        return None
    env = os.environ.copy()
    env["PORT"] = "3000"
    env["CLIENT_DIST_PATH"] = str(find_dist(base))
    env["NODE_ENV"] = "production"
    # Never load better-sqlite3 / multer inside a packaged host. Fixes 3221225477.
    env["DISABLE_SQLITE"] = "1"
    env["DISABLE_MULTER"] = "1"
    env["CBOPKA_OPEN_BROWSER"] = "0"
    print(f"server: {node} {server}")
    proc = subprocess.Popen([node, str(server)], env=env, cwd=str(server.parent))
    time.sleep(1.4)
    if proc.poll() is not None:
        print("сервер завершился сразу")
        return None
    return proc


class Api:
    def __init__(self, proc):
        self.proc = proc

    def close_app(self):
        if self.proc:
            try:
                self.proc.terminate()
            except Exception:
                pass
        for w in webview.windows:
            w.destroy()


def main():
    proc = start_server()
    if proc:
        url = "http://127.0.0.1:3000"
    else:
        index = find_dist(base_dir()) / "index.html"
        url = index.as_uri() + "?p2p=1" if index.exists() else "about:blank"
    if not HAS_WEBVIEW:
        print("pip install pywebview — без него это не нативное окно")
        import webbrowser
        webbrowser.open(url)
        return 1
    window = webview.create_window(
        "Cbopka",
        url,
        width=1280,
        height=840,
        min_size=(940, 640),
        background_color="#0c0d11",
        js_api=Api(proc),
        text_select=True,
    )
    try:
        webview.start()
    finally:
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
