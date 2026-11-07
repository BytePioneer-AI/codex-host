#!/usr/bin/env python3
"""Exercise cold-start automation using real macOS notifications and a fixture app."""
import json
import os
import plistlib
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import atexit
import tempfile
import importlib.util

source = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('manage', source / 'manage.py')
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)
plan = manage.agent_configuration(Path('/Users/test user'), Path('/Applications/test host/codexhost'))
assert plan['AbandonProcessGroup'] is True
assert plan['EnvironmentVariables']['CODEXHOST_CONSOLE'] == '0'
assert plan['ProgramArguments'][2] == '/Applications/test host/codexhost'
assert '--data-directory' in plan['ProgramArguments']
workspace = tempfile.TemporaryDirectory(prefix='codexhost-auto-launch-test-')
atexit.register(workspace.cleanup)
root = Path(workspace.name).resolve()
fixture_source = root / 'Fixture.swift'
fixture_source.write_text('''import AppKit

@main
@MainActor
enum Fixture {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.run()
    }
}
''')
subprocess.run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library',
                str(fixture_source), '-o', str(root / 'Fixture')], check=True)
binary = root / 'codexhost-auto-launch'
subprocess.run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library', '-O',
                '-target', __import__('platform').machine() + '-apple-macosx13.0',
                str(source / 'AutoLaunch.swift'), '-o', str(binary)], check=True)
app = root / 'AutoInject Test.app'
bundle_identifier = 'ai.bytepioneer.codexhost.auto-launch.fixture.' + root.name
contents = app / 'Contents'
(contents / 'MacOS').mkdir(parents=True, exist_ok=True)
shutil.copy2(root / 'Fixture', contents / 'MacOS/Fixture')
(contents / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': bundle_identifier,
    'CFBundleExecutable': 'Fixture', 'CFBundlePackageType': 'APPL',
    'CFBundleName': 'AutoInject Test', 'CFBundleVersion': '1',
}))
data = root / 'state'
data.mkdir(exist_ok=True)
for file in data.iterdir():
    file.unlink()

launcher = root / 'fake-codexhost'
launcher.write_text('''#!/usr/bin/env python3
import json, os, signal, subprocess, time
from pathlib import Path
app = Path(os.environ['CODEXHOST_INSTALL_ROOT'])
root = app.parent
data = root / 'state'
def pids():
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
    result = []
    for row in rows.splitlines():
        fields = row.strip().split(None, 1)
        if len(fields) == 2 and fields[1] == str(app / 'Contents/MacOS/Fixture'):
            result.append(int(fields[0]))
    return result
original = pids()
with (data / 'handoffs.jsonl').open('a') as f:
    f.write(json.dumps({'console': os.getenv('CODEXHOST_CONSOLE'),
                       'original': original, 'args': __import__('sys').argv[1:]}) + '\\n')
for pid in original:
    os.kill(pid, signal.SIGTERM)
for _ in range(100):
    if not pids(): break
    time.sleep(.05)
subprocess.run(['/usr/bin/open', '-n', str(app), '--args', '--remote-debugging-port=0'], check=True)
for _ in range(100):
    if pids(): break
    time.sleep(.05)
managed = set(pids())
while managed.intersection(pids()): time.sleep(.1)
time.sleep(1.5)
''')
launcher.chmod(0o755)
config = {
    'bundleIdentifiers': [bundle_identifier],
    'launcherPath': str(launcher), 'dataDirectory': str(data), 'fixture': True,
}
config_path = root / 'config.json'
config_path.write_text(json.dumps(config))

watcher = None

def fixture_pids():
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
    return [int(parts[0]) for row in rows.splitlines()
            if len(parts := row.strip().split(None, 1)) == 2
            and parts[1] == str(contents / 'MacOS/Fixture')]

def kill_fixture():
    for pid in fixture_pids():
        os.kill(pid, signal.SIGTERM)
    wait_for(lambda: not fixture_pids(), 'fixture exit')

def open_fixture(reuse=False):
    subprocess.run(['/usr/bin/open', '-a' if reuse else '-n', str(app)], check=True)
    wait_for(fixture_pids, 'fixture launch')

def lines(name):
    path = data / name
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

def wait_for(predicate, name, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value: return value
        time.sleep(.1)
    raise AssertionError('Timed out: ' + name + '\n' + str(lines('events.jsonl')))

def start_watcher():
    global watcher
    watcher = subprocess.Popen([str(binary), '--fixture-config', str(config_path)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for(lambda: lines('events.jsonl')[-1:]
             and lines('events.jsonl')[-1]['event'] == 'listening', 'watcher ready')

def stop_watcher():
    global watcher
    if watcher:
        watcher.terminate()
        watcher.wait(timeout=5)
        watcher = None

checks = []
try:
    kill_fixture()
    open_fixture()
    baseline = fixture_pids()
    start_watcher()
    time.sleep(1)
    assert fixture_pids() == baseline and not lines('handoffs.jsonl')
    checks.append('Existing app survives listener startup without any handoff.')
    kill_fixture()

    for count in (1, 2):
        open_fixture()
        wait_for(lambda: len(lines('handoffs.jsonl')) == count, 'cold launch handoff')
        wait_for(lambda: any(e['event'] == 'already-controlled'
                            for e in lines('events.jsonl')), 'managed re-launch recognized')
        time.sleep(1)
        assert len(lines('handoffs.jsonl')) == count, 'recursive injection loop'
        assert all(h['console'] == '0' and h['args'] == ['launch']
                   for h in lines('handoffs.jsonl'))
        live = fixture_pids()
        open_fixture(reuse=True)
        time.sleep(.5)
        assert fixture_pids() == live and len(lines('handoffs.jsonl')) == count
        kill_fixture()
        if count == 2:
            wait_for(lambda: sum(e['event'] == 'launcher-exited'
                                for e in lines('events.jsonl')) >= count, 'supervisor exit')
    checks += ['Two successive cold starts each hand off exactly once, including immediate quit/reopen during old supervisor cleanup.',
               'Managed re-launch does not recurse; warm open does not re-inject.',
               'Every handoff receives CODEXHOST_CONSOLE=0 and the launch command.']

    stop_watcher()
    config['launcherPath'] = str(root / 'does-not-exist')
    config_path.write_text(json.dumps(config))
    start_watcher()
    open_fixture()
    wait_for(lambda: any(e['event'] == 'error' and 'missing' in e['detail']
                        for e in lines('events.jsonl')), 'missing launcher handling')
    assert fixture_pids() and len(lines('handoffs.jsonl')) == 2
    checks.append('Missing codexhost leaves the original app running.')

    kill_fixture()
    stop_watcher()
    failure = root / 'failing-codexhost'
    failure.write_text('#!/bin/sh\nexit 1\n')
    failure.chmod(0o755)
    config['launcherPath'] = str(failure)
    config_path.write_text(json.dumps(config))
    start_watcher()
    open_fixture()
    wait_for(lambda: any(e['event'] == 'error' and 'status 1' in e['detail']
                        for e in lines('events.jsonl')), 'failed launcher exit')
    kill_fixture()
    open_fixture()
    wait_for(lambda: any(e['event'] == 'skipped' and 'Recent launch failure' in e['detail']
                        for e in lines('events.jsonl')), 'failure cooldown')
    assert fixture_pids()
    checks.append('A failed launcher pauses subsequent handoffs and preserves the app.')
    print(json.dumps({'passed': checks}, indent=2))
finally:
    kill_fixture()
    stop_watcher()
