import fs from 'node:fs';
import Character from './ui/character-state.js';
export { Character };

/** Injectable clock and persistence keep tests away from real conversations. */
export function createCharacter({ file, now = Date.now, environment = () => ({}) } = {}) {
  let saved = { ...Character.normalize(), accessories: [], at: 0, expiresAt: 0, source: 'environment', revision: 0 };
  try { if (file) saved = { ...saved, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  saved = { ...saved, ...Character.normalize(saved), accessories: Character.expressions(saved.accessories) };
  const seen = new Map();
  const touches = [];
  let userVersion = 0;
  saved.interactions = Array.isArray(saved.interactions) ? saved.interactions.slice(-20) : [];
  saved.reaction = null;
  function save() {
    if (!file) return;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
    fs.renameSync(tmp, file);
  }
  function get() {
    const env = environment();
    const active = saved.expiresAt > now();
    const base = active ? Character.normalize(saved) : Character.guess('', env);
    return { ok: true, ...base, expressions: active ? base.expressions : [], accessories: saved.accessories,
      label: Character.MOODS[base.mood].label, palette: Character.MOODS[base.mood].palette,
      at: saved.at, expiresAt: active ? saved.expiresAt : 0, revision: saved.revision, source: active ? saved.source : 'environment', environment: env,
      reaction: saved.reaction && now()-saved.reaction.at < 20000 ? saved.reaction : null,
      interactions: saved.interactions.filter(e => now()-e.at < 10*60*1000).slice(-12),
      lastTouch: saved.lastTouch && now() - saved.lastTouch.at < 5 * 60 * 1000 ? saved.lastTouch : null };
  }
  function set(value, source = 'ai', { expectedVersion } = {}) {
    if (expectedVersion !== undefined && expectedVersion !== userVersion) return get();
    const state = Character.normalize(value);
    if (source === 'ai' && value.interactionReaction) saved.reaction = { ...value.interactionReaction, at: now() };
    if (['touch', 'manual', 'tool'].includes(source)) userVersion++;
    const duration = source === 'manual' ? 30 * 60 * 1000 : source === 'touch' ? 18000 : 5 * 60 * 1000;
    saved = { ...saved, ...state, at: now(), expiresAt: now() + duration, source, revision: saved.revision + 1 };
    if (Array.isArray(value.accessories) && source !== 'touch') saved.accessories = Character.expressions(value.accessories);
    // AI and transient touch reactions must not change an outfit implicitly.
    if (source === 'ai' || source === 'reply' || source === 'touch') saved.expressions = saved.expressions.filter(x => !Character.OUTFITS.includes(x));
    if (['ai','reply','touch'].includes(source)) saved.plan = saved.plan.map(b => ({...b,expressions:b.expressions.filter(x=>!Character.OUTFITS.includes(x))}));
    save();
    return get();
  }
  function touch(event) {
    if (!event || !Object.hasOwn(Character.PARTS, event.part) || !['tap', 'rub'].includes(event.kind)) throw new Error('invalid touch');
    const id = String(event.id || '').slice(0, 100);
    if (!id) throw new Error('touch id required');
    if (seen.has(id)) return { ...get(), reaction: seen.get(id), duplicate: true };
    while (touches.length && now() - touches[0] > 12000) touches.shift();
    const reaction = Character.react(get(), event, touches.length);
    // Ignore accidental duplicate presses arriving within a single display frame.
    if (touches.length && now() - touches[touches.length - 1] < 100) return { ...get(), reaction: null, throttled: true };
    touches.push(now());
    saved.lastTouch = { id, part: event.part, kind: event.kind, durationMs: Math.max(0, Math.min(60000, Number(event.durationMs)||0)),
      distance:Math.max(0,Math.min(20000,Number(event.distance)||0)),speed:Math.max(0,Math.min(2000,Number(event.speed)||0)),
      parts:[...new Set((Array.isArray(event.parts)?event.parts:[event.part]).filter(part=>Object.hasOwn(Character.PARTS,part)))].slice(0,7),at: now() };
    saved.interactions.push(saved.lastTouch); saved.interactions = saved.interactions.slice(-20);
    // A touch is an observation. Keep the existing feeling until the AI responds;
    // the rule-based reaction is only a short visual reflex / offline fallback.
    const state = set({ ...get(), gesture: reaction.gesture, duration: reaction.duration, plan: [] }, 'touch');
    seen.set(id, reaction);
    if (seen.size > 100) seen.delete(seen.keys().next().value);
    return { ...state, reaction };
  }
  function reply(text) {
    // Reply completion must not erase a touch made while she was speaking.
    if (['touch', 'manual'].includes(saved.source) && saved.expiresAt > now()) return get();
    return set(Character.guess(text, environment()), 'reply');
  }
  function reset() {
    userVersion++;
    saved = { ...Character.guess('', environment()), accessories: [], at: now(), expiresAt: 0, source: 'environment', interactions: [], revision: saved.revision + 1 };
    save(); return get();
  }
  return { get, set, touch, reply, reset, version: () => userVersion, engage: () => { userVersion++; } };
}

export function characterPrompt(state) {
  return `\n【形象与环境】你使用 DeepSeek-chan 免费公皮。现在情绪=${state.mood}，精神=${state.energy}；已知环境=${JSON.stringify(state.environment)}；最近触摸=${JSON.stringify(state.interactions || [])}。这只是时间/天气/模型触摸，不能据此声称看见真实房间或用户。可用 phone_character 让表情、动作和心情灯同步；害羞可脸红，思考可加载/眼镜，开心可兔牙/爱心眼，担心可冷汗，低落可流泪，讲解可竖食指。前倾用gesture=lean驱动真实LeanInput，靠近用approach（轻轻前倾并靠近镜头），退后用retreat，歪头用tilt；支持平滑进入、保持及回落，可给6到10秒。主人要求动作时应实际执行工具，不以“没有身体”拒绝模型能完成的动作；已收到phone_character成功结果则简短自然接话，不重复触发同一动作。你可以主动戴眼镜、露兔牙、前倾、玩狗尾草、挥手和用眼神回应，不用等主人点面板；衣装和体型保持主人的选择。互动是主人真的碰了你的模型，要结合连点次数和上句话回应，不要照念状态或反复同一句。表演用短动作加停顿再收回，害羞不必每次都是夸张爱心眼。只用存在的选项，不在说话正文里写动作标签。`;
}
