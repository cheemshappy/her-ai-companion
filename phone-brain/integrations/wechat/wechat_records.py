"""Read a verified private snapshot into a bounded message feed.

Schema and cipher snapshot support: pinned CH3SH-LC/dsh-better-wechat;
see research/dsh-better-wechat/LICENSE and THIRD_PARTY_NOTICES.md.
No source database is opened by SQLite, and media URLs are never fetched.
"""
from contextlib import closing
import hashlib
import io
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
import zstandard

LABELS = {3: '图片', 34: '语音', 42: '名片', 43: '视频', 47: '表情', 48: '位置', 49: '分享卡片', 50: '通话', 10000: '系统消息'}


def decode_body(value):
    if isinstance(value, str):
        return value, True
    if value is None:
        return '', True
    if not isinstance(value, bytes):
        return '', False
    try:
        if value.startswith(bytes.fromhex('28b52ffd')):
            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(value)) as stream:
                body = stream.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                return '', False
            # A truncated frame must not be published as complete text.
            remaining = value
            while remaining:
                decoder = zstandard.ZstdDecompressor().decompressobj()
                decoder.decompress(remaining)
                if not decoder.eof:
                    return '', False
                remaining = decoder.unused_data
            value = body
        return value.decode('utf-8'), True
    except (UnicodeDecodeError, zstandard.ZstdError):
        return '', False


def display_body(content, local_type):
    base = local_type & 0xffffffff
    if base == 1:
        return content, [], [], None
    label = LABELS.get(base, '消息附件')
    text, mentions, reply = [], [], None
    if len(content) <= 1024 * 1024 and content.lstrip().startswith('<'):
        try:
            root = ET.fromstring(content)
            for tag in ('title', 'des', 'digest', 'content', 'displayname', 'label', 'poiname', 'filename'):
                for element in root.iter(tag):
                    value = (element.text or '').strip()
                    if value and value not in text:
                        text.append(value)
            for element in root.iter('atuserlist'):
                mentions.extend(part.strip() for part in (element.text or '').split(',') if part.strip())
            reference = root.find('.//refermsg')
            if reference is not None:
                reply = {'senderId': reference.findtext('fromusr') or '', 'messageId': reference.findtext('svrid') or ''}
            if base == 10000 and not text:
                text = [' '.join(s.strip() for s in root.itertext() if s.strip())]
        except ET.ParseError:
            text = ['结构化正文暂未解析']
    elif content:
        text = [content]
    # A card's description is readable; this never claims its attached media was read.
    attachments = [] if base in (47, 10000) else [{'type': str(base), 'label': label, 'readable': False}]
    return '[' + label + ']' + ('\n' + '\n'.join(text) if text else '（内容尚未解析）'), attachments, mentions, reply


def read_recent(capture, capture_report, account_dir, now=None, retention_days=7, limit=10000):
    now = time.time() if now is None else now
    paths = {}
    for relative, info in capture_report['databases'].items():
        path = (capture / 'decrypted' / relative).resolve()
        if not path.is_relative_to((capture / 'decrypted').resolve()):
            raise RuntimeError('UNSAFE_CAPTURE_PATH')
        if info.get('status') != 'verified' or info.get('integrity_check') != 'ok':
            raise RuntimeError('UNVERIFIED_DATABASE')
        if hashlib.sha256(path.read_bytes()).hexdigest() != info.get('sha256'):
            raise RuntimeError('CAPTURE_CHANGED')
        paths[relative] = path

    def connect(relative):
        connection = sqlite3.connect(paths[relative].as_uri() + '?mode=ro&immutable=1', uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    names, known = {}, set()
    with closing(connect('contact/contact.db')) as connection:
        for table in ('contact', 'stranger'):
            for row in connection.execute('SELECT username,nick_name,remark,alias FROM ' + table):
                if isinstance(row['username'], str) and row['username']:
                    names.setdefault(row['username'], next((row[key] for key in ('remark', 'nick_name', 'alias') if isinstance(row[key], str) and row[key]), row['username']))
    known.update(names)
    with closing(connect('session/session.db')) as connection:
        known.update(row[0] for row in connection.execute('SELECT username FROM SessionTable') if isinstance(row[0], str))
        for row in connection.execute('SELECT username,session_title FROM SessionNoContactInfoTable'):
            if isinstance(row[0], str):
                known.add(row[0])
                if isinstance(row[1], str) and row[1]:
                    names[row[0]] = row[1]
    message_files = sorted(relative for relative in paths if re.fullmatch(r'message/(?:biz_)?message_\d+\.db', relative))
    mappings = {}
    for relative in message_files:
        with closing(connect(relative)) as connection:
            mappings[relative] = dict(connection.execute('SELECT rowid,user_name FROM Name2Id'))
            known.update(value for value in mappings[relative].values() if isinstance(value, str) and value)
    owner = re.sub(r'_[0-9a-fA-F]{4}$', '', account_dir.name)
    if not owner or owner not in known:
        raise RuntimeError('OWNER_ID_UNVERIFIED')
    conversations = {hashlib.md5(value.encode('utf-8')).hexdigest(): value for value in known}
    items, decode_errors, unmapped, total_rows = [], 0, 0, 0
    for relative in message_files:
        with closing(connect(relative)) as connection:
            tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Msg_*'")]
            for table in tables:
                if not re.fullmatch(r'Msg_[0-9a-f]{32}', table):
                    raise RuntimeError('UNSUPPORTED_MESSAGE_TABLE')
                conversation = conversations.get(table[4:])
                if not conversation:
                    unmapped += 1
                    continue
                columns = {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}
                required = {'local_id', 'local_type', 'real_sender_id', 'create_time', 'message_content'}
                if not required <= columns:
                    raise RuntimeError('UNSUPPORTED_MESSAGE_SCHEMA')
                # Only the recent window enters the companion; full archives stay on the PC.
                rows = connection.execute('SELECT * FROM "' + table + '" WHERE create_time>=? AND create_time<=? ORDER BY create_time DESC,local_id DESC LIMIT ?', (now - retention_days * 86400, now + 60, limit))
                for row in rows:
                    total_rows += 1
                    sender = mappings[relative].get(row['real_sender_id'])
                    body, decoded = decode_body(row['message_content'])
                    if not decoded:
                        decode_errors += 1
                    room = conversation.endswith('@chatroom')
                    if room and sender and body.startswith(sender + ':\n'):
                        body = body[len(sender) + 2:]
                    text, attachments, mentions, reply = display_body(body, row['local_type'])
                    if not decoded:
                        text = '[正文暂未解码，请在微信核对]'
                        attachments = [{'type': 'undecoded', 'readable': False}]
                    if not text:
                        continue
                    identity = [owner, relative, table, row['local_id']]
                    key = 'wechat:' + hashlib.sha256(str(identity).encode('utf-8')).hexdigest()
                    direction = 'outgoing' if sender == owner else 'incoming' if sender else 'unknown'
                    name = names.get(conversation, conversation)
                    item = dict(key=key, accountId=owner, ownerId=owner, source='desktop-wechat',
                                kind='group' if room else 'private', conversationId='wechat:' + conversation,
                                senderId=sender or '', sender='我' if sender == owner else names.get(sender, sender or '系统/未知发送者'),
                                who='微信 · ' + name, text=text[:32000], at=int(row['create_time'] * 1000),
                                messageId=str(row['local_id']), direction=direction, mentions=mentions, replyTo=reply,
                                truncated=len(text) > 32000, attachments=attachments,
                                contentRevision=hashlib.sha256((direction + text).encode('utf-8')).hexdigest()[:20])
                    items.append(item)
    items.sort(key=lambda item: (item['at'], item['key']))
    return dict(ownerId=owner, items=items[-limit:], recentRows=total_rows, decodeErrors=decode_errors,
                unmappedConversations=unmapped, retainedMessages=min(len(items), limit))
