"""Report Windows process access metadata only. Never read chat or key bytes."""
import ctypes as C
from ctypes import wintypes as W
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
k = C.WinDLL('kernel32', use_last_error=True)
a = C.WinDLL('advapi32', use_last_error=True)
k.GetCurrentProcess.restype = W.HANDLE
k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
k.OpenProcess.restype = W.HANDLE
k.CloseHandle.argtypes = [W.HANDLE]
a.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
a.GetTokenInformation.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD)]
a.GetSidSubAuthorityCount.argtypes = [C.c_void_p]
a.GetSidSubAuthorityCount.restype = C.POINTER(C.c_ubyte)
a.GetSidSubAuthority.argtypes = [C.c_void_p, W.DWORD]
a.GetSidSubAuthority.restype = C.POINTER(W.DWORD)


def token_info(process):
    token = W.HANDLE()
    if not a.OpenProcessToken(process, 8, C.byref(token)):
        return {'tokenError': C.get_last_error()}
    try:
        result = {}
        for kind, label in [(20, 'elevated'), (18, 'elevationType')]:
            value, length = W.DWORD(), W.DWORD()
            if a.GetTokenInformation(token, kind, C.byref(value), C.sizeof(value), C.byref(length)):
                result[label] = value.value
        length = W.DWORD()
        a.GetTokenInformation(token, 25, None, 0, C.byref(length))
        buf = C.create_string_buffer(length.value)
        if a.GetTokenInformation(token, 25, buf, len(buf), C.byref(length)):
            sid = C.cast(buf, C.POINTER(C.c_void_p))[0]
            count = a.GetSidSubAuthorityCount(sid)[0]
            rid = a.GetSidSubAuthority(sid, count - 1)[0]
            result['integrityRid'] = rid
            result['integrity'] = ('system' if rid >= 16384 else 'high' if rid >= 12288
                                   else 'medium' if rid >= 8192 else 'low')
        return result
    finally:
        k.CloseHandle(token)


result = {'at': datetime.now(timezone.utc).isoformat(), 'current': token_info(k.GetCurrentProcess()),
          'processes': [], 'memoryRead': False, 'privilegesChanged': False}
metadata = json.loads((ROOT / 'state/wechat-process-probe.json').read_text('utf-8-sig'))
for proc in metadata.get('processes', []):
    item = {'version': proc.get('version'), 'access': {}}
    for mask, label in [(0x1000, 'queryLimited'), (0x400, 'query'), (0x10, 'vmRead'),
                        (0x1010, 'queryLimitedVmRead'), (0x410, 'queryVmRead')]:
        handle = k.OpenProcess(mask, False, proc['pid'])
        item['access'][label] = {'ok': bool(handle), 'osCode': 0 if handle else C.get_last_error()}
        if handle:
            if mask == 0x1000:
                item['token'] = token_info(handle)
            k.CloseHandle(handle)
    result['processes'].append(item)
report = ROOT / 'verification/touch-hub-20261031/wechat-access.json'
report.parent.mkdir(parents=True, exist_ok=True)
report.write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
