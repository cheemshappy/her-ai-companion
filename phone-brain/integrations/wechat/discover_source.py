"""Find the desktop client's configured data root without printing account paths."""
from pathlib import Path
import json
import os
import re

ROOT = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get('APPDATA', Path.home() / 'AppData/Roaming')) / 'Tencent/xwechat/config'
accounts = set()
if CONFIG.is_dir():
    for entry in CONFIG.glob('*.ini'):
        if not entry.is_file() or entry.stat().st_size > 1048576:
            continue
        data = entry.read_bytes()
        for encoding in ('utf-8', 'utf-16le'):
            text = data.decode(encoding, errors='ignore')
            for match in re.finditer(r'[A-Za-z]:[\\/][^\x00\r\n"<>|]{1,400}', text):
                directory = Path(match.group().strip())
                for candidate in (directory, directory / 'xwechat_files'):
                    if candidate.is_dir():
                        accounts.update(p.resolve() for p in candidate.iterdir() if p.is_dir() and (p / 'db_storage').is_dir())
target = ROOT.parent.parent / 'state/wechat-source-discovery.json'
reason = 'LOCAL_ACCOUNT_NOT_FOUND' if not accounts else 'MULTIPLE_ACCOUNTS'
if len(accounts) == 1:
    value = str(next(iter(accounts)))
    previous = json.loads(target.read_text('utf-8-sig')).get('account_dir') if target.exists() else None
    if previous and Path(previous).resolve() != Path(value).resolve():
        reason = 'SOURCE_CHANGED'
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({'account_dir': value}), encoding='utf-8')
        reason = 'SOURCE_LOCATED'
print(json.dumps({'accountCount': len(accounts), 'reason': reason, 'messageBodiesRead': False}))
if reason != 'SOURCE_LOCATED':
    raise SystemExit(1)
