// Both the phone poller and Windows task use this process-safe, durable QQ delivery path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dailyLimit, planPush } from './daily-limit.mjs';

export function reportDay(now = new Date()) {
  return new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);
}

export function titleKey(title) {
  const normalized = String(title || '').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase().slice(0, 40);
  return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : '';
}

export function parseReport(md) {
  const sections = [];
  let current;
  for (const line of String(md).split(/\r?\n/)) {
    const match = /^###\s+(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/.exec(line);
    if (match) {
      current = { head: match[1], body: [] };
      sections.push(current);
    } else if (/^#{1,3}\s/.test(line)) current = null;
    else if (current) current.body.push(line);
  }
  for (const section of sections) {
    const fields = new Map();
    for (const line of section.body) {
      const plain = line.replace(/\*\*/g, '').replace(/^\s*[-*]\s*/, '').trim();
      const match = /^([^：:]+)[：:]\s*(.*)$/.exec(plain);
      if (match) fields.set(match[1].trim(), match[2].trim());
    }
    section.title = fields.get('标题') || '';
    section.note = fields.get('我自己的一句') || fields.get('我的一句话') || fields.get('一句话')
      || fields.get('为什么值得') || '';
    section.titleKey = titleKey(section.title);
  }
  return sections;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('推荐投递记录暂不可读，已暂停本次投递'); }
}

function atomicJson(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const stop = Math.max(...['。', '；', '，', '、'].map(mark => head.lastIndexOf(mark)));
  return (stop >= max * .45 ? head.slice(0, stop) : head) + '…';
}

function message(section, date) {
  return [`🅱️ ${date.slice(5)} · ${section.head}`, clip(section.title || section.head, 60),
    clip(section.note, 170), `https://www.bilibili.com/video/${section.head}`].filter(Boolean).join('\n');
}

function createLock(file, now) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Number(now) })); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}

function acquire(file, now) {
  try {
    return createLock(file, now);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock cleanup too, so concurrent recovery cannot remove a new owner's lock.
    const recovery = file + '.reclaim';
    let guard;
    try { guard = fs.openSync(recovery, 'wx'); } catch { return null; }
    try {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
      if (!Number.isSafeInteger(saved.pid) || saved.pid <= 0) return null;
      try { process.kill(saved.pid, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') return null; }
      fs.unlinkSync(file);
      // Lost receipts stay reserved in the ledger even after reclaiming a dead sender's lock.
      try { return createLock(file, now); }
      catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    } finally { fs.closeSync(guard); fs.unlinkSync(recovery); }
  }
}

function legacyHistory(mark, phone, sections, date, key) {
  const sentBvids = new Set(mark?.sentBvids || []);
  const sentTitleKeys = new Set(mark?.sentTitleKeys || []);
  for (const bv of phone?.bvs || []) if (/^BV[0-9A-Za-z]{10}$/.test(bv)) sentBvids.add(bv);
  for (const title of phone?.titles || []) { const hash = titleKey(title); if (hash) sentTitleKeys.add(hash); }
  const sameDay = mark?.date === date;
  const cursor = Number(phone?.files?.[`${date}.md`]) || 0;
  // The old phone wrote its evidence BEFORE sending; inherit as reservations, not proof of success.
  const legacyReserved = sections.slice(0, cursor).filter(section => (phone?.bvs || []).includes(section.head)).length;
  const already = sameDay ? Math.max(0, Number(mark.sentCount ?? mark.pushed) || 0) : 0;
  const currentCount = Math.max(already, legacyReserved);
  return { ...mark, version: 2, targetKey: key, date,
    ...(!sameDay ? { delivery: 'history-only' } : {}),
    pushed: sameDay ? Math.max(0, Number(mark.pushed) || 0) : 0,
    sentCount: currentCount, sentBvids: [...sentBvids], sentTitleKeys: [...sentTitleKeys],
    ...(legacyReserved > already ? { delivery: 'legacy-reserved', legacyReservedCount: legacyReserved } : {}),
  };
}

async function bridgeSend({ root, bridge, key, messages, fetchImpl }) {
  const state = path.join(root, 'qq-bridge/state');
  const social = readJson(path.join(state, 'social-v2.json'), {});
  const token = social?.conversations?.[key]?.agentToken;
  if (!token) throw new Error('QQ会话尚未准备好，推荐名额已保留');
  let consoleToken;
  try { consoleToken = fs.readFileSync(path.join(state, 'console-token'), 'utf8').trim(); }
  catch { throw new Error('QQ服务暂不可用，推荐名额已保留'); }
  const response = await fetchImpl(`${bridge}/api/socialV2/send-message`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken },
    body: JSON.stringify({ key, messages }),
  });
  if (!response.ok) throw new Error(`QQ推荐发送未确认（HTTP ${response.status}），已保留名额`);
  const result = await response.json();
  if (!result.ok || result.sent !== messages.length) throw new Error('QQ推荐发送回执不完整，已保留名额');
}

export async function forwardBiliReport({ root, home, bridge = 'http://127.0.0.1:3100',
  key = 'private:10001', source = 'scheduled', now = new Date(), dryRun = false,
  forceAll = false, fetchImpl = fetch } = {}) {
  const date = reportDay(now);
  const report = path.join(home, 'out', date + '.md');
  if (!fs.existsSync(report)) return { sent: 0, reason: 'no-report', date };
  const sections = parseReport(fs.readFileSync(report, 'utf8'));
  if (!sections.length) return { sent: 0, reason: 'no-items', date };
  const state = path.join(root, 'qq-bridge/state');
  const file = path.join(state, 'bili-report-pushed.json');
  const lockFile = file + '.lock';
  // Honor a still-running old task during the update; the new lock is shared across days and sources.
  if (fs.existsSync(file + '.' + date + '.lock')) return { sent: 0, reason: 'locked', date };
  fs.mkdirSync(state, { recursive: true });
  const release = dryRun ? () => {} : acquire(lockFile, now);
  if (!release) return { sent: 0, reason: 'locked', date };
  try {
    const raw = readJson(file, null);
    if (raw?.targetKey && raw.targetKey !== key) throw new Error('推荐投递目标与已有记录不一致，已暂停');
    const phone = readJson(path.join(root, 'phone-brain/state/bili-sent.json'), null);
    const inherited = legacyHistory(raw, phone, sections, date, key);
    const limit = dailyLimit(readJson(path.join(home, 'config.json'), {}));
    const plan = planPush({ sections, mark: inherited, date, limit, forceAll });
    const messages = plan.selected.map(section => message(section, date));
    if (dryRun) return { sent: 0, selected: messages.length, messages, date, limit, used: plan.sent, reason: 'preview' };
    if (!messages.length) {
      if (JSON.stringify(raw) !== JSON.stringify(inherited)) atomicJson(file, inherited);
      return { sent: 0, reason: plan.remaining ? 'already-delivered' : 'daily-quota', date, limit, used: plan.sent };
    }
    const pending = { ...inherited, ...plan.nextMark, source, delivery: 'pending', at: new Date(Number(now)).toISOString() };
    atomicJson(file, pending);
    await bridgeSend({ root, bridge, key, messages, fetchImpl });
    atomicJson(file, { ...pending, delivery: 'confirmed', confirmedAt: new Date().toISOString() });
    return { sent: messages.length, reason: 'confirmed', date, limit, used: plan.nextMark.sentCount };
  } finally { release(); }
}
