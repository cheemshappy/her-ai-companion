/** 全天推荐额度；兼容旧版仅记录 pushed 的投递账目。 */
export function dailyLimit(config) {
  const value = Number(config?.perDay ?? 1);
  return Number.isFinite(value) ? Math.max(0, Math.min(50, Math.floor(value))) : 1;
}

export function planPush({ sections, mark, date, limit, forceAll = false }) {
  const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : 0;
  const sameDay = mark?.date === date;
  const base = sameDay ? count(mark.pushed) : 0;
  const sent = sameDay ? (mark.sentCount === undefined ? base : count(mark.sentCount)) : 0;
  // Daily quota rolls over; delivery history does not. Keep all sources on one ledger.
  const ids = new Set((mark?.sentBvids || (sameDay
    ? sections.slice(0, base).map((s) => s.head.match(/^BV[0-9A-Za-z]{10}/)?.[0]) : [])).filter(Boolean));
  const titles = new Set(mark?.sentTitleKeys || []);
  const remaining = Math.max(0, limit - sent);
  const selected = [];
  let cursor = base;
  for (let i = 0; i < sections.length && selected.length < remaining; i += 1) {
    const section = sections[i];
    const bv = section.head.match(/^BV[0-9A-Za-z]{10}/)?.[0];
    cursor = Math.max(cursor, i + 1);
    if (!bv || ids.has(bv) || (section.titleKey && titles.has(section.titleKey))) continue;
    ids.add(bv);
    if (section.titleKey) titles.add(section.titleKey);
    selected.push(section);
  }
  return {
    selected, sent, remaining,
    nextMark: { date, pushed: cursor, sentCount: sent + selected.length, sentBvids: [...ids], sentTitleKeys: [...titles] },
  };
}
