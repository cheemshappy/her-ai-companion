// memory-journal.js —— 把"轻量记忆"从「三个格子填表」换成**按天流水的一页笔记**。
//
// 为什么要换（2026-10-18，主人转述她自己的原话）：
//   「最想改的就一条：别再替我分类。现在落笔前得先想清楚这句算「话题」还是「想说的话」，记点东西搞得跟填表一样」
//   「给我一页按天的流水就行，想到什么写什么，写歪了也不管。容量按页算，满了让我自己撕，别按体积咔嚓截断」
//   「最好还能搜 —— 现在每次唤醒是整块摊开给我看，我想查「上次他说要补骑车是哪天」都翻不了」
//
// 设计：
//   · 一个会话一本 `state/journal/<key>.md`，按 `## YYYY-MM-DD` 分天，每行 `- HH:MM 内容`
//   · 唤醒时只注入**最近 N 字**（默认 1200）+ 一句「要翻旧账用 qq_memory_query 带 q 搜」
//   · 旧的三格记忆（activeTopics/pendingThoughts/memberImpressions）**原样保留**，不删不迁 —— 兼容
//   · 写满了**不自动截断**：超过 maxBytes 时把 60 天前的整天搬进 `archive/<key>-<年>.md`
//     （搬走 ≠ 删掉，搜索仍然能搜到），并在返回里告诉她"这本多少 KB、搬了几天"
import fs from 'node:fs';
import path from 'node:path';

const DAY_HEAD_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

function safeKey(key) {
  return String(key ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

function journalDir(stateDir) { return path.join(stateDir, 'journal'); }
function journalFile(stateDir, key) { return path.join(journalDir(stateDir), `${safeKey(key)}.md`); }
function archiveDir(stateDir) { return path.join(journalDir(stateDir), 'archive'); }

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clockStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readAll(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 把日记切成 [{ date, lines[] }]（按 `## 日期` 分段）。 */
function splitDays(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = DAY_HEAD_RE.exec(raw.trim());
    if (m) {
      if (cur) out.push(cur);
      cur = { date: m[1], lines: [] };
      continue;
    }
    if (cur) cur.lines.push(raw);
  }
  if (cur) out.push(cur);
  return out;
}

/** 写一条（不用分类；太长的行截到 maxLine）。 */
export function appendJournal(stateDir, key, text, { maxLine = 400, maxBytes = 1024 * 1024 } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: '内容为空' };
  const line = clean.length > maxLine ? `${clean.slice(0, maxLine)}…` : clean;
  const file = journalFile(stateDir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 先看看要不要把很老的整天搬去归档（搬，不删）
  let archived = 0;
  try {
    const size = fs.statSync(file).size;
    if (size > maxBytes) archived = archiveOldDays(stateDir, key, { keepDays: 60 }).archivedDays || 0;
  } catch { /* 文件还不存在 */ }

  let body = readAll(file);
  const today = todayStr();
  if (!new RegExp(`^##\\s+${today}\\s*$`, 'm').test(body)) {
    body = `${body.replace(/\s*$/, '')}${body ? '\n\n' : ''}## ${today}\n`;
  }
  body = `${body.replace(/\s*$/, '')}\n- ${clockStr()} ${line}\n`;
  fs.writeFileSync(file, body, 'utf8');

  const stats = journalStats(stateDir, key);
  return { ok: true, line, archivedDays: archived, stats };
}

/** 唤醒时注入的那一段：最近 maxChars 字（从整行边界开始）。 */
export function readJournalTail(stateDir, key, maxChars = 1200) {
  const text = readAll(journalFile(stateDir, key)).trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const cut = text.slice(-maxChars);
  const nl = cut.indexOf('\n');
  return `…${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}

/** 搜日记：所有词都命中才算（不区分大小写）；archive 里的也搜。 */
export function searchJournal(stateDir, key, query, { limit = 8 } = {}) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { ok: false, error: 'q 不能为空' };
  const files = [journalFile(stateDir, key)];
  try {
    for (const f of fs.readdirSync(archiveDir(stateDir))) {
      if (f.startsWith(`${safeKey(key)}-`) && f.endsWith('.md')) files.push(path.join(archiveDir(stateDir), f));
    }
  } catch { /* 没归档目录 */ }

  const hits = [];
  for (const file of files) {
    for (const day of splitDays(readAll(file))) {
      for (const raw of day.lines) {
        const line = raw.trim();
        if (!line || line.startsWith('-') === false) continue;
        const low = line.toLowerCase();
        if (!terms.every((t) => low.includes(t))) continue;
        hits.push({ date: day.date, line: line.replace(/^-\s*/, '') });
        if (hits.length >= limit) return { ok: true, query, hits, truncated: true };
      }
    }
  }
  return { ok: true, query, hits, truncated: false };
}

/** 这本多大、写了几天。 */
export function journalStats(stateDir, key) {
  const file = journalFile(stateDir, key);
  let bytes = 0;
  let text = '';
  try { bytes = fs.statSync(file).size; text = readAll(file); } catch { /* 还没写 */ }
  const days = splitDays(text).length;
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('- ')).length;
  return { bytes, kb: Math.round((bytes / 1024) * 10) / 10, days, lines, file };
}

/** 把超过 keepDays 的整天搬去 archive（搬走，不删；搜索仍覆盖）。 */
export function archiveOldDays(stateDir, key, { keepDays = 60 } = {}) {
  const file = journalFile(stateDir, key);
  const text = readAll(file);
  if (!text) return { archivedDays: 0 };
  const cutoff = new Date(Date.now() - keepDays * 86400000);
  const cutStr = todayStr(cutoff);
  const days = splitDays(text);
  const old = days.filter((d) => d.date < cutStr);
  if (!old.length) return { archivedDays: 0 };

  const keep = days.filter((d) => d.date >= cutStr);
  const byYear = new Map();
  for (const d of old) {
    const year = d.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(d);
  }
  fs.mkdirSync(archiveDir(stateDir), { recursive: true });
  for (const [year, list] of byYear) {
    const af = path.join(archiveDir(stateDir), `${safeKey(key)}-${year}.md`);
    const existing = readAll(af);
    const chunk = list.map((d) => `## ${d.date}\n${d.lines.join('\n').trim()}`).join('\n\n');
    fs.writeFileSync(af, `${existing.trimEnd()}${existing ? '\n\n' : ''}${chunk}\n`, 'utf8');
  }
  fs.writeFileSync(file, `${keep.map((d) => `## ${d.date}\n${d.lines.join('\n').trim()}`).join('\n\n')}\n`, 'utf8');
  return { archivedDays: old.length };
}

export { journalFile, todayStr };
