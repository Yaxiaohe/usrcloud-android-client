/* 监控页 */
var IVS = [
  { v: 300, t: '5分钟' }, { v: 900, t: '15分钟' }, { v: 1800, t: '30分钟' },
  { v: 3600, t: '1小时' }
];
var kwWatch = '';
/* 统计条筛选状态：''=不筛，online/stale/offline/blank=按状态筛。
   和搜索框是「与」的关系：先按状态筛，再按关键词筛。 */
var stFilter = '';

function V_watch() {
  if (G.tab !== 'watch') return;
  pollWatch(true);
}

/* 统计条里「可点」的格子。
 * 点一下就把下方设备列表筛到该状态，再点同一个取消。
 * 总数格是「清除筛选」；提醒数对应的是告警条数而不是设备状态，
 * 所以单独一类：点了滚到「异常提醒」卡片去，不做设备筛选。 */
function stCellTap(v, t, c, kind, key) {
  var cls = '';
  if (kind === 'st' && stFilter === key) cls += ' on';
  if (v == null || v === 0) cls += ' zero';
  return '<div data-st="' + kind + '" data-key="' + key + '"' +
    (cls ? ' class="' + cls.trim() + '"' : '') + '>' +
    '<b style="color:' + c + '">' + (v == null ? 0 : v) + '</b><span>' + t + '</span></div>';
}

/* 统计条 HTML。total 可点（清除筛选），四种状态可点（筛选），提醒可点（滚到提醒区） */
function statBar(m) {
  return '<div class="stat" id="statBar">' +
    stCellTap(m.total, '总数', '#39404d', 'all', '') +
    stCellTap(m.online, '在线', '#12a19a', 'st', 'online') +
    stCellTap(m.stale, '陈旧', '#d98a00', 'st', 'stale') +
    stCellTap(m.offline, '离线', '#d33d3d', 'st', 'offline') +
    stCellTap(m.blank, '异常', '#7c5cff', 'st', 'blank') +
    stCellTap(m.alerts, '提醒', '#e0518a', 'alerts', 'alerts') +
    '</div>';
}

function pollWatch(ret) {
  if (G.tab !== 'watch' && ret) return null;
  var r = api('watchState', {});
  if (!r.ok) {
    if (ret) el('main').innerHTML = '<div class="bar w">⚠ ' + esc(r.msg || '读取失败') + '</div>';
    return null;
  }
  G.ws = r;
  if (ret) renderWatch();
  return r;
}

/* 记录当前展开的设备行。
 * softWatch 每次轮询都会重建 #devList，展开态会丢，
 * 所以记在全局里，重绘后由 devListBody 还原。 */
var openDev = {};

/* 【v0.22】模块折叠状态。
   异常提醒 14 条会把设备列表整个挤出屏幕，「这些异常不会提醒」也是同理 ——
   后者本身只是个提示，更不该长期占着一大块。
   两块都默认折叠，标题栏右侧显示条数，需要时点开。
   存在内存即可，不进 localStorage：这是当次查看的临时需要，
   每次进来都从折叠态开始反而清爽。 */
var fold = {};

/* 【v0.30】「上次巡检」文案。抽成纯函数：
   整页渲染(renderWatch) 和后台增量刷新(softWatch) 必须用同一口径，
   否则两处各写各的，很容易出现「切页进来是对的、留在页面上不刷新」这种分裂。
   用户反馈的正是这个：巡检完成后右上角一直显示「未巡检」，非要切页面才变。 */
function lastScanText(m) {
  if (m.scanning) return '巡检中…';
  if (!m.last_scan) return '未巡检';
  /* 【v0.33 修订八】带上「多久之前」：只写「上次 20:29」时，
     用户得自己跟状态栏对时才能发现已经过了 19 分钟。 */
  var ms = parseDataTime(m.last_scan);
  var ago = ms < 0 ? '' : '（' + Math.round((Date.now() - ms) / 60000) + ' 分钟前）';
  return '上次 ' + esc(String(m.last_scan).replace('T', ' ').slice(5, 16)) + ago;
}

/* 【v0.33 修订八】超期提示文案；没超期返回 null。
 *
 * 用户报「十五分钟的周期怎么会出现 20 分钟前」，其实是两件事叠在一起：
 *   ① 行首「20 分钟前」是**数据年龄**（设备最后上报距今），设备本身可能
 *      好几分钟才上报一次，所以数字可以超过轮询周期；
 *   ② 但「上次巡检」也已经 19 分钟没动了，超过设定的 15 分钟 ——
 *      app 在后台/锁屏时系统会冻结定时器，回来又没补跑。
 * ①是事实，②是问题。后端已加「回前台超期补跑」（Watch.catchUpIfOverdue），
 * 这里负责把②的状态摊开说，别让用户对着两个数字自己猜。
 */
function overdueText(m) {
  var ms = parseDataTime(m.last_scan);
  if (ms < 0) return null;
  var iv = m.interval || 900;
  var sec = (Date.now() - ms) / 1000;
  if (sec <= iv + 60) return null;      // 留 60 秒余量，别因为几秒抖动就报警
  /* 只说算得出的事实（距上次巡检多少分钟 / 你设的周期多少分钟），
     不写「因为是系统推迟」这种没当场证据的原因 —— 原因在日志页里查。 */
  return '距上次巡检已 ' + Math.round(sec / 60) + ' 分钟，超过你设的 ' +
    Math.round(iv / 60) + ' 分钟周期。回到前台会自动补跑一轮，' +
    '也可以点「立即巡检」马上跑；原因看「日志」页（每轮都记了用时和异常）。';
}

/* 后台轮询：只刷统计条和设备列表，不动搜索框（避免打断输入） */
function softWatch() {
  if (G.tab !== 'watch') return;
  var r = pollWatch(false);
  if (!r) return;
  var m = r.summary || {};
  /* 统计条：后台轮询后要刷新数字，并保留用户已选中的高亮。
     整条换掉后必须重新 bindStat()，因为事件是直接绑在格子上的。 */
  var sb = el('statBar');
  if (sb) {
    var tmp = document.createElement('div');
    tmp.innerHTML = statBar(m);
    sb.parentNode.replaceChild(tmp.firstChild, sb);
    bindStat();
  }
  var tg = el('wToggle');
  if (tg) {
    tg.className = m.enabled ? 'dan' : 'ok';
    tg.textContent = m.enabled ? '⏹ 停止监控' : '▶ 启动监控';
  }
  var sc2 = el('wScan');
  if (sc2) {
    sc2.disabled = !!m.scanning;
    sc2.textContent = m.scanning ? '巡检中…' : '⟳ 立即巡检';
  }
  /* 进度文案：扫描进行中实时刷新，扫完清空（后端扫完会把 progress 置 null） */
  var pg = el('wProg');
  if (pg) pg.textContent = (m.scanning && m.progress) ? m.progress : '';
  /* 【v0.31】新一轮巡检跑完，restored 变 false —— 把「这是上次保存的结果」收起来，
     否则用户明明刚巡检完，页面上还挂着「本次启动后还没巡检」。
     只做隐藏不做新增：这个元素只在首屏 restored 为真时才渲染出来，
     之后不会再由假变真。 */
  var rs2 = el('wRestored');
  if (rs2) rs2.style.display = m.restored ? '' : 'none';
  /* 【v0.30】「上次巡检」也要跟着后台轮询刷新。
     之前这里没刷，扫完一轮后右上角一直停在「未巡检」，
     必须切到别的页再切回来（走整页 renderWatch）才更新 —— 就是用户报的
     「不自动更新，只能通过切换界面才有变化」。 */
  var ls = el('wLast');
  if (ls) ls.textContent = lastScanText(m);
  /* 【v0.33 修订八】超期提示跟着 3 秒轮询走：页面停着不动时，
     刚进来还不超期，过了几分钟就该提示了。 */
  var ov = el('wOverdue');
  if (ov) {
    var od2 = overdueText(m);
    ov.textContent = od2 || '';
    ov.style.display = od2 ? '' : 'none';
  }
  /* 设备列表：只替换 #devList，搜索框不动。
     替换 innerHTML 会连同 onclick 一起冲掉，
     所以换完必须重新绑定 bindDevRows()，否则设备行点不动。

     标题里的台数也必须一起刷 —— v0.13 之前只刷列表不刷标题，
     于是标题一直卡在首次进页面时的「0 台」而列表里明明有数据。 */
  var box = el('devList');
  if (box) {
    box.innerHTML = devListBody();
    bindDevRows();
  }
  var cnt = el('dvCnt');
  if (cnt) cnt.textContent = filteredDevs().length + ' 台';
  startAgeTicker();
}

/* 当前要显示的设备：先按统计条状态筛，再按搜索框关键词筛。
   所有地方（列表、计数、空状态）都走这一个函数，别各算各的。 */
/* 【v0.22】按名字找设备号。
   提醒条目里只存了设备名（a.dev），设备列表的 key 是设备号（d.no），
   所以要点「看实时数据」就得先由名字反查设备号。
   优先在当前已加载的列表里找；找不到时扩大到 G.ws.devices 全量，
   再不行返回 null，由调用方给出明确提示而不是静默失败。 */
function findDevNo(name, acc) {
  if (!name) return null;
  var dv = (G.ws && G.ws.devices) || [];
  var hit = null;
  dv.forEach(function (d) {
    if (hit) return;
    if (d.name !== name) return;
    /* 同名设备在多个账号下时，优先取提醒里标的那个账号 */
    if (acc && d.acc && d.acc !== acc) return;
    hit = d.no;
  });
  if (!hit) {
    dv.forEach(function (d) { if (!hit && d.name === name) hit = d.no; });
  }
  return hit;
}

/* CSS 选择器里要转义引号。设备号一般是字母数字和连字符，
   但拼接进 [data-dvno="..."] 之前还是转义一次，避免个别特殊字符把选择器搞坏。 */
function cssEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function filteredDevs() {
  var dv = (G.ws && G.ws.devices) || [];
  var list = dv;
  if (stFilter) {
    list = list.filter(function (d) { return d.status === stFilter; });
  }
  if (kwWatch) {
    var q = kwWatch.toLowerCase();
    list = list.filter(function (d) {
      return ((d.name || '') + (d.acc || '')).toLowerCase().indexOf(q) >= 0;
    });
  }
  return list;
}

/* 【v0.33 修订七】「多久之前」必须**现算**，不能照抄后端给的字符串。
 *
 * 用户截图里的现象：状态栏 10:43，5 号站行首写着「刚刚」，可展开后
 * 数据时间明明白白是 10:39 —— 同一个站点的两个说法自相矛盾。
 *
 * 根因：age_text 是后端在**巡检那一刻**算好的静态字符串
 * （Watch.stateJson 里 fmtAge(s.ageMin)，s.ageMin 也是扫描时算的）。
 * 前端拿到什么就显示什么，两轮轮询之间它一直冻在那里：
 * 10:39 巡检时数据刚上来，算出来是「刚刚」；到 10:43 还是「刚刚」。
 *
 * 现在改成：渲染时用 data_time 现算，另有 tickAges() 每 30 秒刷一次，
 * 页面停着不动、文案也会自己走。
 */
function parseDataTime(s) {
  /* 统一成 ISO 形态再交给 Date：'2026-10-18 10:39:00' → '2026-10-18T10:39:00'。
     WebView(V8) 按**本地时区**解析，与 Java 侧 SimpleDateFormat 口径一致。
     带 T 的（部分快照/测试数据）原样可用；解析不了返回 -1。 */
  if (!s || s === '--') return -1;
  var t = new Date(String(s).replace(' ', 'T')).getTime();
  return isNaN(t) ? -1 : t;
}

/* 与 Java DevData.fmtAge 一字不差的口径 —— 两边说法不能打架 */
function fmtAgeText(min) {
  if (min < 0) return '无数据时间';
  if (min < 0.5) return '刚刚';
  if (min < 60) return Math.round(min) + ' 分钟前';
  if (min < 60 * 24) return (min / 60).toFixed(1) + ' 小时前';
  return (min / 60 / 24).toFixed(1) + ' 天前';
}

/* data_time → 「多久之前」。解析不了返回 null，调用方退回后端 age_text */
function ageTextOf(t) {
  var ms = parseDataTime(t);
  if (ms < 0) return null;
  return fmtAgeText((Date.now() - ms) / 60000);
}

/* 每 30 秒把页面上所有 [data-age-t] 重算一遍。
   只动这一句文案，不碰状态色块 —— 在线/陈旧/离线的阈值在后端，
   前端擅自改判定会和用户设置的阈值对不上。

   用「自适应 setTimeout 链」而不是 setInterval：
   离开监控页后下一次触发发现 tab 不对就停，不再空转；
   回到监控页由 renderWatch/softWatch 重新挂上。 */
var ageTid = null;
function tickAges() {
  var nodes = document.querySelectorAll('[data-age-t]');
  for (var i = 0; i < nodes.length; i++) {
    var tx = ageTextOf(nodes[i].getAttribute('data-age-t'));
    if (tx !== null && nodes[i].textContent !== tx) nodes[i].textContent = tx;
  }
}
function startAgeTicker() {
  if (ageTid !== null) return;
  ageTid = setTimeout(function () {
    ageTid = null;
    if (G.tab !== 'watch') return;   // 已经离开监控页：停，别空转
    tickAges();
    startAgeTicker();                // 还在页面上：继续下一拍
  }, 30000);
}

function devListBody() {
  var dv = (G.ws && G.ws.devices) || [];
  if (!dv.length) {
    /* 【v0.27】一个账号都没有的时候，「点立即巡检跑一次」是句废话 ——
       没有账号跑也是空的。存在不带预置账号的版本，这条提示必须有。 */
    if (!(G.accounts || []).length) {
      return '<div class="empty">还没有账号<br><span class="tiny">' +
        '去「我的」页添加账号后再巡检</span></div>';
    }
    return '<div class="empty">还没有数据<br><span class="tiny">点「立即巡检」跑一次</span></div>';
  }
  var list = filteredDevs();
  if (!list.length) {
    return '<div class="empty">' + emptyWhy() + '</div>';
  }
  return '<div style="margin-top:10px">' + list.map(function (d) {
    /* 展开态由 openDev 还原，避免后台轮询把用户点开的行合上 */
    var open = openDev[d.no] ? ' open' : '';
    /* 【v0.33 修订七】「多久之前」现算（见 ageTextOf 上方注释）。
       能解析 data_time 就挂 data-age-t，交给 tickAges 定时刷新；
       解析不了才退回后端 age_text —— 老快照里可能没有 data_time。 */
    var at = ageTextOf(d.data_time);
    return '<div class="dv' + open + '" data-dvno="' + esc(d.no) + '">' +
      '<div class="h"><span class="nm">' + esc(d.name) + '</span>' +
      stPill(d.status) +
      '<span class="tiny muted"' +
      (at === null ? '' : ' data-age-t="' + esc(d.data_time) + '"') + '>' +
      esc(at === null ? (d.age_text || '') : at) + '</span>' +
      '<span class="ar">⌄</span></div>' +
      '<div class="tiny muted">' + esc(d.acc) + '</div>' +
      '<div class="vars">' +
      /* 【v0.32】「刷新这台」从展开区左下挪到右上：展开后第一眼就看到，
         不用穿过整张变量表滚到底才找得到。数据时间留在按钮左边同排。
         按钮带 data-dvrf 由事件委托处理，避免每轮重建 innerHTML 后 onclick 丢绑。 */
      '<div class="row" style="margin:2px 0 6px">' +
      '<span class="tiny muted" data-dvrfmsg="' + esc(d.no) + '">' +
      (d.data_time && d.data_time !== '--' ? '数据时间 ' + esc(String(d.data_time).replace('T', ' ').slice(5, 16)) : '') +
      '</span><span class="sp"></span>' +
      '<button class="sm" data-dvrf="' + esc(d.no) + '" data-dvacc="' + esc(d.acc) + '">' +
      '⟳ 刷新这台</button></div>' +
      rowsTable(d.rows, d) +
      '</div></div>';
  }).join('') + '</div>';
}

/* 空列表时说清楚是被什么筛掉的，不然用户以为程序坏了 */
function emptyWhy() {
  var m = (G.ws && G.ws.summary) || {};
  if (stFilter) {
    var names = { online: '在线', stale: '陈旧', offline: '离线', blank: '异常' };
    var n = names[stFilter] || stFilter;
    if (kwWatch) return '没有「' + n + '」设备里包含「' + esc(kwWatch) + '」的';
    return '当前没有「' + n + '」的设备（' + (m[stFilter] || 0) + ' 台）';
  }
  if (kwWatch) return '没有匹配「' + esc(kwWatch) + '」的设备';
  return '没有设备';
}

/* 设备列表卡片标题。
   数字必须跟着筛选走，且后台轮询后也要刷新 —— 原来这里只在 renderWatch 里算一次，
   导致标题一直显示首次进页面时的「0 台」而列表里明明有数据。 */
function devListTitle() {
  var names = { online: '在线', stale: '陈旧', offline: '离线', blank: '异常' };
  var t = '设备状态';
  if (stFilter) t += ' · ' + (names[stFilter] || stFilter);
  if (kwWatch) t += ' · 搜「' + esc(kwWatch) + '」';
  return t;
}

function buildDevList() {
  return '<div class="card"><h2><span id="dvTitle">' + esc(devListTitle()) + '</span>' +
    '<span class="r" id="dvCnt">' + filteredDevs().length + ' 台</span></h2>' +
    '<input id="wSearch" placeholder="搜索设备名或账号" value="' + esc(kwWatch) + '">' +
    '<div id="devList">' + devListBody() + '</div></div>';
}

/* 只更新列表 + 计数 + 标题 + 统计条高亮，不整页重画。
   整页 renderWatch 会把提醒卡片、按钮状态全刷一遍，
   用户正在看的东西会闪，所以筛选变化走这条轻量路径。 */
function repaintDevList() {
  var box = el('devList');
  if (box) {
    box.innerHTML = devListBody();
    bindDevRows();
  }
  var cnt = el('dvCnt');
  if (cnt) cnt.textContent = filteredDevs().length + ' 台';
  var ttl = el('dvTitle');
  if (ttl) ttl.textContent = devListTitle();
  /* 统计条高亮：只改 class，不动 DOM 结构 */
  var sb = el('statBar');
  if (sb) {
    sb.querySelectorAll('[data-st]').forEach(function (n) {
      var k = n.getAttribute('data-key');
      var kind = n.getAttribute('data-st');
      n.className = (kind === 'st' && stFilter === k) ? 'on' : '';
    });
  }
  var se = el('wSearch');
  if (se && se.value !== kwWatch) se.value = kwWatch;
}

function renderWatch() {
  /* 异步回调可能落在别的页面上（如巡检 1.5s 后才返回），必须挡住，
     否则会把用户当前页面覆盖掉 */
  if (G.tab !== 'watch') return;
  var r = G.ws;
  if (!r) return;
  var m = r.summary || {};
  var s = '';

  /* 统计条：数字可点，点一下筛选下方设备列表 */
  s += statBar(m);

  /* 开关 */
  s += '<div class="card"><h2>监控引擎' +
    '<span class="r" id="wLast">' + lastScanText(m) + '</span></h2>';

  s += '<div class="row" style="margin-bottom:11px"><span style="font-size:13.5px">轮询间隔</span>' +
    '<span class="sp"></span></div><div class="seg" id="ivSeg">' +
    IVS.map(function (x) {
      return '<div class="s' + (m.interval === x.v ? ' on' : '') + '" data-iv="' + x.v + '">' +
        x.t + '</div>';
    }).join('') + '</div>';

  s += '<div class="two" style="margin-top:12px">' +
    '<button class="' + (m.enabled ? 'dan' : 'ok') + '" id="wToggle">' +
    (m.enabled ? '⏹ 停止监控' : '▶ 启动监控') + '</button>' +
    '<button id="wScan"' + (m.scanning ? ' disabled' : '') + '>' +
    (m.scanning ? '巡检中…' : '⟳ 立即巡检') + '</button></div>';
  /* 【v0.29】扫描进度：正在巡检时显示「已巡检 X / Y 台」，让「点了没反应」的
     困惑消失 —— 之前按钮只变「巡检中…」，长时间扫描时用户以为卡死了。 */
  s += '<div class="muted tiny" id="wProg" style="margin-top:8px;min-height:16px;color:#3a7bd5">' +
    ((m.scanning && m.progress) ? esc(m.progress) : '') + '</div>';
  s += '<div class="muted tiny" style="margin-top:6px">' +
    '启动后每 ' + fmtIv(m.interval) + '自动巡检一次，命中规则时推送提醒并写入历史数据。' +
    '点「立即巡检」只跑一次、不计入自动周期。</div>';
  /* 【v0.33 修订八】超期提示：距上次巡检超过一个周期才出现。
     平时不渲染文字（display:none），softWatch 每 3 秒按最新时间重算。 */
  var od = overdueText(m);
  s += '<div class="bar w" id="wOverdue" style="margin-top:10px' +
    (od ? '' : ';display:none') + '">' + (od ? esc(od) : '') + '</div>';
  /* 【v0.31】列表来自磁盘快照时必须说清楚。
     用户提出「每次重开 app 监控页站点信息都是空的」→ 现在改成读上次的结果，
     但这样一来屏幕上是一份**旧数据**：不说明的话，用户会把几个小时前的值
     当成刚巡检出来的，反而更容易误判。新一轮巡检跑完 restored 变 false，
     softWatch 会把这条提示收起来。 */
  if (m.restored) {
    s += '<div class="bar w" id="wRestored" style="margin-top:10px">' +
      '上面这些是<b>上次保存的结果</b>，本次启动后还没巡检。' +
      '点「立即巡检」或展开站点点「刷新这台」可以拉最新的。</div>';
  }
  s += '</div>';

  /* 提醒 */
  var al = r.alerts || [];
  if (al.length) {
    /* 【v0.22 新增】折叠 + 可点击。
       两点都是用户提的：
       - 「14 条」直接铺满屏幕，真正的设备列表被挤到看不见
       - 点提醒条目想看那台设备的实时数据，结果什么都不发生，
         得自己在下面几十条设备里翻找 —— 提醒本来就是从设备来的，
         顺着点过去看详情才符合直觉。
       折叠态记在 fold 里，默认折叠；条目带 data-alno，点开对应设备。 */
    var aOpen = fold.alerts ? ' open' : '';
    s += '<div class="card" id="alertCard">' +
      '<h2 class="foldh" data-fold="alerts">异常提醒' +
      '<span class="r">' + al.length + ' 条</span>' +
      '<span class="ar">' + (fold.alerts ? '⌄' : '⌃') + '</span></h2>' +
      '<div class="foldbody' + aOpen + '">';
    al.slice(0, 20).forEach(function (a) {
      s += '<div class="al clickable' + (a.level === 'critical' ? ' c' : '') + '"' +
        ' data-aldev="' + esc(a.dev) + '" data-alacc="' + esc(a.acc) + '">' +
        '<div class="t">' + esc(a.time) + ' · ' + esc(a.acc) + '</div>' +
        /* 【v0.33】用户给规则起的名字显示在设备名前面 —— 与通知标题同名，
           提醒多起来时一眼能认出是哪条规则报的。老提醒没有这个字段，跳过。 */
        '<div class="m">' + (a.rule_name ? esc(a.rule_name) + ' · ' : '') +
        esc(a.dev) + (a.var && a.var !== '*' ? ' / ' + esc(a.var) : '') + '</div>' +
        '<div class="s" style="font-size:12.5px;color:#5c6472">' + esc(a.msg) + '</div>' +
        '<div class="almore tiny muted">点这条看该站点实时数据 ›</div></div>';
    });
    s += '<div class="two" style="margin-top:6px">' +
      '<button class="sm" id="alRead">标为已读</button>' +
      '<button class="sm dan" id="alClear">清空提醒</button></div>' +
      '</div></div>';
  }

  /* 【v0.18】覆盖情况提示。
     用户反馈「消息提醒不提示示例账号的站点」——
     真因是他的规则都是指定账号的数值越限类，
     示例账号名下设备一条都没匹配上，所以一条提醒都不发。
     但统计条只写「离线 1 / 陈旧 3」，不说明这些异常没人管，
     用户只能自己把设备和规则对上，对不上就只能认为功能坏了。
     这里主动说明，点一下直接跳去加规则。
     【v0.22】同提醒卡片，默认折叠 —— 这个只是提示，不需要一直占大块屏幕。 */
  var unc = r.uncovered || {};
  var uncKeys = Object.keys(unc);
  if (uncKeys.length) {
    var det = uncKeys.map(function (a) {
      var one = unc[a] || {};
      var t = [];
      if (one.stale) t.push('数据陈旧 ' + one.stale);
      if (one.offline) t.push('离线 ' + one.offline);
      if (one.blank) t.push('采集异常 ' + one.blank);
      return esc(a) + '：' + t.join(' · ');
    }).join('<br>');
    var uOpen = fold.unc ? ' open' : '';
    s += '<div class="card warncard" id="uncCard">' +
      '<h2 class="foldh" data-fold="unc">这些异常不会提醒' +
      '<span class="r">' + uncKeys.length + ' 个账号</span>' +
      '<span class="ar">' + (fold.unc ? '⌄' : '⌃') + '</span></h2>' +
      '<div class="foldbody' + uOpen + '">' +
      '<div class="muted tiny" style="margin-bottom:8px">' +
      '下列账号有异常设备，但没有规则覆盖它们，所以不会推送提醒。' +
      '如果希望这些站点也提醒，请去「我的 → 异常提醒规则」补规则。</div>' +
      '<div class="unclist">' + det + '</div>' +
      '<button class="blk" id="uncGo" style="margin-top:11px">去添加规则</button>' +
      '</div></div>';
  }

  /* 设备列表 */
  s += buildDevList();

  el('main').innerHTML = s;
  bindWatch();
}

/* 变量行的可写元信息。
 *
 * 【v0.31】后端每一行多带第 4 项：rel|rw|op|ident
 *   rel  = dataPointRelId（下发时当 dataPointId 用，注意不是模板级的 dataPointId）
 *   rw   = readWrite     变量本身是否可写（1 可写 / 0 只读）
 *   op   = permissionOp  当前账号对该变量是否有操作权限（1 有 / 0 无）
 *   ident= dataIdentifier 变量标识符（备用）
 *
 * 两个都必须是 1 平台才会真的接受下发：实测「线路乙」账号 permissionOp 全 0，
 * 整个账号一个变量都调不了；「示例账号」的 T*修正、温度类变量 readWrite=1 可调。
 * 老快照没有第 4 项 → meta 为 null → 一律按只读处理。
 * 宁可少给一个按钮，也不能给了一个点了必定失败的按钮。 */
function varMeta(x) {
  var s = (x && x.length > 3) ? String(x[3] || '') : '';
  if (!s) return null;
  var p = s.split('|');
  if (p.length < 3) return null;
  return { rel: p[0], rw: p[1], op: p[2], ident: p[3] || '' };
}

function canAdjust(x) {
  var m = varMeta(x);
  return !!(m && m.rel && m.rel !== '0' && m.rw === '1' && m.op === '1');
}

/* 把「45.2℃」拆成 {num:'45.2', unit:'℃'}。
   下发只送数值本身，单位是平台侧的展示字段，带上会被当非法值。 */
function splitVal(v) {
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^(-?[\d.]+)\s*(\S*)$/);
  if (m) return { num: m[1], unit: m[2] };
  return { num: s, unit: '' };
}

function rowsTable(rows, d) {
  if (!rows || !rows.length) return '<div class="muted tiny">无变量数据</div>';
  /* 只有存在可调变量时才多出「操作」这一列 ——
     整台都只读的设备不用白白占掉手机上一列宽度。 */
  var any = rows.some(canAdjust);
  var acc = d ? esc(d.acc) : '';
  var no = d ? esc(d.no) : '';
  return '<table class="tb"><tr><th>变量</th><th>当前值</th><th>数据时间</th>' +
    (any ? '<th style="text-align:right">操作</th>' : '') + '</tr>' +
    rows.map(function (x) {
      var m = varMeta(x);
      var cell = '';
      if (canAdjust(x)) {
        cell = '<td style="text-align:right"><button class="sm" data-setvar="' + esc(x[0]) +
          '" data-setrel="' + esc(m.rel) + '" data-setacc="' + acc +
          '" data-setno="' + no + '" data-setshow="' + esc(x[1]) + '">调整</button></td>';
      } else if (any) {
        cell = '<td style="text-align:right" class="tiny muted">只读</td>';
      }
      return '<tr><td>' + esc(x[0]) + '</td>' +
        '<td><b>' + esc(x[1]) + '</b>' +
        /* 【v0.32】单变量刷新：只拉这台设备、就地更新这一行的值和时间。
           每行都有（与可写与否无关），带 data-vr 由事件委托处理。 */
        '<button class="vr" data-vr="' + esc(x[0]) + '" data-vracc="' + acc +
        '" data-vrno="' + no + '">⟳</button></td>' +
        '<td class="tiny">' +
        esc(String(x[2] || '-').replace('T', ' ').slice(5, 16)) + '</td>' + cell + '</tr>';
    }).join('') + '</table>' +
    (any ? '<div class="tiny muted" style="margin-top:6px">' +
      '「调整」的变量可以下发新值到设备；「只读」是平台上没开放写入、' +
      '或当前账号没有操作权限的变量。</div>' : '');
}

function fmtIv(v) {
  for (var i = 0; i < IVS.length; i++) if (IVS[i].v === v) return IVS[i].t;
  return (v / 60).toFixed(0) + '分钟';
}

function bindWatch() {
  var m = el('main');

  /* 【v0.22 新增】模块折叠：点标题栏整块收��� / 展开。
     标题栏右侧的 ⌃/⌄ 表示「点一下会展开还是收起」，
     .foldbody 的 open 类控制实际显示，状态存在 fold 里。 */
  m.querySelectorAll('[data-fold]').forEach(function (h) {
    h.onclick = function () {
      var k = h.getAttribute('data-fold');
      var card = h.closest('.card');
      if (!card) return;
      var body = card.querySelector('.foldbody');
      if (!body) return;
      fold[k] = !fold[k];
      var ar = h.querySelector('.ar');
      if (ar) ar.textContent = fold[k] ? '⌄' : '⌃';
      if (fold[k]) body.classList.add('open');
      else body.classList.remove('open');
    };
  });

  /* 【v0.22 新增】点提醒条目 → 展开对应设备的实时变量。
     用户反馈「点异常站点不显示实时信息」——
     提醒本来就是从设备来的，看不到详情就得在下面几十条设备里翻找，
     顺着点过去才符合直觉。设备号从设备名里取（提醒只存了名字）。 */
  m.querySelectorAll('[data-aldev]').forEach(function (n) {
    n.onclick = function () {
      var name = n.getAttribute('data-aldev');
      var acc = n.getAttribute('data-alacc');
      var hit = findDevNo(name, acc);
      if (!hit) {
        toast('设备列表里没找到「' + name + '」，可能已被筛掉或本轮未加载');
        return;
      }
      /* 先清掉筛选，否则设备可能被状态筛选挡住，展开了也看不到 */
      stFilter = '';
      kwWatch = '';
      var k1 = el('kwWatch');
      if (k1) k1.value = '';
      renderWatch();
      var row = el('main').querySelector('[data-dvno="' + cssEsc(hit) + '"]');
      if (!row) {
        toast('该设备不在当前列表里（可能被筛选条件挡掉了）');
        return;
      }
      if (!row.classList.contains('open')) {
        row.classList.add('open');
        openDev[hit] = true;
        var ar = row.querySelector('.ar');
        if (ar) ar.textContent = '⌃';
      }
      scrollTo_(row, row.offsetTop - 8);
    };
  });

  /* 【v0.18】「去添加规则」：直接跳到「我的」页的规则卡。
     不自己弹规则编辑框 —— 那个框要手填账号通配符，
     而用户当前的问题恰恰是不知道该填什么。
     去了「我的」页能一眼看到现有规则覆盖了哪些账号。 */
  var ug = el('uncGo');
  if (ug) ug.onclick = function () {
    /* 用 go() 而不是手动改 G.tab —— go() 还会重建导航高亮、
       重置滚动、切换轮询，手动改会留下不一致的状态。 */
    go('me');
    var cards = el('main').querySelectorAll('.card');
    if (cards[1]) scrollTo_(cards[1], cards[1].offsetTop - 8);
    toast('在「异常提醒规则」里新增规则，账号填 * 表示全部');
  };

  var sg = el('ivSeg');
  if (sg) sg.querySelectorAll('[data-iv]').forEach(function (n) {
    n.onclick = function () {
      var v = parseInt(n.getAttribute('data-iv'), 10);
      var r = api('watchInterval', { sec: v });
      if (!r.ok) { toast(r.msg || '设置失败'); return; }
      toast('间隔已设为 ' + fmtIv(v));
      /* 【v0.32 修订】设完必须先拉一份最新状态再重绘。
         原来这里是直接 renderWatch() —— 而 renderWatch 用的是 G.ws 里的旧快照，
         里面的 summary.interval 还是上一个值，于是分段控件的高亮、下方
         「启动后每 X 自动巡检一次」的文案全都停在旧档上，
         要切到别的页再切回来（走整页拉取）才刷新 —— 用户报的就是这个：
         「点切换没反应，切换页面才会刷新」。
         pollWatch(true) = 重拉 watchState → 替换 G.ws → 整页重绘，一条链路。 */
      pollWatch(true);
    };
  });

  var tg = el('wToggle');
  if (tg) tg.onclick = function () {
    var on = G.ws.summary.enabled;
    var r = api(on ? 'watchOff' : 'watchOn', {});
    if (r.ok) {
      toast(on ? '监控已停止' : '监控已启动');
      setTimeout(pollWatch, 300);
      renderWatch();
    } else toast(r.msg || '操作失败');
  };

  var sc = el('wScan');
  if (sc) sc.onclick = function () {
    sc.disabled = true;
    sc.textContent = '巡检中…';
    var r = api('watchScan', {});
    if (!r.ok) {
      toast(r.msg || '启动失败');
      sc.disabled = false;
      sc.textContent = '⟳ 立即巡检';
    } else {
        toast('已开始一次手动巡检（不影响自动周期）');
        setTimeout(function () { pollWatch(); renderWatch(); }, 1500);
    }
  };

  var ar = el('alRead');
  if (ar) ar.onclick = function () {
    var r = api('alertsRead', {});
    if (r.ok) { toast('已标为已读'); setTimeout(function () { pollWatch(); renderWatch(); }, 200); }
  };

  var ac = el('alClear');
  if (ac) ac.onclick = function () {
    confirmBox('清空提醒', '将删除全部历史提醒记录，确定继续？', function () {
      var r = api('alertsClear', {});
      if (r.ok) { toast('已清空'); setTimeout(function () { pollWatch(); renderWatch(); }, 200); }
    });
  };

  var se = el('wSearch');
  if (se) {
    se.oninput = function () {
      kwWatch = this.value;
      repaintDevList();
    };
  }

  bindStat();
  bindDevRows();
  /* 首屏就要把「多久之前」的走字表挂上，否则页面停着不动文案会冻住 */
  startAgeTicker();
}

/* 统计条点击：筛设备列表。
 *
 * 「总数」= 清除筛选
 * 「在线/陈旧/离线/异常」= 筛到该状态，再点同一个取消
 * 「提醒」= 对应的是告警条数不是设备状态，点了滚到「异常提醒」卡片
 *
 * 筛选后要滚一下设备列表，否则在 57 台设备的页面上，
 * 点了上面的数字、下面列表变短了，但用户视线还在原处以为没生效。 */
function bindStat() {
  var sb = el('statBar');
  if (!sb) return;
  sb.querySelectorAll('[data-st]').forEach(function (n) {
    n.onclick = function () {
      var kind = n.getAttribute('data-st');
      var key = n.getAttribute('data-key');
      if (kind === 'all') {
        stFilter = '';
      } else if (kind === 'st') {
        stFilter = (stFilter === key) ? '' : key;
      } else {
        /* 提醒：滚到异常提醒卡片，没有提醒就说明一下 */
        var card = el('alertCard');
        if (card) {
          scrollTo_(card, card.offsetTop - 8);
        } else {
          toast('当前没有异常提醒');
        }
        return;
      }
      repaintDevList();
      scrollTo_(el('devList'), el('devList').offsetTop - 8);
    };
  });
}

/* 设备行点击。
 *
 * 【踩过的坑】原来给每行 .h 单独赋 onclick，
 * 而 softWatch() 每轮轮询都会 box.innerHTML = devListBody()
 * 把整块内容换掉 —— onclick 随旧节点一起没了，
 * 于是「设备行点不动」。
 *
 * 【第二次踩坑】改成绑在 #devList 上后仍不行：
 * renderWatch() 连 #devList 这个容器本身也会重建，
 * 新容器没有 _dvBound 标记，而旧代码写成
 * 「if (box._dvBound) return」，
 * 结果绑定逻辑在某些路径下压根没跑。
 *
 * 【现在的做法】用 document 级事件委托：
 * 只在启动时绑一次，#devList 被重建也不影响；
 * 每次点击用 closest('.dv .h') 找最近的表头，
 * 再用 matches('#devList [data-dvno]') 确认在设备列表内。
 */
function bindDevRows() {
  if (document._dvDelegated) return;
  document._dvDelegated = true;
  /* 【v0.32】长按站名复制的监听也是 document 级、绑一次，跟着一起装 */
  bindNameLongPress();
  document.addEventListener('click', function (e) {
    var box = el('devList');
    if (!box) return;
    var t = e.target;
    if (!t || !t.closest) return;
    /* 【v0.32】长按复制刚触发过的话，手指抬起会跟发一次 click ——
       吞掉它，否则站名复制完、设备行还误展开。 */
    if (document._lpFired) return;

    /* 【v0.32】单变量刷新：必须排在展开逻辑前，按钮在 .dv 的变量表内，
       不先截住点一下只会把设备行收起来。 */
    var vr = t.closest('[data-vr]');
    if (vr && box.contains(vr)) {
      refreshOneVar(vr.getAttribute('data-vrno'), vr.getAttribute('data-vracc'),
        vr.getAttribute('data-vr'), vr);
      return;
    }

    /* 【v0.30】先看是不是点了「刷新这台」。
       必须排在展开逻辑前面：刷新按钮在 .dv 区块内，如果不先截住，
       会被下面的行展开逻辑当成点表头处理。 */
    var rf = t.closest('[data-dvrf]');
    if (rf && box.contains(rf)) {
      refreshOneDev(rf.getAttribute('data-dvrf'), rf.getAttribute('data-dvacc'), rf);
      return;
    }

    /* 【v0.31】「调整」按钮同理：它在 .dv 里的变量表内，
       不先截住的话点一下只会把设备行收起来，看不到输入框。 */
    var sv = t.closest('[data-setvar]');
    if (sv && box.contains(sv)) {
      openSetVarDialog(sv.getAttribute('data-setacc'), sv.getAttribute('data-setno'),
        sv.getAttribute('data-setvar'), sv.getAttribute('data-setrel'),
        sv.getAttribute('data-setshow'));
      return;
    }

    var h = t.closest('.dv .h');
    /* 必须在设备列表容器内，且命中的是有 data-dvno 的行的表头 */
    if (!h || !box.contains(h)) return;
    var row = h.closest('[data-dvno]');
    if (!row) return;
    var no = row.getAttribute('data-dvno');
    if (!no) return;
    var on = row.classList.toggle('open');
    if (on) openDev[no] = true; else delete openDev[no];
    var ar = h.querySelector('.ar');
    if (ar) ar.textContent = on ? '⌃' : '⌄';
  });
}

/* ================= 【v0.32】长按站名复制 =================
 *
 * 站名又长又杂（「某线路站点E站1号200kW整机型式热泵机组_DRSCO2H200C90」），
 * 用户要把它发给同事时手打必错，所以给站名加长按复制。
 *
 * 实现：touchstart 起 600ms 计时，touchend/move/cancel 都取消。
 * 计时命中后：
 *   ① 走原生剪贴板（WebView 里 navigator.clipboard 在 file:// 下不可用）；
 *   ② 置 document._lpFired —— 手指抬起系统会补发一次 click，
 *      click 委托开头看到这个标记直接 return，设备行不会被误展开；
 *   ③ contextmenu 一律 preventDefault，不让 WebView 弹系统文本选择菜单。
 * 站名本身 user-select:none（index.html），避免和系统选择行为打架。
 */
function bindNameLongPress() {
  if (document._lpDelegated) return;
  document._lpDelegated = true;
  var timer = null;
  function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
  document.addEventListener('touchstart', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var box = el('devList');
    if (!box) return;
    var nm = t.closest('.dv .nm');
    if (!nm || !box.contains(nm)) return;
    cancel();
    timer = setTimeout(function () {
      timer = null;
      copyDevName(nm);
      document._lpFired = true;
      setTimeout(function () { document._lpFired = false; }, 400);
    }, 600);
  }, { passive: true });
  document.addEventListener('touchend', cancel);
  document.addEventListener('touchmove', cancel);
  document.addEventListener('touchcancel', cancel);
  document.addEventListener('contextmenu', function (e) {
    var box = el('devList');
    if (box && e.target && e.target.closest && box.contains(e.target)) e.preventDefault();
  });
}

function copyDevName(nm) {
  var row = nm.closest('[data-dvno]');
  var no = row ? row.getAttribute('data-dvno') : '';
  /* 名字优先从 G.ws 里取（那才是完整原文）；快照里没有就退回界面文本 */
  var name = '';
  var dv = (G.ws && G.ws.devices) || [];
  for (var i = 0; i < dv.length; i++) {
    if (dv[i].no === no) { name = dv[i].name || ''; break; }
  }
  if (!name) name = nm.textContent || '';
  if (!name) return;
  var r = api('copyText', { text: name, label: '站名' });
  if (r && r.ok) toast('已复制站名：' + name);
  else toast((r && r.msg) || '复制失败');
}

/**
 * 【v0.32】刷新单个变量：只拉这台设备的最新数据，就地更新这一行的值和数据时间。
 *
 * 为什么不复用 refreshOneDev 的整卡重绘：那个会把 #devList 整块 innerHTML 换掉，
 * 用户正盯着一台设备的一串变量看，点一个 ⟳ 全卡重绘会闪一下、滚动位置也可能跳。
 * 这里拉完只改：①这一行的值和时间 ②卡片顶部的「数据时间」 ③内存里的设备状态
 * （不写回的话，下一次 softWatch 重绘又会把旧值画回来）。
 */
function refreshOneVar(no, acc, varName, btn) {
  if (!no || !varName) return;
  var old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  var r = api('watchDevRefresh', { no: no, acc: acc });
  if (btn) { btn.disabled = false; btn.textContent = old || '⟳'; }
  if (!r || !r.ok || !r.device) {
    toast((r && (r.msg || r.error)) || '刷新失败，请稍后再试');
    return;
  }
  var hit = null;
  var rows = r.device.rows || [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === varName) { hit = rows[i]; break; }
  }
  if (!hit) {
    toast('这次的数据里没有「' + varName + '」');
    return;
  }
  /* 写回内存：下次整页/软刷新重绘时不会跳回旧值 */
  var dv = (G.ws && G.ws.devices) || [];
  for (var j = 0; j < dv.length; j++) {
    if (dv[j].no === r.device.no && (dv[j].acc || '') === (r.device.acc || '')) {
      dv[j] = r.device; break;
    }
  }
  /* 就地更新 DOM：值 + 时间。textContent 赋值自带转义，不用 esc。 */
  var tr = btn ? btn.closest('tr') : null;
  if (tr) {
    var vb = tr.querySelector('td:nth-child(2) b');
    if (vb) vb.textContent = hit[1];
    var tm = tr.querySelector('td:nth-child(3)');
    if (tm) tm.textContent = String(hit[2] || '-').replace('T', ' ').slice(5, 16);
  }
  var msg = document.querySelector('[data-dvrfmsg="' + cssEsc(no) + '"]');
  if (msg && r.device.data_time && r.device.data_time !== '--') {
    msg.textContent = '数据时间 ' + String(r.device.data_time).replace('T', ' ').slice(5, 16);
  }
  toast('已刷新「' + varName + '」');
}

/**
 * 【v0.30】刷新单台设备的实时数据（就地替换那一行，不动整页）。
 *
 * <p>用户反馈「监控页点击站点后没有立即刷新数据选项」——
 * 之前展开只能看到上一轮巡检的快照，想拿最新值得等整轮巡检（一轮几十台）。
 * 这里只拉这一台，快进快出；成功后把返回的最新状态写进 G.ws.devices 对应项，
 * 并就地重绘该行（不整页 renderWatch，避免闪烁和打断用户浏览位置）。
 */
function refreshOneDev(no, acc, btn) {
  if (!no) return;
  var old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
  /* 提示文案区（按钮右侧那格）先标在查 */
  var msg = document.querySelector('[data-dvrfmsg="' + cssEsc(no) + '"]');
  if (msg) msg.textContent = '正在读取…';

  var r = api('watchDevRefresh', { no: no, acc: acc });
  if (btn) { btn.disabled = false; btn.textContent = old || '⟳ 刷新这台'; }
  if (!r.ok || !r.device) {
    if (msg) msg.textContent = '读取失败';
    toast(r.msg || '刷新失败，请稍后再试');
    return;
  }
  /* 把最新设备状态写回内存列表：按 账号+编号 精确匹配那一项 */
  var dv = (G.ws && G.ws.devices) || [];
  var hit = false;
  for (var i = 0; i < dv.length; i++) {
    if (dv[i].no === r.device.no && (dv[i].acc || '') === (r.device.acc || '')) {
      dv[i] = r.device; hit = true; break;
    }
  }
  if (!hit) dv.push(r.device);
  /* 保持这一行展开（重绘后由 openDev 还原）。
     这里只重绘设备列表，**不调 softWatch()** —— softWatch 会重新拉整份 watchState，
     把后端还没更新的旧快照覆盖回来，刚刷到的新值当场被冲掉。
     统计条本地的数字用重算的方式同步，不再打后端。 */
  openDev[no] = true;
  var box = el('devList');
  if (box) { box.innerHTML = devListBody(); bindDevRows(); }
  var cnt = el('dvCnt');
  if (cnt) cnt.textContent = filteredDevs().length + ' 台';
  refreshStatBar();
  toast('已刷新「' + (r.device.name || no) + '」');
}

/** 用当前内存里的设备列表重算统计条数字（不打后端），保持与设备列表一致。 */
function refreshStatBar() {
  var sb = el('statBar');
  if (!sb) return;
  var dv = (G.ws && G.ws.devices) || [];
  var m = { total: dv.length, online: 0, stale: 0, offline: 0, blank: 0 };
  dv.forEach(function (d) {
    if (d.status === 'online') m.online++;
    else if (d.status === 'stale') m.stale++;
    else if (d.status === 'offline') m.offline++;
    else m.blank++;
  });
  /* 提醒数沿用后端给的（本地刷新不影响提醒队列） */
  m.alerts = ((G.ws && G.ws.summary) || {}).alerts || 0;
  /* 顺手把内存里的 summary 也更新，避免下次整页重绘时数字跳回旧值 */
  if (G.ws && G.ws.summary) {
    G.ws.summary.total = m.total; G.ws.summary.online = m.online;
    G.ws.summary.stale = m.stale; G.ws.summary.offline = m.offline;
    G.ws.summary.blank = m.blank;
  }
  var tmp = document.createElement('div');
  tmp.innerHTML = statBar(m);
  sb.parentNode.replaceChild(tmp.firstChild, sb);
  bindStat();
}

/* ================= 【v0.31】调整变量 =================
 *
 * 需求原文：「在监控页有些账号有更改变量数值的权限，我需要做出调整变量的按钮也好
 * 输入框也好，再保存输入的信息时要有二次确认」。
 *
 * 三步走，中间那一步就是用户要的「二次确认」：
 *   ① 输入新值 —— 这一步只是填表，一个字都没发出去
 *   ② 确认弹窗 —— 把 设备/账号/变量/原值→新值 全列出来，并写清
 *      「立即下发到真实设备、不可撤销」，点「确认下发」才真的发
 *   ③ 结果 —— 平台受理 / 平台拒绝（把原因原样说出来，不糊弄）
 *
 * 为什么必须两次确认：下发是不可撤销的外部动作，而设备行展开后变量表很密，
 * 手机上手指一滑就可能点到隔壁。多按一次的成本，远小于误发一个值到热泵。
 */

/** 按 设备号+账号 从当前快照取设备名，取不到就退回设备号。 */
function devNameOf(no, acc) {
  var dv = (G.ws && G.ws.devices) || [];
  for (var i = 0; i < dv.length; i++) {
    if (dv[i].no === no && (dv[i].acc || '') === (acc || '')) return dv[i].name || no;
  }
  return no;
}

function setRow(k, v) {
  return '<div class="row" style="padding:4px 0"><span class="tiny muted">' + k +
    '</span><span class="sp"></span><span style="font-size:13.5px">' + v + '</span></div>';
}

function openSetVarDialog(acc, no, varName, rel, curShow) {
  var dev = devNameOf(no, acc);
  var sv = splitVal(curShow);
  var label = varName + (sv.unit ? '（' + sv.unit + '）' : '');
  openBox('调整变量',
    '<div class="tiny muted" style="margin-bottom:10px">' + esc(dev) + ' · ' + esc(acc) + '</div>' +
    '<div class="row" style="margin-bottom:10px">' +
    '<span style="font-size:13.5px">' + esc(label) + '</span><span class="sp"></span>' +
    '<span class="tiny muted">当前 ' + esc(curShow || '-') + '</span></div>' +
    '<input id="svVal" inputmode="decimal" placeholder="输入新值" value="' + esc(sv.num) + '">' +
    '<div class="tiny muted" style="margin-top:10px">' +
    '这里只是填写，还没下发。点「下一步」会再要你确认一次。</div>' +
    '<div class="two"><button data-no>取消</button>' +
    '<button class="pri" data-ok>下一步</button></div>',
    function () {
      var box = el('svVal');
      var v = box ? String(box.value == null ? '' : box.value).trim() : '';
      if (!v) { toast('请先填新值'); return false; }
      /* 原值是数值型 → 新值也必须是数值，挡住「45..2」这类手滑 */
      if (/^-?[\d.]+$/.test(sv.num) && !/^-?[\d.]+$/.test(v)) {
        toast('这个变量是数值型，请填数字');
        return false;
      }
      if (v.length > 32) { toast('新值太长了'); return false; }
      confirmSetVar(acc, no, dev, varName, sv.unit, rel, curShow, v);
      /* 返回 false：不能让弹窗先关掉再开确认框（会闪一下），
         confirmSetVar 紧接着用同一个 #mbox 把内容换成确认框。 */
      return false;
    });
}

function confirmSetVar(acc, no, dev, varName, unit, rel, before, value) {
  openBox('确认下发到设备？',
    '<div class="bar w" style="margin-bottom:12px">指令会<b>立即下发到真实设备</b>，' +
    '发送后无法撤销。请确认设备在线、且新值正确。</div>' +
    setRow('设备', esc(dev)) +
    setRow('账号', esc(acc)) +
    setRow('变量', esc(varName) + (unit ? '（' + esc(unit) + '）' : '')) +
    setRow('当前值', esc(before || '-')) +
    setRow('新值', '<b style="color:#d33d3d;font-size:15px">' + esc(value) + '</b>') +
    '<div class="two" style="margin-top:14px"><button data-no>取消</button>' +
    '<button class="dan" data-ok>确认下发</button></div>',
    function () {
      doSetVar(acc, no, dev, varName, unit, rel, before, value);
      /* 必须返回 false：doSetVar 会用同一个 #mbox 换成「已下发/下发失败」结果框，
         而 openBox 在 onOk 不返回 false 时**会紧接着 closeBox()**，
         把刚开出来的结果框当场清空 —— 用户点完确认什么都看不到。
         （这条是测试先发现的：结果框内容为空，断言「没显示失败」。） */
      return false;
    });
}

function doSetVar(acc, no, dev, varName, unit, rel, before, value) {
  var r = api('watchSetVar', { acc: acc, no: no, rel: rel, var: varName, value: value });
  if (!r || !r.ok) {
    openBox('下发失败',
      '<div class="bar w" style="margin-bottom:12px">' +
      esc((r && (r.msg || r.error)) || '平台没有说明原因') + '</div>' +
      '<div class="tiny muted">平台没受理这条指令，设备上不会有任何变化。' +
      '可以先点「刷新这台」看清当前值再重试。</div>' +
      '<div class="two" style="margin-top:14px"><button class="pri" data-no>知道了</button></div>');
    return;
  }
  openBox('已下发',
    '<div class="bar" style="margin-bottom:12px">平台已受理这条指令。</div>' +
    setRow('设备', esc(dev)) +
    setRow('账号', esc(acc)) +
    setRow('变量', esc(varName) + (unit ? '（' + esc(unit) + '）' : '')) +
    setRow('变化', esc(before || '-') + ' → <b>' + esc(value) + '</b>') +
    '<div class="tiny muted" style="margin-top:10px">' +
    '「受理」只表示平台收下了指令，真正写进设备要等它回传。' +
    '点下面「刷新这台看新值」可以拉一次最新数据核对。</div>' +
    '<div class="two" style="margin-top:14px"><button data-no>关闭</button>' +
    '<button class="pri">刷新这台看新值</button></div>',
    null,
    function (m) {
      var b = m.querySelector('.two .pri');
      if (b) b.onclick = function () {
        closeBox();
        openDev[no] = true;
        var rf = el('main') && el('main').querySelector('[data-dvrf="' + cssEsc(no) + '"]');
        refreshOneDev(no, acc, rf);
      };
    });
}

/**
 * 【v0.33】原生注入的「只切页签」入口（常驻通知点进来就是这一条）。
 *
 * 之前只有 onOpenTarget（必须带 dev），原生侧也是只认 dev/acc —— 所以
 * 那条常驻通知即使补上了 PendingIntent，进来也停在用户上次待的页签，
 * 通知标题写着「点此打开监控页」却没去监控页。
 * 这里做成独立的入口：只切页，不碰筛选、不展开任何设备。
 */
window.onOpenTab = function (t) {
  if (!t || !t.tab) return;
  var k = String(t.tab);
  /* 白名单：原生传进来的是外部数据，不能直接拿去当页签 */
  var ok = false;
  (typeof TABS !== 'undefined' ? TABS : []).forEach(function (x) { if (x.k === k) ok = true; });
  if (!ok) return;
  if (typeof goNoHist === 'function') goNoHist(k);
};

/**
 * 【v0.30】点系统通知跳进来的入口。原生把通知里带的 {dev, acc} 传进来，
 * 这里负责：切到监控页 → 清掉可能挡住该设备的筛选/搜索 → 展开这台设备
 * → 自动拉一次实时数据。用户从通知点进来就能直接看到当前数据。
 *
 * 为什么要清筛选：设备可能被统计条的「离线/陈旧」筛选或搜索框挡着，
 * 不清掉的话展开了也在屏幕外，用户还是看不到 —— 等于跳转没生效。
 */
window.onOpenTarget = function (t) {
  if (!t || !t.dev) return;
  var dev = t.dev, acc = t.acc || '';
  /* 先切到监控页（若已在监控页也要重绘，保证下面能找到行） */
  if (typeof goNoHist === 'function') goNoHist('watch'); else if (typeof go === 'function') go('watch');

  function findRow() {
    var list = (G.ws && G.ws.devices) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === dev && (!acc || (list[i].acc || '') === acc)) return list[i];
    }
    /* 账号对不上时退一步：只按设备名找（重名概率低，且通知本来就带了账号） */
    for (var j = 0; j < list.length; j++) {
      if (list[j].name === dev) return list[j];
    }
    return null;
  }

  var d = findRow();
  if (!d) {
    /* 设备不在当前快照里：清掉筛选重试一次（可能只是被筛掉了） */
    stFilter = '';
    kwWatch = '';
    var se = el('wSearch'); if (se) se.value = '';
    if (typeof renderWatch === 'function') renderWatch();
    d = findRow();
  }
  if (!d) {
    toast('未找到设备「' + dev + '」，可能本轮还没加载到');
    return;
  }

  /* 清筛选 + 搜索，保证这一行一定可见 */
  stFilter = '';
  kwWatch = '';
  var se2 = el('wSearch'); if (se2) se2.value = '';
  openDev[d.no] = true;
  if (typeof renderWatch === 'function') renderWatch();

  /* 等一帧让 DOM 落位，再滚动到位并自动刷新，用户进来直接看到当前数据 */
  setTimeout(function () {
    var row = el('main') && el('main').querySelector('[data-dvno="' + cssEsc(d.no) + '"]');
    if (row) {
      if (!row.classList.contains('open')) {
        row.classList.add('open');
        var ar = row.querySelector('.ar'); if (ar) ar.textContent = '⌃';
      }
      if (typeof scrollTo_ === 'function') scrollTo_(row, row.offsetTop - 8);
      /* 自动拉一次这台的最新数据 */
      var btn = row.querySelector('[data-dvrf]');
      refreshOneDev(d.no, d.acc, btn);
    }
  }, 60);
};
