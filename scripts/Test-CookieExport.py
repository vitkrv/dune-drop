"""Offline smoke test of the bundled yt-dlp Firefox export contract."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="dunedrop-cookie-test-") as temporary:
    profile = Path(temporary) / "Firefox profile"
    profile.mkdir()
    with closing(sqlite3.connect(profile / "cookies.sqlite")) as connection:
        connection.execute("PRAGMA user_version=16")
        connection.execute("CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, originAttributes TEXT)")
        connection.execute("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?)", (".youtube.com", "SID", "synthetic-test-value", "/", int(time.time() + 86400) * 1000, 1, ""))
        connection.commit()
    info = Path(temporary) / "local.json"
    info.write_text(json.dumps({"id": "cookie-sync", "title": "Cookie sync", "formats": [{"url": "https://example.invalid/cookie-sync.mp4", "ext": "mp4", "format_id": "sync"}]}))
    output = Path(temporary) / "cookies.txt"
    command = [str(root / "src-tauri/resources/bin/yt-dlp.exe"), "--ignore-config", "--no-plugin-dirs", "--cookies-from-browser", f"firefox:{profile}", "--cookies", str(output), "--simulate", "--skip-download", "--no-check-formats", "--load-info-json", str(info)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    cookies = output.read_text()
    assert ".youtube.com" in cookies and "synthetic-test-value" in cookies
    assert "synthetic-test-value" not in result.stdout + result.stderr
    expiry = next(line.split("\t")[4] for line in cookies.splitlines() if line.startswith(".youtube.com"))
    assert time.time() < int(expiry) < time.time() + 90000, "Firefox millisecond expiry conversion failed"
print("Offline Firefox export passed: no media, no network, no cookie values in output.")
