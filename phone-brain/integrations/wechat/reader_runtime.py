"""Use project-pinned dependencies without loading a shared Python site's hooks."""
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / '.venv/Lib/site-packages'))
sys.path.insert(0, str(ROOT / 'research/dsh-better-wechat/collector'))
TASKS = {'probe': 'probe_capture.py', 'capture': 'capture_wechat.py', 'access': 'access_probe.py'}
if len(sys.argv) != 2 or sys.argv[1] not in TASKS:
    raise SystemExit('Choose probe, capture or access')
runpy.run_path(str(ROOT / TASKS[sys.argv[1]]), run_name='__main__')
