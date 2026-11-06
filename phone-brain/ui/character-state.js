/* Shared by the browser and server. No DOM, network, or saved-state side effects. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HerCharacter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MOODS = {
    calm: { label: '平静', energy: .45, palette: ['#71c9dc', '#9baeea', '#8ed9c7'], face: [], smile: .15 },
    happy: { label: '开心', energy: .7, palette: ['#efc88b', '#eba8bf', '#addbd1'], face: ['兔牙'], smile: .8 },
    curious: { label: '好奇', energy: .6, palette: ['#9bdcbf', '#8dcfe5', '#b7b5e8'], face: [], smile: .2 },
    sleepy: { label: '困了', energy: .15, palette: ['#9793ce', '#747fae', '#b3a6d9'], face: [], smile: .08 },
    annoyed: { label: '有点生气', energy: .65, palette: ['#dd929e', '#dfb18f', '#b28aaa'], face: ['黑脸'], smile: -.6 },
    excited: { label: '兴奋', energy: .95, palette: ['#e7a5ce', '#efd197', '#9bdae0'], face: ['＞＜', '兔牙'], smile: 1 },
    shy: { label: '害羞', energy: .45, palette: ['#eda7bb', '#d8b5df', '#efc6be'], face: ['脸红'], smile: .45 },
    affectionate: { label: '亲近', energy: .55, palette: ['#eab4c8', '#d9bcea', '#b7d9df'], face: ['脸红', '爱心眼'], smile: .7 },
    sad: { label: '低落', energy: .25, palette: ['#8da9d2', '#afa4cb', '#8cbfc8'], face: ['流泪'], smile: -.4 },
    worried: { label: '担心', energy: .45, palette: ['#b4b4ce', '#d3bba5', '#93bccd'], face: ['流冷汗'], smile: -.25 },
    surprised: { label: '惊讶', energy: .8, palette: ['#edcba4', '#d5b9df', '#a4d7dd'], face: ['圈圈眼'], smile: 0 },
    thinking: { label: '思考中', energy: .5, palette: ['#9ac5da', '#b5b4e0', '#b4d4c7'], face: ['加载'], smile: .05 },
    playful: { label: '想逗你', energy: .7, palette: ['#bfc0e9', '#e8b7cc', '#b5dccb'], face: ['屑屑眼'], smile: .7 },
  };
  const PARTS = { head: '头', face: '脸颊', hand: '手', chest: '上身', belly: '肚子', leg: '腿', tail: '尾巴' };
  const EXPRESSIONS = ['体型1', '体型2', '默认体型', '兔牙', '前倾', '加载', '单片眼镜', '圈圈眼', '尾巴开关', '屑屑眼', '流冷汗', '流泪', '爱心眼', '竖食指关', '竖食指开', '胸口衣服', '脱鞋', '脸红', '裙子切换', '钢盆', '黑框眼镜', '黑脸', '＞＜'];
  const GROUPS = {
    eyes: ['圈圈眼', '爱心眼', '＞＜', '屑屑眼'],
    glasses: ['黑框眼镜', '单片眼镜'], body: ['体型1', '体型2', '默认体型'],
    finger: ['竖食指开', '竖食指关'],
  };
  const OUTFITS = ['体型1', '体型2', '默认体型', '尾巴开关', '胸口衣服', '脱鞋', '裙子切换'];
  const GESTURES = ['none', 'nod', 'shake', 'lean', 'approach', 'retreat', 'wave', 'raise', 'grass', 'point', 'lost', 'tilt', 'peek', 'shy', 'think', 'shrug', 'cheer', 'bow', 'yawn', 'listen', 'tease', 'settle'];
  const MOTIONS = { Idle: 'IDLE', RaiseHand: '默认手切举手', LowerHand: '举手切默认手', Grass: '狗尾草切换出来', GrassOff: '狗尾草切回默认手', Point: '竖手指切出来动画', PointOff: '竖手指切回默认', LostTracking: '脱捕' };
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const finite = (v, fallback) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  function expressions(names) {
    const result = [];
    for (const name of Array.isArray(names) ? names.slice(0, 24) : []) {
      if (!EXPRESSIONS.includes(name) || result.includes(name)) continue;
      for (const group of Object.values(GROUPS)) {
        if (group.includes(name)) {
          for (let i = result.length - 1; i >= 0; i--) if (group.includes(result[i])) result.splice(i, 1);
        }
      }
      result.push(name);
    }
    return result;
  }
  function normalize(value = {}) {
    const mood = Object.hasOwn(MOODS, value.mood) ? value.mood : 'calm';
    return {
      mood, energy: clamp(finite(value.energy, MOODS[mood].energy)),
      expressions: expressions(value.expressions),
      gesture: GESTURES.includes(value.gesture) ? value.gesture : 'none',
      duration: clamp(finite(value.duration, 3.2), .8, 15),
      intensity: clamp(finite(value.intensity, .65), .15, 1),
      performanceId: typeof value.performanceId==='string'?value.performanceId.slice(0,100):'',
      plan: (Array.isArray(value.plan) ? value.plan : []).slice(0, 4).filter(b => b && GESTURES.includes(b.gesture)).map(b => ({ at: clamp(finite(b.at, 0), 0, 20), gesture: b.gesture, duration: clamp(finite(b.duration, 2.4), .8, 7), intensity: clamp(finite(b.intensity, .6), .15, 1), expressions: expressions(b.expressions) })).sort((a,b) => a.at-b.at),
    };
  }
  function guess(text, environment = {}) {
    const t = String(text || '');
    let mood = /害羞|脸红|不好意思|别[夸看]|羞/.test(t) ? 'shy'
      : /喜欢你|爱你|抱抱|贴贴/.test(t) ? 'affectionate'
      : /难过|伤心|想哭|失落|呜呜/.test(t) ? 'sad'
      : /担心|别怕|紧张|不安/.test(t) ? 'worried'
      : /哼|烦死|生气|讨厌|别闹|不要碰/.test(t) ? 'annoyed'
      : /困了|睡了|晚安|好累|累了|打个盹/.test(t) ? 'sleepy'
      : /哇|天啊|！！|太棒|好耶/.test(t) ? 'excited'
      : /哈哈|笑死|开心|高兴/.test(t) ? 'happy'
      : /没想到|吓一跳|惊讶/.test(t) ? 'surprised'
      : /让我想|思考|想一想/.test(t) ? 'thinking'
      : /为什么|我看看|奇怪|好像/.test(t) ? 'curious' : 'calm';
    if (mood === 'calm' && (environment.hour < 7 || environment.hour >= 23)) mood = 'sleepy';
    return normalize({ mood });
  }

  /** One reaction per gesture; pointer moves never make API calls. */
  function react(state, event, recent = 0) {
    const part = Object.hasOwn(PARTS, event.part) ? event.part : 'head';
    const rub = event.kind === 'rub';
    const tired = state.mood === 'sleepy';
    const cross = state.mood === 'annoyed' || recent >= 5;
    const close = ['happy', 'affectionate', 'playful', 'excited'].includes(state.mood);
    let mood, text, gesture = 'nod', extra = [];
    if (cross) {
      mood = 'annoyed'; gesture = 'shake'; text = rub ? '先停一下嘛，让我缓缓。' : '哼，再戳我要躲开了。';
    } else if (part === 'head') {
      mood = tired ? 'sleepy' : rub ? (close ? 'affectionate' : 'happy') : 'curious';
      text = tired ? '轻一点……快睡着了。' : rub ? (close ? '嗯……再摸一会儿。' : '头发都要被你揉乱啦。') : '嗯？叫我呀？';
      gesture = rub ? 'lean' : 'nod';
    } else if (part === 'face') {
      mood = close ? 'affectionate' : 'shy'; extra = ['脸红']; gesture = 'lean';
      text = rub ? '脸都被你揉热了……' : '干嘛突然戳我脸。';
    } else if (part === 'hand') {
      mood = close || rub ? 'affectionate' : 'happy'; gesture = rub ? 'raise' : 'wave';
      text = rub ? '牵住了，不许突然松开。' : '在呢，给你挥挥手。';
    } else if (part === 'tail') {
      mood = rub ? 'shy' : 'surprised'; gesture = 'shake';
      text = rub ? '尾巴有点痒……轻一点！' : '呀，尾巴也是有感觉的！';
    } else if (part === 'chest') {
      mood = rub ? 'annoyed' : 'shy'; gesture = rub ? 'shake' : 'lean';
      extra = ['脸红']; text = rub ? '这里不许一直揉，摸摸头就好。' : '突然碰这里，会吓到我的。';
    } else if (part === 'belly') {
      mood = rub ? 'playful' : 'surprised'; gesture = rub ? 'shake' : 'nod';
      extra = rub ? ['＞＜'] : []; text = rub ? '哈哈，好痒，投降啦！' : '你戳到我的肚子啦。';
    } else {
      mood = rub ? 'shy' : 'curious'; gesture = 'shake';
      text = rub ? '这里也会痒的……' : '怎么啦，要一起走走吗？';
    }
    // Offline fallback varies with the actual count. Online interaction is AI-authored.
    const alternatives = {
      head: rub ? ['嗯……头发顺下来了。', '再轻一点，就这样。', '你这是要把我揉困呀。', '好啦，换我看着你。'] : ['嗯？', '又点我，想说什么呀？', '第三下了……我有在看你啦。', '你是不是在给我数头发？'],
      face: ['脸颊也会痒的。', '再戳就要鼓起来了。', '你看，脸都热了。', '让我缓一缓嘛。'],
      hand: ['给你，手在这儿。', '这次要牵多久呀？', '抓住啦。', '我也轻轻碰你一下。'],
      tail: ['呀，尾巴！', '怎么又挑这里……', '尾巴都要躲起来了。', '好痒，轻一点嘛。'],
      belly: ['呀，有点痒。', '还来？我要缩起来啦。', '哈哈，投降。', '换摸摸头好不好？'],
      chest: ['诶，先让我反应一下。', '轻一点……', '这里让我有点不自在。', '先停一停，摸头就好。'],
      leg: ['嗯？怎么碰到这里了。', '有一点痒。', '我可站稳了哦。', '好啦，别一直戳嘛。'],
    };
    const n = Math.max(0, recent | 0);
    text = alternatives[part][n % alternatives[part].length];
    if (cross) { text = ['先停一下嘛。', '我躲……诶，你还追呀。', '让我喘口气再陪你。', '好啦好啦，我真的注意到你了。'][n % 4]; gesture = n % 2 ? 'peek' : 'shake'; }
    else if (part === 'head') gesture = rub ? 'lean' : ['listen','tilt','nod','tease'][n%4];
    else if (part === 'face') gesture = n%2 ? 'shy' : 'tilt';
    else if (part === 'belly') gesture = rub ? 'cheer' : 'peek';
    return { ...normalize({ mood, expressions: [...MOODS[mood].face, ...extra], gesture, duration: rub ? 3.6 : 2.6 }), text, part, kind: rub ? 'rub' : 'tap' };
  }
  return { MOODS, PARTS, EXPRESSIONS, GROUPS, OUTFITS, GESTURES, MOTIONS, clamp, normalize, expressions, guess, react };
});
