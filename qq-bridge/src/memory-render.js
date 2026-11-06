/**
 * 轻量记忆在唤醒提示词里怎么渲染（**纯函数**，便于单测）。
 *
 * ── 为什么要单独抽出来 ────────────────────────────────────────────────────
 *   2026-09-29 用户报「课表似乎没存好」，排查时发现两件事：
 *     ① 单条记忆上限只有 200 字 → 一张课表必然被腰斩（已改成 600，见 bridge.js appendMemoryV2）；
 *     ② 记忆块的"总预算"是**漏的** —— 只把正文记进预算，`- ` 前缀、时间尾注、
 *        `【进行中的话题】` 小标题全都没算，实测渲染出 1800 字而预算写的是 1500。
 *        单条上限一抬到 600，这个漏洞就会成倍放大（每轮唤醒都在多花钱）。
 *
 *   渲染规则本身又很容易写错（预算边界、尾注优先级、`''.slice(-0)` 这类 JS 陷阱），
 *   所以把它抽成纯函数配单测（scripts/test-memory-render.mjs），而不是埋在 15000 行的
 *   bridge.js 里靠肉眼 review。
 *
 * ── 渲染策略（改之前先读）────────────────────────────────────────────────
 *   - 新的在前：预算不够时**优先保最新**的话题/想法，旧的先被挤掉。
 *   - 按**整行**计预算（含前缀、尾注、小标题），保证"预算"是真上限。
 *   - 单行装不下时：优先保住**尾注**（里面有"待追问"，那是 AI 下次要开口说的话），
 *     正文从尾部截断加 `…`；若连 20 字正文都放不下，这一行**直接不显示** ——
 *     半句话比没有更误导。
 */

/** 默认总预算（字符）。与 cfg.socialV2.memory.promptBudgetChars 的默认值保持一致。 */
export const DEFAULT_PROMPT_BUDGET_CHARS = 1500;

/** 每一类最多渲染几条（防止"条数不多但每条都很长"把预算吃光）。 */
export const MAX_LINES_PER_SECTION = 10;

/**
 * 「永久记忆会话」的默认放宽值。
 *
 * 用户要求（2026-09-29）：「给 qq 号 10003 加一个**永久的长期记忆**」。
 *
 * 桥接里"记忆"分三层，只放开一层是不够的：
 *   ① 长期存档（逐日对话原文）—— 靠 `longTermMemory.includeKeys` 决定存不存，keepDays=0 已经是永久；
 *   ② 轻量记忆（话题/印象）—— `appendMemoryV2` 会把"24 小时没提起"的话题清掉，要按会话豁免；
 *   ③ **渲染预算** —— 就算 ② 留着，预算不够它照样进不了提示词，等于没记。
 *      所以永久会话要同时放宽预算与每类条数，否则用户会觉得"加了永久记忆但它还是想不起来"。
 */
export const DEFAULT_PERMANENT_LIMITS = {
  /** 渲染总预算（字符）。默认档 1500，永久档给 2500。 */
  budget: 2500,
  /** 每类最多渲染几条。默认 10，永久档 20。 */
  maxLinesPerSection: 20
};

/** 把 `private:123` / `123` 都归一成裸 QQ 号，便于白名单两种写法都认。 */
export function bareUin(key) {
  const s = String(key ?? '').trim();
  const m = /^private:(\d+)$/.exec(s);
  return m ? m[1] : s;
}

/**
 * 这个会话是不是"永久记忆"会话。
 * 名单里既可以写整条 key（`private:10003`），也可以只写 QQ 号（`10003`）。
 */
export function isPermanentMemoryKey(key, permanentKeys) {
  const list = Array.isArray(permanentKeys) ? permanentKeys : [];
  if (!list.length) return false;
  const k = String(key ?? '').trim();
  if (!k) return false;
  const bare = bareUin(k);
  return list.some((x) => {
    const s = String(x ?? '').trim();
    return s === k || s === bare;
  });
}

/**
 * 解析某个会话该用的渲染限额。
 *
 * ★ 2026-10-02 新增 **按会话覆盖** `memory.overrides[key]`（形状与 `socialV2.context.overrides` 一致）。
 *   起因：主人要求"把印象那节的行数上限 10 提到 20"，但他指的是**群 10004**——
 *   而原来 `maxLinesPerSection` 只有"全局值 + 永久会话放宽"两档，
 *   改全局会让**所有 14 个会话**都跟着多注入，那是每轮都付的持续成本。
 *   覆盖值**可以放大也可以缩小**（与 permanentLimits 的"只放大不缩小"不同：那是防误配，
 *   这里是显式点名的会话，尊重写进去的值）。
 *
 * @returns {{budget:number, maxLinesPerSection:number, permanent:boolean}}
 */
export function resolveMemoryLimits(key, cfg = {}) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const baseBudget = Math.max(200, Number(c.promptBudgetChars) || DEFAULT_PROMPT_BUDGET_CHARS);
  const baseLines = Math.max(1, Number(c.maxLinesPerSection) || MAX_LINES_PER_SECTION);

  // 按会话覆盖（可放大也可缩小；只对配置里点名的 key 生效）
  const ov = (c.overrides && typeof c.overrides === 'object' && !Array.isArray(c.overrides)) ? c.overrides : {};
  const mine = (key && Object.prototype.hasOwnProperty.call(ov, String(key))) ? ov[String(key)] : null;
  const applyOverride = (base) => {
    if (!mine || typeof mine !== 'object') return base;
    return {
      budget: Math.max(200, Number(mine.budget ?? mine.promptBudgetChars) || base.budget),
      maxLinesPerSection: Math.max(1, Number(mine.maxLinesPerSection) || base.maxLinesPerSection)
    };
  };

  if (!isPermanentMemoryKey(key, c.permanentKeys)) {
    const o = applyOverride({ budget: baseBudget, maxLinesPerSection: baseLines });
    return { budget: o.budget, maxLinesPerSection: o.maxLinesPerSection, permanent: false };
  }
  const p = { ...DEFAULT_PERMANENT_LIMITS, ...(c.permanentLimits && typeof c.permanentLimits === 'object' ? c.permanentLimits : {}) };
  const merged = {
    // 永久档只放大、不缩小（用户可能只改了 permanentKeys 而没动别的）
    budget: Math.max(baseBudget, Number(p.budget) || DEFAULT_PERMANENT_LIMITS.budget),
    maxLinesPerSection: Math.max(baseLines, Number(p.maxLinesPerSection) || DEFAULT_PERMANENT_LIMITS.maxLinesPerSection)
  };
  const o = applyOverride(merged);
  return { budget: o.budget, maxLinesPerSection: o.maxLinesPerSection, permanent: true };
}

/** 「已搁置」判定：超过这个时长没被提起的话题会被打标。 */
export const STALE_TOPIC_MS = 2 * 60 * 60 * 1000;

function str(v) {
  return String(v ?? '');
}

/**
 * 渲染记忆块。
 *
 * @param st - 会话状态（socialV2.conversations.get(key)）
 * @param opts.budget - 总预算字符数，默认 DEFAULT_PROMPT_BUDGET_CHARS
 * @param opts.now - 当前时刻（毫秒），便于单测
 * @returns {string} 可直接拼进提示词的文本（无内容时返回空串）
 */
export function renderMemoryBlock(st, opts = {}) {
  return renderMemoryDetail(st, opts).text;
}

/**
 * 渲染的详细版：除了文本，还告诉你**哪些条目被渲染了、哪些被挤掉了**。
 * check 脚本靠它回答"课表到底进没进提示词"这类问题。
 *
 * @returns {{text:string, usedChars:number, budget:number, picked:{topics:string[],thoughts:string[],impressions:string[]}}}
 */
export function renderMemoryDetail(st, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const picked = { topics: [], thoughts: [], impressions: [] };
  const pickedTopics = picked.topics;
  const pickedThoughts = picked.thoughts;
  const pickedImpressions = picked.impressions;
  if (!st || typeof st !== 'object') {
    return { text: '', usedChars: 0, budget: Math.max(200, Number(o.budget) || DEFAULT_PROMPT_BUDGET_CHARS), picked };
  }
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const budget = Math.max(200, Number(o.budget) || DEFAULT_PROMPT_BUDGET_CHARS);
  const maxLines = Math.max(1, Number(o.maxLinesPerSection) || MAX_LINES_PER_SECTION);

  let used = 0;
  // 记账：小标题、行前缀、时间尾注、以及 join 用的换行**全都算**。
  //
  // ⚠️ 每个元素多算 1 个换行（最后一行其实没有换行符）—— 这是**故意的偏保守**：
  //    记账值 ≥ 实际渲染长度，于是"预算"是真上限，而不是"大概齐"。
  //    2026-09-29 就是在这儿栽的：原来只记正文，实测渲染 1800 字而预算写 1500。
  const charge = (s) => { used += str(s).length + 1; };
  const fitLine = (body, tail = '') => {
    const prefix = '- ';
    const text = str(body);
    const rest = str(tail);
    if (used >= budget) return null;
    const room = budget - used;
    const full = `${prefix}${text}${rest}`;
    if (full.length <= room) { used += full.length + 1; return full; }
    const tailLen = Math.min(rest.length, Math.max(0, room - prefix.length - 1));
    const bodyRoom = room - prefix.length - tailLen - 1;
    // 只剩够写半个词的余地时不如不显示 —— 半句话比没有更误导。
    if (bodyRoom < 20) return null;
    // ⚠️ `''.slice(-0)` 返回的是整个字符串（-0 === 0），tailLen 为 0 时必须不走 slice。
    const out = `${prefix}${text.slice(0, bodyRoom)}…${tailLen > 0 ? rest.slice(-tailLen) : ''}`;
    used += out.length + 1;
    return out;
  };

  const lines = [];

  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    // 先把小标题的位置占掉：不预留的话，装满了正文之后再塞标题就会**超出**预算。
    const headerReserved = used + '【进行中的话题】'.length + 1 < budget;
    if (headerReserved) charge('【进行中的话题】');
    const pickedLines = [];
    for (const t of [...topics].reverse().slice(0, maxLines)) {
      const ago = t.lastMentionAt ? Math.round((now - Number(t.lastMentionAt)) / 60000) : 0;
      const stale = t.lastMentionAt && now - Number(t.lastMentionAt) > STALE_TOPIC_MS ? '（已搁置）' : '';
      const tail = `${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`;
      const line = fitLine(t.text, tail);
      if (line === null) break;
      pickedLines.push(line);
      pickedTopics.push(t.text);
    }
    if (pickedLines.length) lines.push('【进行中的话题】', ...pickedLines.reverse());
    else if (headerReserved) used -= '【进行中的话题】'.length + 1; // 没内容就把预留退回去
  }

  const thoughts = Array.isArray(st.pendingThoughts)
    ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < Number(t.expiresAt)))
    : [];
  if (thoughts.length) {
    const headerReserved = used + '【你想说但还没说的】'.length + 1 < budget;
    if (headerReserved) charge('【你想说但还没说的】');
    const pickedLines = [];
    for (const t of [...thoughts].reverse().slice(0, maxLines)) {
      const line = fitLine(t.text, t.motivation ? `（${t.motivation}）` : '');
      if (line === null) break;
      pickedLines.push(line);
      pickedThoughts.push(t.text);
    }
    if (pickedLines.length) lines.push('【你想说但还没说的】', ...pickedLines.reverse());
    else if (headerReserved) used -= '【你想说但还没说的】'.length + 1;
  }

  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length && used < budget) {
    // ★ 按"最近一次互动"排序取人，**不能**直接用 Object.keys 的顺序。
    //
    // 坑在哪（2026-09-29 体检实测）：Object.keys 的顺序是**首次记录时间** ——
    // 写入时对已存在的 key 赋值不会改变顺序（见 bridge.js 的印象写入分支），
    // 所以 `names.slice(-10)` 拿到的是"最早记的 10 个人"。结果群里 17 条印象里，
    // 被预算挡掉的正好是互动最多、当天刚聊过的那几位，反倒 09-28 只互动过一次的还在。
    // 数据没丢，但"记了等于没记"，而且是**永久隐身**（顺序不会自己变）。
    const orderIdx = new Map(names.map((n, i) => [n, i]));
    const ordered = names.slice().sort((a, b) => {
      const ta = Number(impressions[a]?.lastSeenAt) || 0;
      const tb = Number(impressions[b]?.lastSeenAt) || 0;
      if (ta !== tb) return ta - tb;                       // 越新越靠后，下面取尾部
      return (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0); // 没时间戳就保持插入顺序
    });
    const headerReserved = used + '【对群友的印象】'.length + 1 < budget;
    if (headerReserved) charge('【对群友的印象】');
    const pickedLines = [];
    for (const name of ordered.slice(-maxLines)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      const line = fitLine(`${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      // ⚠️ 这里必须是 `continue`，**不能是 `break`**。
      //
      // 2026-09-30 实测踩到：主人一个人的印象就有 11 条 × 50 字 ≈ 550 字，
      // 加上 999 字话题后剩余空间只够再塞一两个人；而 `break` 一旦命中，
      // **排在后面的所有人全都看不见**（哪怕他们的印象很短、完全放得下）。
      // 群里 17 个人的印象因此常年只显示 1~2 个。
      //
      // 话题/想法那两节仍然用 `break`（它们是"越新越靠前"的顺序，断了就意味着
      // 已到预算线，继续找没意义）；印象这一节是**按人**排的，长短不均，
      // 跳过放不下的、继续试下一个才是对的。
      if (line === null) {
        // 整行太长时，退一步**截断显示开头**，别整块丢掉。
        // 为什么（同一天的第二个坑）：课表写成一条 490 字印象后，
        // 主人那一行合计 1040 字、直接放不下 → 整块消失 → "课表进不了提示词"。
        // 显示前一段虽然丢了细节，但至少让 AI 知道"这人记过什么"，比一片空白强。
        // （真正的解法是把课表这种**独立参考资料**存成话题而不是印象，这里只是兜底。）
        const room = budget - used;
        const partial = `${name}：${String(traits[0] ?? '暂无记录').slice(0, Math.max(0, room - name.length - 8))}…`;
        if (room > 40 && partial.length <= room) {
          charge(partial);
          pickedLines.push(partial);
          pickedImpressions.push(name);
        }
        // ⚠️⚠️ 2026-10-01 晚修：**不 push 时什么都不做**。
        //
        // 实测现场：主人会话话题把预算吃到只剩几十字，`fitLine` 却仍然返回了
        // 那个**只有名字前缀**的行（`📮：`），于是渲染结果里出现了这种"空行"：
        //     【对群友的印象】
        //     - 📮
        //     - 主人(📮)
        // 它既没告诉 AI 任何内容，又白占了记账预算，还让人误以为"印象进去了"。
        // 现在改成：放不下就**跳过这个人**（继续试下一个更短的），一行空白都不留。
        // （pick 记录也不记 —— 否则诊断工具会报"这条印象进了提示词"，而实际是空的。）
        continue;
      }
      pickedLines.push(line);
      pickedImpressions.push(name);
    }
    if (pickedLines.length) lines.push('【对群友的印象】', ...pickedLines);
    else if (headerReserved) used -= '【对群友的印象】'.length + 1;
  }

  const text = lines.join('\n');
  return {
    text,
    usedChars: text.length,
    budget,
    picked: { topics: pickedTopics, thoughts: pickedThoughts, impressions: pickedImpressions }
  };
}

/**
 * 诊断用：渲染结果里"看得见/看不见"分别是哪些条目。
 * check 脚本用它回答"课表到底进没进提示词"这类问题。
 *
 * @returns {{text:string, usedChars:number, budget:number, shown:string[], hidden:string[]}}
 */
export function inspectMemoryBlock(st, opts = {}) {
  const detail = renderMemoryDetail(st, opts);
  const shown = [
    ...detail.picked.topics,
    ...detail.picked.thoughts,
    ...detail.picked.impressions.map((n) => `[印象] ${n}`)
  ];
  const shownSet = new Set(shown);
  const all = [
    ...(Array.isArray(st?.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : []).map((t) => String(t.text)),
    ...(Array.isArray(st?.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text) : []).map((t) => String(t.text)),
    ...Object.keys(st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}).map((n) => `[印象] ${n}`)
  ];
  const hidden = all.filter((t) => !shownSet.has(t));
  return { text: detail.text, usedChars: detail.usedChars, budget: detail.budget, shown, hidden };
}
