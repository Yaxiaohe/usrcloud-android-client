/* 核心层：JS 桥、状态、工具、弹窗 */
var G = {
  tab: 'watch',
  /* 【v0.26】v0.23 加的页签历史栈（tabHist）整条拆掉了。
     用户反馈它「记录了过多行为」：按一次返回落到哪一页要靠脑子想栈，
     和直觉对不上。返回键改成两档固定语义：
       非监控页按返回 → 回监控页；
       监控页按返回   → 退出 app。
     见下面 onNativeBack 的注释。 */
  accounts: [],
  picked: {},        // 账号名 -> true
  health: null,
  seq: 0,
  /* v0.22：日志改成按 seq 去重合并。
     logBuf = 展示用的 [{s:seq, t:行}]，logSeen = 去重表，logSeq = 日志页自己的游标。
     seq（巡站页游标）与 logSeq 独立，两个页不再互相抢日志。 */
  logSeq: 0,
  logBuf: [],
  logSeen: {},
  ws: null,          // watchState
  hist: null,        // histGet 结果
  histAcc: '',
  histNo: '',
  histName: '',
  rules: null,
  /* 【v0.35】变量置顶清单（行序 = 优先级）。监控/截图/历史三处共用，
     真正的排序在 Java 侧算，这里只是给「我的」页显示摘要用。 */
  vars: [],
  /* 【v0.36】置顶站名清单（行序 = 优先级）。监控页设备列表、历史页选设备、
     截图列表三处共用。同样只做展示摘要，真正的排序在 Java 侧读 sitesort.csv。 */
  devPins: [],
  devCache: {},      // acc -> [{no,name}]
  busy: false,
  /* 【v0.31 修订】本轮巡站的编号（后端 run/status 都带 run_id）。
     用来把「上一轮的残留状态」和「本轮的进度」区分开 ——
     没有它就分不清 status 回来的 finished=true 到底是刚跑完还是上一轮的。 */
  runId: 0
};

var TABS = [
  { k: 'watch',  t: '监控', i: 'data',   s: '实时状态' },
  { k: 'patrol', t: '巡站', i: 'device', s: '一键截图' },
  { k: 'hist',   t: '历史', i: 'clock',  s: '曲线查询' },
  { k: 'log',    t: '日志', i: 'folder', s: '运行输出' },
  { k: 'me',     t: '我的', i: 'user',   s: '账号与设置' }
];

/* ---------- 桥接 ---------- */
function api(m, o) {
  try {
    var s = Android.call(m, JSON.stringify(o || {}));
    return JSON.parse(s);
  } catch (e) {
    return { ok: false, msg: '调用失败: ' + e };
  }
}

function icon(n, on) {
  return 'icons/' + n + '_' + (on ? 'blue' : 'grey') + '.png';
}

function $(s) { return document.querySelector(s); }

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 置顶排序（v0.36） ----------
 * 与 Java 侧 PinList.indexOf 同一口径：包含匹配、大小写不敏感、取最靠前的关键词。
 *
 * 为什么 JS 侧还要留一份：截图列表是纯前端渲染的（Java 只给文件路径），
 * 没有经过 DevOrder.sortItems。两处口径必须一致，否则「我的」页写着顶上了、
 * 截图列表看不到效果 —— 用户会以为是功能坏了。
 */
function pinIndexOf(pins, name) {
  if (!pins || !pins.length) return -1;
  var s = String(name == null ? '' : name).toLowerCase();
  if (!s) return -1;
  for (var i = 0; i < pins.length; i++) {
    var k = String(pins[i] == null ? '' : pins[i]).trim().toLowerCase();
    if (!k) continue;
    if (s.indexOf(k) >= 0) return i;
  }
  return -1;
}

/* 稳定排序：命中的按清单行序在前，其余保持调用方给的原序。
   显式拿原下标做兜底比较，不依赖 Array.sort 的实现是否稳定。 */
function pinSort(list, pins, nameOf) {
  var src = (list || []).slice();
  if (!pins || !pins.length) return src;
  var arr = src.map(function (it, i) {
    return { it: it, i: i, k: pinIndexOf(pins, nameOf ? nameOf(it) : it) };
  });
  arr.sort(function (a, b) {
    if (a.k < 0 && b.k < 0) return a.i - b.i;
    if (a.k < 0) return 1;
    if (b.k < 0) return -1;
    if (a.k !== b.k) return a.k - b.k;
    return a.i - b.i;
  });
  return arr.map(function (x) { return x.it; });
}

/* ---------- toast ---------- */
var tTid = null;
function toast(m) {
  var t = el('toast');
  if (!t) return;
  t.textContent = m;
  /* 【v0.36 修订】弹窗打开时提示条挪到上方。
     原来固定 bottom:88px，而弹窗是垂直居中的（最高 86vh），
     于是提示正好压在弹窗底部的「完成 / 保存」按钮上 ——
     用户点完按钮看到一条提示盖住刚点的位置，像两个层叠在一起打架。
     现在有弹窗就贴到顶部，谁也不遮谁。 */
  var mask = el('mask');
  var over = !!(mask && mask.className.indexOf('on') >= 0);
  t.className = over ? 'on top' : 'on';
  if (tTid) clearTimeout(tTid);
  tTid = setTimeout(function () { t.className = ''; }, 2200);
}

function okOf(r, def) {
  return r && r.ok ? (r.msg || def || '成功') : ((r && (r.msg || r.error)) || '失败');
}

/* ---------- 滚动 ----------
 * scrollIntoView 带选项对象在老 WebView 上不可靠：
 * minSdk 21 对应的 Chromium 版本不一定认 behavior/block，
 * 认了也可能静默不滚。所以先试原生，失败或无效就退回 scrollTop。 */
function scrollTo_(node, top) {
  if (!node) return;
  try {
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  } catch (e) { /* 落到下面手写 */ }
  /* 手动滚动：找到最近的可滚动祖先 */
  var box = node.closest ? node.closest('.mboxbody') : null;
  (box || document.documentElement).scrollTop = top;
}

/* ---------- 弹窗 ---------- */
function closeBox() {
  el('mask').className = '';
  el('mbox').innerHTML = '';
}

/* 弹窗结构固定为：标题 + 可滚动内容区 + 固定底部按钮区。
 *
 * 为什么要拆成三层：原来 #mbox 整体 overflow-y:auto，
 * 标题、内容、按钮在同一个滚动容器里。列表一长（选站点、选设备），
 * 底部「取消/查询」就被顶到可视区外，得一路滚到底才看得见，
 * 看着就像按钮消失了。
 *
 * 所以把结尾的 .two 按钮块摘出来放到 .mboxfoot（flex 不参与滚动），
 * 中间内容包进 .mboxbody 独立滚动。7 处 openBox 调用点都不用改。
 */
function openBox(title, html, onOk, onOpen) {
  var m = el('mbox');
  var body = html || '';
  var foot = '';

  /* 结尾的 <div class="two" ...>...</div> 就是底部按钮区。
     顺手摘掉它自带的 style="margin-top:NNpx"，间距交给 CSS 统一控制。 */
  var fm = body.match(/(<div class="two"[^>]*>[\s\S]*<\/div>)\s*$/);
  if (fm) {
    foot = fm[1].replace(/\s*style="[^"]*"/, '');
    body = body.slice(0, fm.index);
  }

  m.innerHTML = '<h3>' + esc(title) + '</h3>' +
    '<div class="mboxbody">' + body + '</div>' +
    (foot ? '<div class="mboxfoot">' + foot + '</div>' : '');
  el('mask').className = 'on';
  if (onOk) {
    m.querySelectorAll('[data-ok]').forEach(function (b) {
      b.onclick = function () {
        if (onOk() !== false) closeBox();
      };
    });
  }
  m.querySelectorAll('[data-no]').forEach(function (b) {
    b.onclick = closeBox;
  });
  /* 内容必须在 DOM 落地后才能操作（量尺寸、设 src），所以给一个落地回调。
     用 try/catch 包住：回调里出错不能连带弹窗打不开。 */
  if (onOpen) {
    try {
      onOpen(m);
    } catch (e) {
      if (window.console) console.error('openBox onOpen: ' + e);
    }
  }
}

/* 【v0.26】点弹窗外围（#mask 的空白处）也能关弹窗。
 * 用户反馈「点击弹窗外围也没退出动作」。只认 e.target === mask 本身：
 * 点在弹窗内部（mbox 及其子元素）不算外围 —— 事件会冒泡到 mask，
 * 不判 target 的话在弹窗里点任何地方都会被直接关掉。 */
(function () {
  var mk = document.getElementById('mask');
  if (mk) mk.addEventListener('click', function (e) {
    if (e.target === mk && typeof closeBox === 'function') closeBox();
  });
})();

function confirmBox(title, text, onYes) {
  openBox(title,
    '<p style="margin:0 0 16px;font-size:14px">' + esc(text) + '</p>' +
    '<div class="two"><button data-no>取消</button>' +
    '<button class="pri" data-ok>确定</button></div>',
    function () { onYes(); });
}

/* ---------- 状态色 ---------- */
function stPill(s) {
  if (s === 'online') return '<span class="pill g">在线</span>';
  if (s === 'stale') return '<span class="pill y">数据陈旧</span>';
  if (s === 'offline') return '<span class="pill r">离线</span>';
  return '<span class="pill r">采集异常</span>';
}
function stText(s) {
  if (s === 'online') return '在线';
  if (s === 'stale') return '数据陈旧';
  if (s === 'offline') return '离线';
  return '采集异常';
}

/* ---------- 底部导航 ---------- */
function buildNav() {
  el('nav').innerHTML = TABS.map(function (t) {
    return '<div class="tab' + (G.tab === t.k ? ' on' : '') + '" data-tab="' + t.k + '">' +
      '<img src="' + icon(t.i, G.tab === t.k) + '" alt="">' +
      '<span>' + t.t + '</span></div>';
  }).join('');
  el('nav').querySelectorAll('.tab').forEach(function (n) {
    n.onclick = function () { go(n.getAttribute('data-tab')); };
  });
}

function go(k) {
  /* 【v0.26 简化】原来这里往页签历史栈压格子（v0.23 加的），
     用户明确说不要这套「记过多行为」的行为，返回键固定两档：
     非监控页 → 回监控页；监控页 → 退出。栈没了，go 退化成直接切。 */
  goNoHist(k);
}

/* go() 的不记历史版本，供返回键使用 */
function goNoHist(k) {
  G.tab = k;
  /* 【v0.23】切页就落盘，下次启动回到这一页而不是回监控 */
  try { localStorage.setItem('xunjian.tab.v1', k); } catch (e) { }
  var t = TABS.filter(function (x) { return x.k === k; })[0];
  el('htitle').textContent = k === 'me' ? '我的' : t.t;
  el('hsub').textContent = t.s;
  buildNav();
  render();
  el('main').scrollTop = 0;
  stopPoll();
  if (k === 'log') startPoll(900);
  /* 【v0.36 修订六】监控页的定时器不再「立刻补一拍」。
     上面 render() 已经拉过一份 watchState、整页也画完了；
     startPoll 里再 tick 一次 = 同一份数据再拉一遍 + 列表再推倒重建一遍。
     94 台设备时，这一下就是切页卡顿里最贵的一段（详见 _watch.js 的 patchDevList）。 */
  if (k === 'watch') startPoll(3000, true);
}

function render() {
  var f = window['V_' + G.tab];
  if (f) f();
}

/* 【v0.26 新增】原生返回键统一入口，返回 'exit' 表示交回原生去关 app。
 *
 * 优先级从高到低：
 * 1. 有弹窗开着 → 关掉。这一条必须排最前 ——
 *    用户在「选择要导出的图片」里按返回，期望是关弹窗而不是退出软件。
 * 2. 不在监控页 → 回监控页。
 * 3. 已经在监控页 → 返回 'exit'，这才是用户主动想退出。
 *
 * 【v0.26 简化】原来第 2 档是「退回历史栈里的上一个页签」（v0.23 加的），
 * 用户反馈栈的行为「记录了过多行为」—— 按返回落到哪一页要靠想栈，
 * 和直觉对不上。定稿成两档：任何非监控页按返回都一步回监控页，
 * 不再记路。弹窗优先级不变。 */
window.onNativeBack = function () {
  var m = document.getElementById('mask');
  if (m && m.className.indexOf('on') >= 0) {
    if (typeof closeBox === 'function') closeBox();
    return 'handled';
  }
  if (G.tab !== TABS[0].k) {
    goNoHist(TABS[0].k);
    return 'handled';
  }
  return 'exit';
};

/* ---------- 轮询 ---------- */
var pTid = null;
/* skipTick=true：只装定时器，不当场跑一拍。
   进页面时调用方通常刚拉完数据（V_watch → pollWatch），
   再补一拍就是重复请求 + 重复渲染。 */
function startPoll(ms, skipTick) {
  stopPoll();
  pTid = setInterval(tick, ms);
  if (!skipTick) tick();
}
function stopPoll() {
  if (pTid) { clearInterval(pTid); pTid = null; }
}
function tick() {
  if (G.tab === 'log') pollLog();
  if (G.tab === 'watch') softWatch();
}
