"""Verify the pinned reader against first-page authentication only.

No history export, decryption output, stored keys, account names or messages.
"""
from pathlib import Path
import json
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'research/dsh-better-wechat/collector'))
REPORT = ROOT.parent.parent / 'verification/hub-20261031/wechat-capture-probe.json'
result = dict(at=datetime.now(timezone.utc).isoformat(), sourceAccess='read_only',
              historyExported=False, chatBodiesRead=False, keysPersisted=False,
              injected=False, sentMessages=False, integrationEnabled=False,
              fullSnapshotVerified=False, firstPagesAuthenticated=False)
result['stage'] = 'dependencies'
try:
    import daily_export as daily
    import extract_local as reader
    result['dependencies'] = daily.dependencies()
    private = ROOT.parent.parent / 'state'
    discovery = private / 'wechat-source-discovery.json'
    config = dict(daily.DEFAULTS)
    if discovery.exists():
        config['account_dir'] = json.loads(discovery.read_text('utf-8-sig')).get('account_dir', '')
    result['stage'] = 'discover-account'
    accounts = daily.discover_accounts(config)
    processes = daily.discover_processes()
    metadata = private / 'wechat-process-probe.json'
    if not processes and metadata.exists():
        # A parent PowerShell probe avoids child CIM enumeration returning [].
        processes = json.loads(metadata.read_text('utf-8-sig')).get('processes', [])
    result.update(accountCount=len(accounts), mainProcessCount=len(processes),
                  clientVersions=sorted(set(p['version'] for p in processes if p.get('version'))))
    if len(accounts) != 1:
        result['reason'] = 'ACCOUNT_SELECTION_REQUIRED' if accounts else 'LOCAL_ACCOUNT_NOT_FOUND'
    elif not processes:
        result['reason'] = 'MAIN_PROCESS_NOT_FOUND'
    else:
        source = accounts[0] / 'db_storage'
        result['stage'] = 'enumerate-databases'
        databases = reader._files(source)
        selected = [source / name for name in reader.REQUIRED_DATABASES]
        selected += [p for p in databases if p.parent.name == 'message' and p.name.startswith('message_')][:1]
        pages = []
        result['stage'] = 'read-encrypted-first-pages'
        for item in selected:
            with item.open('rb') as stream:
                pages.append(stream.read(reader.PAGE))
        verified = set()
        result['stage'] = 'scan-readonly-process'
        for process in processes:
            keys = reader.scan(process['pid'], process['image'], progress=lambda event: None)
            try:
                for index, page in enumerate(pages):
                    if any(reader.authenticated(reader.mkey(key, page[:16]), page, 1) for key in keys):
                        verified.add(index)
            finally:
                keys.clear()
            if len(verified) == len(pages):
                break
        result['stage'] = 'authentication-result'
        result.update(databasesPresent=len(databases), testedFirstPages=len(pages),
                      authenticatedFirstPages=len(verified),
                      firstPagesAuthenticated=len(verified) == len(pages),
                      reason='FIRST_PAGE_CHECK_ONLY' if len(verified) == len(pages) else 'NO_AUTHENTICATED_KEY')
except Exception as error:
    result['errorType'] = type(error).__name__
    if isinstance(error, OSError):
        result['osCode'] = getattr(error, 'winerror', None) or error.errno
REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
