#!/usr/bin/env python3
"""Manage the optional macOS cold-start automation, outside the release payload."""

import argparse
import os
import platform
import plistlib
import shutil
import subprocess
from pathlib import Path

LABEL = "ai.bytepioneer.codexhost.auto-launch"


def paths(home):
    support = home / "Library/Application Support/codexhost/auto-launch"
    plist = home / "Library/LaunchAgents" / (LABEL + ".plist")
    return support, plist


def agent_configuration(home, launcher):
    support, _ = paths(home)
    return {
        "Label": LABEL,
        "ProgramArguments": [
            str(support / "codexhost-auto-launch"),
            "--launcher",
            str(launcher),
            "--data-directory",
            str(support),
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "LimitLoadToSessionType": "Aqua",
        "ProcessType": "Background",
        # Removing/updating the listener must not kill its active supervisor.
        "AbandonProcessGroup": True,
        "Umask": 0o077,
        "EnvironmentVariables": {
            "CODEXHOST_CONSOLE": "0",
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": str(support / "service.log"),
    }


def launchctl(*arguments, check=True):
    return subprocess.run(
        ["/bin/launchctl", *arguments], check=check, capture_output=True, text=True
    )


def require_regular_file_or_missing(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Refusing to replace a non-regular file: " + str(path))


def install(home, launcher, target):
    launcher = launcher.expanduser().resolve(strict=True)
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise ValueError("The launcher must be an executable file")
    support, plist = paths(home)
    source = Path(__file__).resolve().parent
    support.mkdir(parents=True, exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    binary = support / "codexhost-auto-launch"
    temporary = support / "codexhost-auto-launch.new"
    for path in (binary, temporary, plist):
        require_regular_file_or_missing(path)
    machine = platform.machine()
    if machine not in ("arm64", "x86_64"):
        raise ValueError("Unsupported macOS architecture: " + machine)
    subprocess.run(
        [
            "/usr/bin/xcrun", "swiftc", "-swift-version", "6", "-parse-as-library",
            "-O", "-target", machine + "-apple-macosx13.0",
            str(source / "AutoLaunch.swift"), "-o", str(temporary),
        ],
        check=True,
    )
    subprocess.run(
        ["/usr/bin/codesign", "--force", "--sign", "-", str(temporary)], check=True
    )
    if launchctl("print", target, check=False).returncode == 0:
        launchctl("bootout", target)
    os.replace(temporary, binary)
    for name in ("AutoLaunch.swift", "manage.py"):
        origin, destination = source / name, support / name
        require_regular_file_or_missing(destination)
        if origin.resolve() != destination.resolve():
            shutil.copy2(origin, destination)
    plist_temporary = plist.with_suffix(".plist.new")
    require_regular_file_or_missing(plist_temporary)
    plist_temporary.write_bytes(plistlib.dumps(agent_configuration(home, launcher)))
    plist_temporary.chmod(0o600)
    os.replace(plist_temporary, plist)
    launchctl("enable", target)
    launchctl("bootstrap", target.rsplit("/", 1)[0], str(plist))
    print("Installed: " + target)
    print("Existing Desktop sessions remain open; the next cold start is observed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "status", "uninstall"))
    parser.add_argument(
        "--launcher", type=Path,
        default=Path("/Applications/codexhost.app/Contents/MacOS/codexhost"),
        help="Absolute native codexhost executable path (install only)",
    )
    arguments = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This automation is available only on macOS")
    if os.getuid() == 0:
        parser.error("Run as the logged-in user, without sudo")
    if not arguments.launcher.is_absolute():
        parser.error("--launcher must be an absolute executable path")
    home = Path.home()
    support, plist = paths(home)
    target = "gui/{}/{}".format(os.getuid(), LABEL)
    if arguments.command == "install":
        install(home, arguments.launcher, target)
    elif arguments.command == "status":
        observed = launchctl("print", target, check=False)
        state = next(
            (line.strip() for line in observed.stdout.splitlines()
             if line.strip().startswith("state = ")),
            "state = not-loaded",
        )
        print(state)
        print("plist = " + str(plist))
        print("logs = " + str(support))
    else:
        if launchctl("print", target, check=False).returncode == 0:
            launchctl("bootout", target)
        require_regular_file_or_missing(plist)
        if plist.exists():
            plist.unlink()
        print("Uninstalled. Existing Desktop sessions remain open.")
        print("Source and logs retained at: " + str(support))


if __name__ == "__main__":
    main()
