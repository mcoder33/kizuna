#!/usr/bin/env python3
"""Supervised macOS smoke: allow the isolated test app's notification permission.

Compiles production sources; uses only loopback HTTP and an ephemeral WebView.
One benign OS banner is expected. No installed Kizuna files or accounts are used.
The test-only app lives in ~/Applications; KIZUNA_NOTIFICATION_TEST_APP overrides it.
"""
import json
import os
import pathlib
import plistlib
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Fixture(BaseHTTPRequestHandler):
    fresh = False
    pages = 0
    failures = []

    def log_message(self, *_):
        pass

    def do_GET(self):
        status = 200
        if self.path == "/":
            body = b"<!doctype html><h1>Kizuna notification test</h1><p>Local fixture only.</p>"
        else:
            payload = {}
            if self.path.startswith("/api/") and self.headers.get("Cookie") != "pagent_session=local-notification-fixture":
                status = 401
                type(self).failures.append("API request did not use the WKWebView session cookie")
            elif self.path == "/api/auth/me":
                payload = {"user": {"id": "local-fixture-user"}}
            elif self.path == "/api/settings":
                payload = {"settings": {"notifyPrefs": '{"reminder":"phone"}', "quietHours": "off"}, "timeZone": "UTC"}
            elif self.path == "/api/notifications":
                type(self).pages += 1
                ids = ["fixture-fresh", "fixture-old"] if self.fresh else ["fixture-old"]
                payload = {"kinds": [{"key": "reminder", "default": "phone"}], "notifications": [
                    {"id": item, "kind": "reminder", "read": False, "resolved": False,
                     "text": "Local integration check — no action needed.",
                     "data": {"pushTitle": "Kizuna notification test", "url": "/#today"}} for item in ids]}
            elif self.path == "/fixture/fresh":
                type(self).fresh = True
            elif self.path == "/fixture/state":
                payload = {"pages": self.pages}
            else:
                status = 404
            body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html" if self.path == "/" else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


root = pathlib.Path(__file__).resolve().parent
artifacts = pathlib.Path(tempfile.mkdtemp(prefix="kizuna-notifications-"))
app = pathlib.Path(os.environ.get("KIZUNA_NOTIFICATION_TEST_APP", pathlib.Path.home() / "Applications/Kizuna Notification Test.app"))
contents = app / "Contents"
if app.exists():
    existing = plistlib.loads((contents / "Info.plist").read_bytes())
    if existing.get("CFBundleIdentifier") != "space.agenthub.kizuna.notification-test":
        raise SystemExit("Refusing to replace another app")
(contents / "MacOS").mkdir(parents=True, exist_ok=True)
info = {"CFBundleIdentifier": "space.agenthub.kizuna.notification-test", "CFBundleName": "Kizuna Notification Test",
        "CFBundleDisplayName": "Kizuna Notification Test", "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleShortVersionString": "1.0", "NSUserNotificationAlertStyle": "banner",
        "CFBundleExecutable": "NotificationTest", "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "13.0", "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
(contents / "Info.plist").write_bytes(plistlib.dumps(info))
sources = [root / "Sources" / name for name in ["NotificationDelivery.swift", "Notifications.swift", "Localization.swift"]]
subprocess.run(["swiftc", "-parse-as-library", *map(str, sources), str(root / "Tests/notification-integration.swift"),
                "-o", str(contents / "MacOS/NotificationTest")], check=True)
subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
                "-f", str(app)], check=True)
server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
report, log = artifacts / "result.json", artifacts / "output.log"
print(f"Native fixture artifacts: {artifacts}", flush=True)
print("If macOS asks, allow notifications for Kizuna Notification Test.", flush=True)
try:
    subprocess.run(["open", "-n", "--stdout", str(log), "--stderr", str(log), str(app), "--args",
                    f"http://127.0.0.1:{server.server_port}/", str(report)], check=True)
    deadline = time.monotonic() + 240
    while not report.exists() and time.monotonic() < deadline:
        time.sleep(0.5)
finally:
    server.shutdown()
    if not report.exists() and report.with_suffix(".json.pid").exists():
        try:
            os.kill(int(report.with_suffix(".json.pid").read_text()), signal.SIGTERM)
        except ProcessLookupError:
            pass
print(log.read_text() if log.exists() else "No native log was created.")
result = json.loads(report.read_text()) if report.exists() else {"passed": False, "error": "Native fixture did not write a result"}
result["http_cookie_failures"] = Fixture.failures
report.write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
raise SystemExit(0 if result["passed"] and not Fixture.failures else 1)
