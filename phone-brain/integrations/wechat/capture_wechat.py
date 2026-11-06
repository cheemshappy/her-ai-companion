"""Single account, read-only refresh. Stdout contains health metadata only."""
from pathlib import Path
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import runpy
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent
PHONE = ROOT.parents[1]
PRIVATE = PHONE / 'state'
sys.path.insert(0, str(ROOT))
from wechat_records import read_recent
import daily_export as daily
import extract_local as reader


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


result = {'ok': False, 'at': int(time.time() * 1000), 'readOnly': True, 'opensApps': False,
          'keysPersisted': False, 'sentMessages': False, 'integrationEnabled': False}
status_file = PRIVATE / 'wechat-reader-health.json'
try:
    # Recheck the client's own source selection before every refresh; no silent account switch.
    with contextlib.redirect_stdout(io.StringIO()):
        runpy.run_path(str(ROOT / 'discover_source.py'), run_name='__main__')
    account = Path(json.loads((PRIVATE / 'wechat-source-discovery.json').read_text('utf-8-sig'))['account_dir']).resolve()
    processes = daily.discover_processes()
    if len(processes) != 1:
        raise RuntimeError('MAIN_PROCESS_NOT_FOUND' if not processes else 'MULTIPLE_MAIN_PROCESSES')
    result['clientVersions'] = sorted(set(p.get('version', '') for p in processes))
    files = reader._files(account / 'db_storage')
    fingerprint = hashlib.sha256()
    for path in files:
        fingerprint.update(path.relative_to(account).as_posix().encode('utf-8'))
        for suffix in ('', '-wal'):
            sidecar = Path(str(path) + suffix)
            fingerprint.update(sidecar.read_bytes() if sidecar.exists() else b'absent')
    source_stamp = fingerprint.hexdigest()
    feed = PRIVATE / 'desktop-wechat-inbox.json'
    previous = json.loads(feed.read_text('utf-8')) if feed.exists() else {}
    if previous.get('fingerprint') == source_stamp and previous.get('formatVersion') == 1:
        result.update(ok=True, unchanged=True, integrationEnabled=True,
                      count=len(previous.get('items', [])), lastCaptureAt=previous.get('capturedAt'),
                      decodeErrors=previous.get('decodeErrors', 0), unmappedConversations=previous.get('unmappedConversations', 0),
                      **previous.get('captureMetadata', {}))
    else:
        work = PRIVATE / 'wechat-work'
        work.mkdir(exist_ok=True)
        # Only this invocation's generated temporary copy is removed. Source chat and
        # the last published verified feed are never modified on capture failure.
        with tempfile.TemporaryDirectory(prefix='capture-', dir=work) as temporary:
            capture = Path(temporary) / 'verified'
            report = reader.capture_account(account, capture, processes, progress=lambda event: None)
            normalized = read_recent(capture, report, account)
            incoming_owner = normalized.pop('ownerId')
            if previous.get('ownerId') and previous['ownerId'] != incoming_owner:
                raise RuntimeError('ACCOUNT_CHANGED')
            capture_metadata = dict(verifiedDatabases=report['verified_databases'],
                                    walMergedDatabases=sum(bool(v.get('wal_merged')) for v in report['databases'].values()),
                                    authenticatedPages=sum(v.get('base_pages_authenticated', 0) + v.get('wal_pages_authenticated', 0) for v in report['databases'].values()))
            published = {**normalized, 'ownerId': incoming_owner, 'fingerprint': source_stamp, 'formatVersion': 1,
                         'captureMetadata': capture_metadata,
                         'capturedAt': int(time.time() * 1000), 'verifiedDatabases': report['verified_databases']}
            write_json(feed, published)
            result.update(ok=True, unchanged=False, integrationEnabled=True, count=len(normalized['items']),
                          **capture_metadata,
                          decodeErrors=normalized['decodeErrors'], unmappedConversations=normalized['unmappedConversations'],
                          lastCaptureAt=published['capturedAt'])
except SystemExit:
    result['error'] = 'SOURCE_SELECTION_UNAVAILABLE'
except Exception as error:
    safe = str(error) if isinstance(error, RuntimeError) and str(error).replace('_', '').isupper() else type(error).__name__
    result['error'] = safe
    if isinstance(error, reader.CaptureError):
        result['captureStatus'] = error.report.get('status')
        result['verifiedDatabases'] = error.report.get('verified_databases', 0)
        result['databaseStates'] = {name: value.get('status') for name, value in error.report.get('databases', {}).items()}
        # Safe structural reasons from this pinned reader never contain records/keys.
        result['databaseErrors'] = {name: value.get('error') for name, value in error.report.get('databases', {}).items() if value.get('error')}
result['completedAt'] = int(time.time() * 1000)
write_json(status_file, result)
print(json.dumps(result))
if not result['ok']:
    raise SystemExit(1)
