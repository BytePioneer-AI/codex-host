#!/usr/bin/env python3
import json
import os
import time
from pathlib import Path

started = Path(os.environ["PROBE_STARTED"])
late = Path(os.environ["PROBE_LATE"])
delay = float(os.environ.get("PROBE_DELAY", "8"))
started.write_text(json.dumps({"pid": os.getpid(), "pgid": os.getpgid(0)}), encoding="utf-8")
time.sleep(delay)
late.write_text("late-write", encoding="utf-8")
