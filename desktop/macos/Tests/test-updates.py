#!/usr/bin/env python3
"""Exercise real signed Sparkle installs in disposable apps over loopback only."""
import argparse
import functools
import http.server
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

MAC = Path(__file__).resolve().parents[1]
SPARKLE = Path(subprocess.check_output(['bash', str(MAC / 'fetch-sparkle.sh')], text=True).strip())

def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stdout}\n{result.stderr}')
    return result.stdout

class Handler(http.server.SimpleHTTPRequestHandler):
    requests = []
    minimum_download_seconds = 0
    def log_message(self, *args):
        pass
    def do_GET(self):
        self.requests.append(self.path)
        if self.path.startswith('/network/'):
            self.send_error(503)
        else:
            super().do_GET()
    def copyfile(self, source, outputfile):
        try:
            chunks = max(1, (os.fstat(source.fileno()).st_size + 65535) // 65536)
            while chunk := source.read(64 * 1024):
                outputfile.write(chunk)
                if self.path.endswith('.zip'):
                    outputfile.flush()
                    time.sleep(max(0.003, self.minimum_download_seconds / chunks))
        except (BrokenPipeError, ConnectionResetError):
            pass

def stop_demo_process(app, process_file):
    """Only terminate a PID still running this exact disposable application's binary."""
    executable = str(app / 'Contents/MacOS/UpdaterFixture')
    stopped = set()
    # Sparkle can be between the old process exiting and the new one launching.
    # Re-read the registration briefly so Ctrl+C during relaunch catches its new PID.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            pid = int(process_file.read_text())
            if pid > 0 and pid not in stopped:
                command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='],
                                                  text=True, stderr=subprocess.DEVNULL).strip()
                if command == executable or command.startswith(executable + ' '):
                    os.kill(pid, signal.SIGTERM)
                    stopped.add(pid)
        except (FileNotFoundError, ValueError, subprocess.CalledProcessError, ProcessLookupError):
            pass
        time.sleep(0.1)

parser = argparse.ArgumentParser(description=__doc__)
mode_arguments = parser.add_mutually_exclusive_group()
mode_arguments.add_argument('--demo', action='store_true', help='Show an interactive local update from demo 1.0 to 2.0')
mode_arguments.add_argument('--scenario', choices=['success', 'draft', 'defer', 'cancel', 'bad-archive', 'bad-feed', 'network', 'no-update', 'reminders', 'probe'])
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='kizuna-update-test-') as temp:
    root = Path(temp)
    root.chmod(0o700)
    key = root / 'test-key'
    keygen = root / 'key.swift'
    keygen.write_text('''import Foundation
import CryptoKit
let key = Curve25519.Signing.PrivateKey()
try! Data(key.rawRepresentation.base64EncodedString().utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print(key.publicKey.rawRepresentation.base64EncodedString())
''')
    public_key = run('swift', str(keygen), str(key)).strip()
    key.chmod(0o600)
    binary = root / 'UpdaterFixture'
    run('swiftc', '-O', '-framework', 'AppKit', '-F', str(SPARKLE), '-framework', 'Sparkle',
        '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks',
        str(MAC / 'Sources/Localization.swift'), str(MAC / 'Sources/UpdateReminder.swift'), str(MAC / 'Sources/Updates.swift'),
        str(MAC / 'Tests/update-fixture.swift'), '-o', str(binary))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=temp))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    prefix = f'http://127.0.0.1:{server.server_port}'
    modes = ['demo'] if args.demo else ['success', 'draft', 'defer', 'cancel', 'bad-archive', 'bad-feed', 'network', 'no-update', 'reminders', 'probe']
    if args.scenario:
        modes = [args.scenario]
    for mode in modes:
        # Keep an actual cancellation opportunity between the fixture's UI ticks.
        Handler.minimum_download_seconds = 2 if args.demo else (1 if mode == 'cancel' else 0)
        case = root / mode
        case.mkdir()
        feed = case / 'feed'
        feed.mkdir()
        result = case / 'result.log'
        app_name = 'KizunaUpdateDemo.app' if args.demo else 'KizunaUpdateFixture.app'
        app = case / app_name
        contents = app / 'Contents'
        (contents / 'MacOS').mkdir(parents=True)
        (contents / 'Frameworks').mkdir()
        shutil.copy2(binary, contents / 'MacOS/UpdaterFixture')
        run('ditto', str(SPARKLE / 'Sparkle.framework'), str(contents / 'Frameworks/Sparkle.framework'))
        identifier = f'space.agenthub.kizuna.update-test.{uuid.uuid4().hex}'
        info = {
            'CFBundleIdentifier': identifier, 'CFBundleName': 'Kizuna Update Demo' if args.demo else 'Kizuna Update Fixture',
            'CFBundleExecutable': 'UpdaterFixture', 'CFBundlePackageType': 'APPL',
            'CFBundleVersion': '1' if mode == 'no-update' else '2', 'CFBundleShortVersionString': '2.0',
            'LSMinimumSystemVersion': '13.0', 'NSHighResolutionCapable': True,
            'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': True},
            'SUFeedURL': f'{prefix}/{mode}/feed/appcast.xml', 'SUPublicEDKey': public_key,
            'SUEnableAutomaticChecks': True, 'SUAutomaticallyUpdate': False, 'SUEnableSystemProfiling': False,
            'SUVerifyUpdateBeforeExtraction': True, 'SURequireSignedFeed': True, 'SUSignedFeedFailureExpirationInterval': 0,
            'TestMode': mode, 'TestResult': str(result),
        }
        process_file = case / 'process.pid'
        if args.demo:
            info['TestProcessFile'] = str(process_file)
        if mode == 'success':
            screenshot = MAC / 'dist/update-banner.png'
            screenshot.parent.mkdir(exist_ok=True)
            info['TestScreenshot'] = str(screenshot)
        plist = contents / 'Info.plist'
        plist.write_bytes(plistlib.dumps(info))
        run('codesign', '--force', '--sign', '-', str(app))
        archive = feed / 'Update.zip'
        run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive))
        run(str(SPARKLE / 'bin/generate_appcast'), '--ed-key-file', str(key), '--maximum-deltas', '0',
            '--download-url-prefix', f'{prefix}/{mode}/feed/', str(feed))
        if mode == 'bad-archive':
            data = bytearray(archive.read_bytes()); data[len(data) // 2] ^= 1; archive.write_bytes(data)
        if mode == 'bad-feed':
            appcast = feed / 'appcast.xml'
            appcast.write_text(appcast.read_text().replace('<title>', '<title>Modified ', 1))
        info['CFBundleVersion'] = '1'; info['CFBundleShortVersionString'] = '1.0'
        plist.write_bytes(plistlib.dumps(info))
        run('codesign', '--force', '--sign', '-', str(app))
        with (case / 'process.log').open('w') as output:
            # Register through LaunchServices, as a real user launch does.
            # Running the Mach-O directly makes Sparkle unable to locate the
            # application to terminate/relaunch on some macOS versions.
            launch = ['open', '-n'] + ([] if args.demo else ['-W']) + [str(app)]
            process = subprocess.Popen(launch, stdout=output, stderr=output)
            if args.demo:
                print('Открылось отдельное демо Кизуны 1.0. Подготовлена локальная версия 2.0.', flush=True)
                print('Нажмите «Обновить приложение» в плашке: скачивание → установка → перезапуск.', flush=True)
                print('После скрытия плашки или отмены нажмите «Проверить обновление снова».', flush=True)
                print('Закройте окно демо или нажмите Ctrl+C в этом Terminal, чтобы остановить демо.', flush=True)
                print('Установленная Кизуна, учётная запись и публичные файлы не меняются.', flush=True)
                try:
                    reported_installed = False
                    startup_deadline = time.monotonic() + 15
                    while True:
                        log = result.read_text() if result.exists() else ''
                        if 'INSTALLED 2' in log and not reported_installed:
                            reported_installed = True
                            print('Готово: демо обновилось до версии 2.0 и перезапустилось.', flush=True)
                        if 'DEMO CLOSED' in log:
                            break
                        if not process_file.exists() and time.monotonic() >= startup_deadline:
                            raise RuntimeError(f'Не удалось открыть демо: {(case / "process.log").read_text()}')
                        time.sleep(0.1)
                except KeyboardInterrupt:
                    print('\nОстанавливаю локальное демо…', flush=True)
                finally:
                    stop_demo_process(app, process_file)
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=5)
                    subprocess.run(['defaults', 'delete', identifier], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    shutil.rmtree(Path.home() / 'Library/Caches' / identifier, ignore_errors=True)
                    server.shutdown()
                    server.server_close()
                continue
            deadline = time.monotonic() + 45
            expected = {'success': 'INSTALLED 2', 'draft': 'INSTALLED 2', 'reminders': 'INSTALLED 2', 'probe': 'INSTALLED 2', 'defer': 'DEFERRED',
                        'cancel': 'CANCELLED', 'no-update': 'NO UPDATE'}.get(mode, 'REJECTED')
            log = ''
            while time.monotonic() < deadline:
                log = result.read_text() if result.exists() else ''
                if expected in log or 'UNEXPECTED ERROR' in log or 'TIMEOUT' in log:
                    break
                time.sleep(0.1)
            if expected not in log:
                print(log, flush=True)
                print((case / 'process.log').read_text(), flush=True)
            try:
                assert expected in log, f'{mode}: expected {expected}'
                installed = plistlib.loads(plist.read_bytes())['CFBundleVersion']
                assert installed == ('2' if mode in ['success', 'draft', 'reminders', 'probe'] else '1'), (mode, installed)
                if mode == 'defer':
                    assert not any(path.startswith('/defer/') and path.endswith('.zip') for path in Handler.requests)
                if mode == 'draft':
                    assert 'DRAFT BLOCKED' in log and 'DRAFT RETRY' in log
                if mode == 'reminders':
                    for marker in ['DUE REMINDER BUSY RETRY', 'DUE REMINDER CHECKED', 'SNOOZED 1H', 'SNOOZE BACKGROUND SUPPRESSED', 'CLOSED UNTIL TOMORROW',
                                   'EARLY MANUAL REQUEST', 'EARLY MANUAL BYPASS', 'IGNORED CURRENT BUILD', 'IGNORE BACKGROUND SUPPRESSED', 'MANUAL BYPASS']:
                         assert marker in log, marker
                if mode == 'probe':
                    for marker in ['SDK INSTALLER PROBE ACTIVE', 'PROBE MANUAL REQUEST', 'PROBE MANUAL BYPASS']:
                        assert marker in log, marker
                print(f'PASS: {mode}', flush=True)
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
                subprocess.run(['defaults', 'delete', identifier], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                shutil.rmtree(Path.home() / 'Library/Caches' / identifier, ignore_errors=True)
    server.shutdown()
    server.server_close()
if args.demo:
    print('Локальное демо завершено; временные файлы удалены.', flush=True)
else:
    print(f'PASS: {len(modes)} real updater scenarios (including reminder controls, signed install and relaunch)', flush=True)
