/* 我的：账号管理 + 异常提醒规则 + 设置 */

/* 软件自带的预置账号个数。
   【v0.20】「恢复出厂预置」按钮要告诉用户会重置成几个。
   【v0.27】不再写死 3 —— 由 Java 读包内 accounts.csv 下发给前端
   （G.health.presetCount）。存在「不带预置账号」的版本，
   那种包里这个数就是 0，写死的话按钮会说「重置成 3 个」，是骗人。 */
function presetCount() {
  var h = G.health || {};
  return (h.presetCount == null) ? 3 : h.presetCount;
}

var KINDS = [
  { v: 'offline', t: '设备离线' },
  { v: 'stale', t: '数据停更' },
  { v: 'blank', t: '采集异常' },
  { v: 'value', t: '数值越限' }
];
var OPS = [
  { v: 'gt', t: '大于' }, { v: 'gte', t: '大于等于' },
  { v: 'lt', t: '小于' }, { v: 'lte', t: '小于等于' },
  /* 【v0.26】区间条件：val < 数值 < val2。
     供暖场景里「供回水温差正常、压力既不为零也不爆表」这类判断，
     原来只能建两条规则再靠「重复提醒」去凑，现在一条搞定。 */
  { v: 'range', t: '介于' },
  /* 【v0.33】反向区间：不在区间内才提醒。
     用户原话「加一个反向介于」。典型用法是「该有的数值没有」：
     冬季供水温度应该在 8~30 之间，掉到 8 以下就该报 ——
     这类判断以前只能写两条规则（小于8 或 大于30），一次故障出两条提醒、
     冷却期还各自算一份，很别扭。 */
  { v: 'notinrange', t: '不在区间内' }
];

/* 【v0.33】反向区间的提示语。
   特意写清楚「边界也算不在区间内」：按 v<=下限 或 v>=上限 判定，
   压着 8.0 的数会报。这跟「介于」的开区间语义正好互补，用户不容易混。 */
var NOTIN_RANGE_HINT = '不在区间内：数值落在两个数之外才提醒。如填 8 和 30 = 低于 8 或 高于 30 就提醒。压在 8 或 30 上也算「不在区间内」。两个框填反了会自动纠正。';

/* 【v0.27】「介于」的提示语。
   之前写的是「大于下限且小于上限」，用户反馈拗口且分不清两个框谁是下限：
   现在输入框自带 placeholder（第一个=下限、第二个=上限），提示语用大白话，
   并说明填反了也没关系（保存时自动把小的当下限）。 */
var RANGE_HINT = '介于：数值在两个数之间才提醒。第 1 个框填下限（小）、第 2 个框填上限（大），如 8 和 30 = 在 8~30 之间。两个框填反了会自动纠正。';

function V_me() {
  if (G.tab !== 'me') return;
  var h = G.health || {};
  var s = '';

  /* 账号 */
  s += '<div class="card">' +
    '<h2>账号管理<span class="r">' + G.accounts.length + ' 个</span>' +
    '<div class="fab" id="mAdd">＋ 新增</div></h2>';
  if (!G.accounts.length) {
    s += '<div class="empty">还没有账号<br><span class="tiny">点右上角「＋ 新增」</span></div>';
  } else {
    G.accounts.forEach(function (a) {
      var kw = (a.station_kw || []).join('、');
      s += '<div class="rw" style="padding:10px 0;border-top:1px solid #f1f3f7">' +
        '<div class="row"><div class="nm2">' + esc(a.name) +
        (a.enabled ? '' : ' <span class="pill gray">停用</span>') + '</div></div>' +
        '<div class="kw mono">' + esc(a.account) + ' · 平台 ' + esc(a.platform_id) +
        (kw ? ' · 过滤 ' + kw.split('、').length + ' 站' : '') + '</div>' +
        '<div class="row wrap">' +
        '<button class="sm" data-tg="' + esc(a.name) + '">' +
        (a.enabled ? '■ 停用' : '▶ 启用') + '</button>' +
        '<button class="sm" data-ed="' + esc(a.name) + '">✎ 编辑</button>' +
        '<button class="sm" data-ts="' + esc(a.name) + '">🔑 测试登录</button>' +
        '<button class="sm dan" data-dl="' + esc(a.name) + '">🗑 删除</button>' +
        '</div></div>';
    });
  }
  /* 【v0.19】账号表格原文编辑入口。
     表单把一切规整化了，看不见底层存了什么 ——
     用户怀疑「预置账号和手动加的账号有细微不同导致登不上」时，
     只能靠看原始 CSV 才知道真相。 */
  s += '<div class="sep"></div>' +
    '<button class="blk" id="mRaw">📋 编辑账号表格（CSV 原文）</button>' +
    '<div class="muted tiny" style="margin-top:7px">' +
    '表单填错时看不出问题出在哪，这里能直接看到和改表格本身。' +
    '保存前会校验，写错了会告诉你第几行有问题，不会把表改坏。</div>' +
    /* 【v0.20】升级后想丢掉旧版残留账号的入口。
       【v0.27】预置数可能是 0（不带预置账号的版本），
       这时按钮的语义就是「清空账号表」，文案必须说清楚。 */
    '<button class="blk" id="mReset" style="margin-top:14px">' +
    '♻️ ' + (presetCount() > 0 ? '恢复出厂预置账号' : '清空账号表') + '</button>' +
    '<div class="muted tiny" style="margin-top:7px">' +
    (presetCount() > 0
      ? '覆盖安装不会清掉旧版本留下的账号表。' +
        '这个按钮会重置成软件自带的 ' + presetCount() + ' 个账号。' +
        '只想删一个账号的话，用账号右边的「删除」就行。'
      : '这个版本不带预置账号：账号全靠自己添加，' +
        '点这里会把当前账号表清空（不是恢复成 3 个）。' +
        '只想删一个账号的话，用账号右边的「删除」就行。') +
    '</div>';
  s += '</div>';

  /* 规则 */
  /* 重复提醒策略：默认「每次巡检都提醒」+60 分钟去重，
     与后端 Watch.scan() 的默认值保持一致。
     这两个值会随rulesSave 一起落盘，所以要从 G.rules 读，不能写死。 */
  var onlyChange = !!(G.rules && G.rules.notify_on_change_only);
  var cdMin = (G.rules && G.rules.repeat_cooldown_min != null)
      ? G.rules.repeat_cooldown_min : 60;
  s += '<div class="card">' +
    '<h2>异常提醒规则<span class="r">' +
    ((G.rules && G.rules.rules) ? G.rules.rules.length : 0) + ' 条</span>' +
    '<div class="fab" id="rAdd">＋ 新增</div></h2>';
  var rl = (G.rules && G.rules.rules) || [];
  if (!rl.length) {
    s += '<div class="empty">还没有规则<br>' +
      '<span class="tiny">没有规则时只统计状态，不产生提醒</span></div>';
  } else {
    rl.forEach(function (r, i) {
      /* 【v0.33】有名称时把名称顶到标题行（和通知里显示的是同一个名字），
         没有名称的老规则保持原样，不显示空标签。 */
      var rn = (r.rule_name || '').trim();
      s += '<div class="item" data-ri="' + i + '">' +
        '<div class="row"><div style="flex:1"><div class="t">' +
        (rn ? esc(rn) + ' · ' : '') + kindText(r.kind) + '</div>' +
        '<div class="s">' + ruleText(r) + '</div></div>' +
        /* 【v0.21 新增】编辑按钮。
           原来只有「删除」，改一条规则得先删掉再重新添加一遍 ——
           阈值从 40 调到 45 这种小改动也得重来，规则多了很容易搞混哪条是哪条。 */
        '<button class="sm" data-re="' + i + '">编辑</button>' +
        '<button class="sm dan" data-rd="' + i + '">删除</button></div></div>';
    });
  }
  s += '<div class="two" style="margin-top:8px">' +
    '<button class="sm" id="rTest">🔔 测试提醒</button>' +
    '<button class="sm" id="rClr">清空提醒</button></div>' +
    /* 重复提醒策略。
       【v0.17】原来这里没有这个设置，行为写死在后端
       （notify_on_change_only 默认 true），用户既看不到也改不了，
       表现就是「只有第一次巡检弹提醒，之后再也不弹」。
       现在把选择权交给用户，并说明各自的代价。 */
    '<div class="sep"></div>' +
    '<div class="row" style="margin-bottom:8px"><span style="font-size:13.5px">重复提醒</span>' +
    '<span class="sp"></span></div>' +
    '<div class="seg" id="repSeg">' +
    '<div class="s' + (onlyChange ? '' : ' on') + '" data-rep="0">每次巡检都提醒</div>' +
    '<div class="s' + (onlyChange ? ' on' : '') + '" data-rep="1">只在状态变化时</div>' +
    '</div>' +
    '<div class="muted tiny" style="margin-top:9px">' +
    (onlyChange
      ? '只在设备状态发生变化时提醒（在线↔离线）。同一状态持续异常时不会再响。'
      : '每轮巡检命中规则就提醒一次，故障持续时会反复提醒你还没恢复。' +
      (cdMin > 0 ? '为免刷屏，同一台设备' + cdMin + '分钟内不重复。' : '')) +
    '</div>' +
    (onlyChange ? '' :
      '<div class="row tiny muted" style="margin-top:9px"><span>同设备重复间隔</span>' +
      '<span class="sp"></span></div>' +
      '<div class="seg" id="cdSeg">' +
      [0, 30, 60, 180, 360].map(function (n) {
        return '<div class="s' + (cdMin === n ? ' on' : '') + '" data-cd="' + n + '">' +
          (n === 0 ? '不限制' : n + '分') + '</div>';
      }).join('') + '</div>' +
      '<div class="muted tiny" style="margin-top:8px">「不限制」每轮都响；' +
      '间隔越长越省电但发现故障也越慢。</div>') +
    /* 通知授权状态：Android 13+ 没授权的话提醒只进 app，不弹通知栏。
       不显示出来用户只会以为「提醒功能坏了」。 */
    '<div class="row tiny muted" style="margin-top:11px"><span>通知提醒</span>' +
    '<span class="sp"></span>' +
    (h.canNotify === false ? '<span class="pill r">未授权</span>'
      : (h.alertChannel === false ? '<span class="pill y">通道已关</span>'
        : '<span class="pill g">正常</span>')) + '</div>' +
    (h.canNotify === false
      ? '<div class="tiny muted" style="margin-top:4px">未授权时设备异常只记录在 app 内，不弹通知。' +
      '点下方按钮去系统设置里打开通知。</div>' +
      '<button class="blk" id="btnNotif" style="margin-top:9px">去开启通知</button>'
      : (h.alertChannel === false
        ? '<div class="tiny muted" style="margin-top:4px">「设备异常提醒」通道被关掉了，' +
        '去系统设置里把该通道打开。</div>' +
        '<button class="blk" id="btnNotif" style="margin-top:9px">去开启通知</button>'
        : '')) +
    /* 【v0.20】权限正常但通知还是不弹，绝大多数是这一档：
       系统「冻结」了本 app —— 权限、规则全对，唯独后台被杀。
       所以必须给一个白名单入口，否则用户查遍所有设置都找不到原因。 */
    (h.canNotify === false || h.alertChannel === false ? '' :
      '<div class="tiny muted" style="margin-top:11px">' +
      '通知权限正常，但国产系统常会自动「冻结」后台 app，' +
      '冻结后巡检停止，提醒只留在 app 内、通知栏不弹。' +
      '把本 app 设为「不受限制」可彻底解决。</div>' +
      '<button class="blk" id="btnBattery" style="margin-top:9px">' +
      '设为后台不受限制</button>') +
    '</div>';

  /* 变量排序（v0.35）
     用户反馈「同一台机组上进水/出水的位置会自己换」——
     根子是平台返回的变量顺序不保证稳定，而我们原来同档内保持平台原序，
     平台一换序截图就跟着换。这里给一份置顶清单：行序 = 优先级，
     命中的排最前，没命中的走默认分档（出水/供水 → 进水/回水 → …）。
     三处（监控实时表、截图卡片、历史曲线）共用同一份，排序在 Java 侧算。 */
  var vl = G.vars || [];
  s += '<div class="card"><h2>变量排序<span class="r">' +
    (vl.length ? vl.length + ' 条置顶' : '默认顺序') + '</span></h2>' +
    '<div class="muted tiny" style="margin-bottom:9px">' +
    '排在前面的变量，监控、截图、历史三处都按这个顺序显示。</div>';
  if (vl.length) {
    s += '<div class="row wrap" style="margin-bottom:10px">' +
      vl.map(function (k, i) {
        return '<span class="pill">' + (i + 1) + ' · ' + esc(k) + '</span>';
      }).join('') + '</div>';
  } else {
    s += '<div class="muted tiny" style="margin-bottom:10px;line-height:1.75">' +
      '还没配，现在按默认顺序：<br>' +
      '出水/供水 → 进水/回水 → 其它水温 → 其它温度 → 其余</div>';
  }
  s += '<button class="blk" id="mVarEdit">↑↓ 编辑置顶顺序</button>' +
    '<button class="blk" id="mVarRaw" style="margin-top:8px">📋 编辑排序表（CSV 原文）</button>' +
    '<div class="muted tiny" style="margin-top:7px">' +
    '关键词按「包含」匹配变量名 —— 平台把「供水温度T1」改成 T2，规则照样命中。</div>' +
    '</div>';

  /* 置顶站名（v0.36）
     和上面同构：46 个站点上百台机组，天天盯的就那么几台，
     排在字母序中间每次都要往下翻。这里顶上去，监控/历史/截图三处一起变。 */
  var dl = G.devPins || [];
  s += '<div class="card"><h2>置顶站名<span class="r">' +
    (dl.length ? dl.length + ' 条置顶' : '默认顺序') + '</span></h2>' +
    '<div class="muted tiny" style="margin-bottom:9px">' +
    '排在前面的站，监控页设备列表、历史页选设备、截图列表三处都提到最前。</div>';
  if (dl.length) {
    s += '<div class="row wrap" style="margin-bottom:10px">' +
      dl.map(function (k, i) {
        return '<span class="pill">' + (i + 1) + ' · ' + esc(k) + '</span>';
      }).join('') + '</div>';
  } else {
    s += '<div class="muted tiny" style="margin-bottom:10px;line-height:1.75">' +
      '还没配。现在各页按自己的默认顺序：<br>' +
      '监控页按账号+站名，历史页按最后记录时间，截图按文件名。</div>';
  }
  s += '<button class="blk" id="mDevEdit">↑↓ 编辑置顶站名</button>' +
    '<button class="blk" id="mDevRaw" style="margin-top:8px">📋 编辑站名表（CSV 原文）</button>' +
    '<div class="muted tiny" style="margin-top:7px">' +
    '关键词按「包含」匹配站名 —— 填「某线路」这条线上所有站一次顶上去。</div>' +
    '</div>';

  /* 设置 */
  s += '<div class="card"><h2>设置</h2>' +
    '<div class="row" style="margin-bottom:9px"><span style="font-size:13.5px">并发线程数</span>' +
    '<span class="sp"></span><span class="muted tiny" id="wkTip">当前 ' +
    (h.workers || 4) + '</span></div>' +
    '<div class="seg" id="wkSeg">' +
    [1, 2, 4, 6, 8].map(function (n) {
      return '<div class="s' + ((h.workers || 4) === n ? ' on' : '') + '" data-wk="' + n +
        '">' + n + '</div>';
    }).join('') + '</div>' +
    '<div class="muted tiny" style="margin-top:9px">只影响读变量名和出图的速度；' +
    '取最新值已按账号合并成一次请求，不受这里影响。建议 4。</div>' +
    '<div class="sep"></div>' +
    /* 【v0.26】陈旧判定阈值从只读改成可调，样式对齐并发线程数的分段选择 */
    '<div class="row" style="margin-bottom:9px"><span style="font-size:13.5px">陈旧判定阈值</span>' +
    '<span class="sp"></span><span class="muted tiny" id="smTip">当前 ' +
    (h.staleMinutes || 15) + ' 分钟</span></div>' +
    '<div class="seg" id="smSeg">' +
    [5, 10, 15, 30, 60].map(function (n) {
      return '<div class="s' + ((h.staleMinutes || 15) === n ? ' on' : '') + '" data-sm="' + n +
        '">' + n + '</div>';
    }).join('') + '</div>' +
    '<div class="muted tiny" style="margin-top:9px">数据超过这么多分钟没更新就判「陈旧」，监控和巡站状态都用它。</div>' +
    '<div class="row tiny muted" style="margin-top:7px"><span>截图保存目录</span>' +
    '<span class="sp"></span>' +
    (h.allFiles === false ? '<span class="pill y">下载目录</span>' :
      '<span class="pill g">手机根目录</span>') + '</div>' +
    '<div class="tiny mono" style="margin-top:4px;color:#7b8494;word-break:break-all">' +
    esc(h.saveDir || '') + '</div>' +
    '<div class="tiny muted" style="margin-top:4px">' +
    esc(h.saveHint || '') + '</div>' +
    (h.allFiles === false
      ? '<button class="sm pri blk" id="stAsk" style="margin-top:9px">' +
        '改为存到手机根目录（可选）</button>' : '') +
    '</div>';

  /* 关于 */
  s += '<div class="card"><h2>关于</h2>' +
    '<div class="row tiny muted"><span>应用</span><span class="sp"></span>' +
    '<span>有人云巡站 v' + esc(h.version || '0.40.07') + '</span></div>' +
    /* 【v0.36 修订五】版本号一直停在 0.36，光看版本分不清装的是哪一次打包的包。
       这里把编译时刻摆出来，出问题时对着它一看就知道该不该重装。 */
    '<div class="row tiny muted" style="margin-top:7px"><span>编译</span><span class="sp"></span>' +
    '<span id="mStamp">' + esc(h.stamp ? h.stamp : '未知') + '</span></div>' +
    '<div class="row tiny muted" style="margin-top:7px"><span>说明</span><span class="sp"></span>' +
    '<span>与 Windows 版同一套接口与判定规则</span></div>' +
    '<div class="row tiny muted" style="margin-top:7px"><span>制作</span><span class="sp"></span>' +
    '<span>by Yang</span></div>' +
    /* 【v0.33 修订八】项目地址入口。不用 <a href>：WebView 里直接跳过去
       会变成一个没有地址栏的浏览器，用户既回不去也没法复制链接，
       所以交给系统浏览器（走 Android.openUrl 桥）。 */
    '<div class="row tiny muted" style="margin-top:7px"><span>项目地址</span><span class="sp"></span>' +
    '<span id="mGh" style="color:#2b62e0">GitHub 主页 ›</span></div>' +
    /* 【v0.40】只有内置了更新源的那个变体才显示入口。
       网页只拿 health.updateEnabled 这个布尔值，不拿网址、账号、密码。 */
    (h.updateEnabled
      ? '<button class="sm pri blk" id="mUpdate" style="margin-top:11px">检查更新</button>'
      : '') +
    '</div>';

  el('main').innerHTML = s;
  bindMe();
}

function kindText(k) {
  for (var i = 0; i < KINDS.length; i++) if (KINDS[i].v === k) return KINDS[i].t;
  return '设备离线';
}

function ruleText(r) {
  var t = [];
  t.push('账号 ' + (r.acc || '*'));
  t.push('设备 ' + (r.dev || '*'));
  if (r.kind === 'stale') t.push('停更超 ' + (r.stale_min || 15) + ' 分钟');
  if (r.kind === 'value') {
    var op = 'gt';
    for (var i = 0; i < OPS.length; i++) if (OPS[i].v === r.op) op = r.op;
    /* 【v0.26】区间条件摘要写成「介于 8 ~ 30」，一眼能看懂。
       【v0.27】显示前也做 min/max 归一 —— 兼容 v0.26 期间存成
       「下限>上限」的旧规则，摘要和实际判定一致。
       【v0.33】反向区间一并处理，摘要用「不在区间内」原文而不是拼英文 op。 */
    if (op === 'range' || op === 'notinrange') {
      var lo = (r.val == null ? 0 : r.val);
      var hi = (r.val2 == null ? 0 : r.val2);
      if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
      /* 两类区间用各自的句式，不要混：
         range      → 「介于 8 ~ 30」
         notinrange → 「不在区间内（低于 8 或 高于 30）」 */
      /* 【v0.38g】列表里把 = 前缀带出来：用户一眼能看出这条是「完全一致」，
         不然保存时选了精确、回到列表却看不出来，还以为没生效。 */
      var vshow = (r.var_exact ? '=' : '') + (r.var || '*');
      t.push('变量 ' + vshow + (op === 'range'
        ? ' 介于 ' + lo + ' ~ ' + hi
        : ' 不在区间内（低于 ' + lo + ' 或 高于 ' + hi + '）'));
    } else {
      t.push('变量 ' + (r.var_exact ? '=' : '') + (r.var || '*') +
        ' ' + opText(op) + ' ' + (r.val == null ? 0 : r.val));
    }
  }
  return t.join(' · ');
}

function opText(v) {
  for (var i = 0; i < OPS.length; i++) if (OPS[i].v === v) return OPS[i].t;
  return '大于';
}

/* 【v0.40】在线更新：检查 → 下载 → 校验 → 交给系统安装器。
   三段都是「Start 起线程 + Poll 每 600ms 问一次」，绝不直接在桥里拉网
   （Android.call 是同步的，同步发 HTTP 会把页面冻住）。
   界面不出现更新地址、账号、密码，失败提示由后端按网络类型生成。 */

/* 【v0.40.02】每天第一次打开软件时自动查一次。
   页面加载完、以及从后台回到前台，Java 都会来敲一下这个函数；
   「今天查过没」由 Java 记着，重复敲不会重复查。
   没查到新版、或者连不上服务器，都一声不吭；只有真有新版才弹窗。
   手动点「检查更新」不走这里，随时想查都能查。 */
function updDaily() {
  var r = api('updateAutoDaily', {});
  if (!r.started) return;
  updCheckPoll(0, true);
}

function updCheck() {
  var r = api('updateCheckStart', {});
  if (!r.ok) { toast(r.msg || '开始检查失败'); return; }
  toast('正在检查更新…');
  updCheckPoll(0);
}

/* 自动检查走静默模式：不提示、不打扰，只有发现新版才弹窗。
   手动点的那次保留原来的所有提示。 */
function updCheckPoll(n, silent) {
  setTimeout(function () {
    var r = api('updateCheckPoll', {});
    if (r.running) {
      if (n < 45) updCheckPoll(n + 1, silent);
      else if (!silent) toast('检查超时，请稍后再试');
      return;
    }
    if (!r.ok) {
      if (!silent) toast(r.hint || '检查更新失败');
      return;
    }
    if (!r.newer) {
      if (!silent) toast('已是最新版本 v' + (r.version || (G.health || {}).version || ''));
      return;
    }
    updBox(r);
  }, 600);
}

function updBox(r) {
  var mb = r.size > 0 ? String(Math.round(r.size / 1048576 * 10) / 10) + ' MB' : '大小未知';
  var added = r.added || [];
  var fixed = r.fixed || [];
  var body;
  if (added.length || fixed.length) {
    /* 【v0.40.02】清单给了分条说明，就用「新增了 / 修复了」写出来，一条一句短话。 */
    body = '';
    if (added.length) {
      body += '<div class="tiny" style="margin-top:10px"><b>新增了</b></div>';
      for (var i = 0; i < added.length; i++) {
        body += '<div class="tiny muted" style="margin-top:4px">· ' + esc(added[i]) + '</div>';
      }
    }
    if (fixed.length) {
      body += '<div class="tiny" style="margin-top:10px"><b>修复了</b></div>';
      for (var j = 0; j < fixed.length; j++) {
        body += '<div class="tiny muted" style="margin-top:4px">· ' + esc(fixed[j]) + '</div>';
      }
    }
  } else {
    /* 老清单没有分条说明，照旧显示整段文字。 */
    body = '<div class="tiny muted" style="margin-top:9px;white-space:pre-wrap">' +
           esc(r.notes || '本次更新没有附带说明') + '</div>';
  }
  var html =
    '<div class="tiny">发现新版本 <b>v' + esc(r.version || '') + '</b>' +
    '，当前 v' + esc((G.health || {}).version || '') + '</div>' +
    body +
    '<div class="tiny muted" style="margin-top:9px">安装包约 ' + esc(mb) + '</div>' +
    '<div id="updProg" class="tiny" style="margin-top:9px"></div>' +
    '<div class="two" style="margin-top:12px">' +
      '<button class="btn" data-no>稍后</button>' +
      '<button class="btn pri" id="updGo">下载更新</button>' +
    '</div>';
  openBox('检查更新', html, null, function () {
    var go = el('updGo');
    if (go) go.onclick = function () { updDownload(); };
  });
}

function updDownload() {
  var r = api('updateDownloadStart', {});
  if (!r.ok) { toast(r.msg || '开始下载失败'); return; }
  var go = el('updGo');
  if (go) { go.disabled = true; go.textContent = '下载中…'; }
  updDownloadPoll(0);
}

function updDownloadPoll(n) {
  setTimeout(function () {
    var r = api('updateDownloadPoll', {});
    var pg = el('updProg');
    if (pg && r.running) {
      pg.textContent = r.progress >= 0 ? '下载中 ' + r.progress + '%' : '下载中…';
    }
    if (r.running) {
      if (n < 260) updDownloadPoll(n + 1);
      else toast('下载超时，请检查网络后重试');
      return;
    }
    if (!r.ok) {
      toast(r.error || '下载失败');
      var go = el('updGo');
      if (go) { go.disabled = false; go.textContent = '重试下载'; }
      return;
    }
    if (pg) pg.textContent = '下载完成，已校验安装包';
    var go = el('updGo');
    if (go) { go.disabled = false; go.textContent = '立即安装'; go.onclick = updInstall; }
  }, 600);
}

function updInstall() {
  var r = api('updateInstall', {});
  if (!r.ok) toast(r.msg || '打不开安装器');
  else toast('已交给系统安装器，按提示完成安装');
}

function bindMe() {
  var m = el('main');

  /* 【v0.40】检查更新入口：无预置账号包里这个按钮根本不会渲染。 */
  var mu = el('mUpdate');
  if (mu) mu.onclick = function () { updCheck(); };

  /* 【v0.33 修订八】关于页的 GitHub 入口：交给系统浏览器打开。
     打不开（没装浏览器 / 被拦）时如实提示，不静默失败。 */
  var gh = el('mGh');
  if (gh) gh.onclick = function () {
    var r = api('openUrl', { url: 'https://github.com/Yaxiaohe/usrcloud-android-client' });
    if (!r.ok) toast(r.msg || '打不开浏览器');
  };

  var sa = el('stAsk');
  if (sa) sa.onclick = function () {
    api('askAllFiles', {});
    toast('已跳转系统设置，开启后返回本 app 即可');
  };

  el('mAdd').onclick = function () { editAcc(null); };

  /* 【v0.19】账号表格原文编辑 */
  var mr = el('mRaw');
  if (mr) mr.onclick = function () { editRawTable(); };

  /* 【v0.35】变量排序：列表编辑 + 原文编辑 */
  var mve = el('mVarEdit');
  if (mve) mve.onclick = function () { editVarOrder(); };
  var mvr = el('mVarRaw');
  if (mvr) mvr.onclick = function () { editVarOrderRaw(); };

  /* 【v0.36】置顶站名：同一套编辑器，换一份清单 */
  var mde = el('mDevEdit');
  if (mde) mde.onclick = function () { editDevOrder(); };
  var mdr = el('mDevRaw');
  if (mdr) mdr.onclick = function () { editDevOrderRaw(); };

  /* 【v0.20 新增】恢复出厂预置账号。
     用户反馈「某线路还在程序包里没删掉」—— 查下来是覆盖安装不动私有目录，
     手机里还留着 v0.18 那份 4 账号表（线路丙也在里面）。
     APK 里其实已经只剩 3 个，用户看的是手机里的旧文件。
     既然改不掉，就给一个能主动重铺的入口。 */
  var mReset = el('mReset');
  if (mReset) {
    mReset.onclick = function () {
      /* 【v0.27】不带预置账号的版本：这个按钮就是「清空」，
         标题和正文都不能再说「恢复成 N 个」。 */
      var pc = presetCount();
      confirmBox(pc > 0 ? '恢复出厂预置账号' : '清空账号表',
        '将清掉当前 ' + (G.accounts || []).length + ' 个账号。' +
        (pc > 0
          ? '重新载入软件自带的 ' + pc + ' 个。\n\n' +
            '你自己添加的账号会丢失，密码需要重填。\n'
          : '这个版本不带预置账号，清完就是空表，需要重新添加。\n\n') +
        '如果只是想删掉某一个账号，用账号行右边的「删除」就够了。',
        function () {
          var r = api('accountsReset', {});
          if (!r.ok) { toast(r.msg || '恢复失败'); return; }
          G.accounts = r.accounts;
          G.picked = {};
          loadRules();
          V_me();
          toast(pc > 0
            ? '已恢复出厂预置 ' + (r.accounts || []).length + ' 个账号'
            : '账号表已清空');
        });
    };
  }

  /* 【v0.19】登录自检。
     用户分不清「登录失败」和「站点过滤把设备全滤掉了」这两种情况，
     表现都是「看不到设备」，只能笼统说成登不上。
     这里分开报：登录通不通 / 过滤前几台 / 过滤后几台。 */
  m.querySelectorAll('[data-ts]').forEach(function (n) {
    n.onclick = function () {
      var nm = n.getAttribute('data-ts');
      toast('正在测试「' + nm + '」…');
      /* 同步桥接，网络慢时会卡住界面，但账号数量少、接口快，
         换来的是「点了立刻有确切结果」，比转圈更好。
         超时由后端的 30 秒兜底。 */
      var r = api('accountTest', { name: nm });
      if (!r.ok) { toast(r.msg || '测试失败'); return; }
      openBox(nm + ' · 登录自检',
        '<div class="tl">' +
        '<div class="row" style="margin-bottom:8px"><span>登录</span><span class="sp"></span>' +
        (r.login ? '<span class="pill g">成功</span>'
          : '<span class="pill r">失败</span>') + '</div>' +
        (r.hasFilter
          ? '<div class="row" style="margin-bottom:8px"><span>站点过滤</span><span class="sp"></span>' +
          '<span class="pill y">' + esc(r.kws) + '</span></div>' +
          '<div class="row" style="margin-bottom:8px"><span>设备数</span><span class="sp"></span>' +
          '<span><b>' + r.filtered + '</b> / ' + r.total + ' 台</span></div>'
          : '<div class="row" style="margin-bottom:8px"><span>设备数</span><span class="sp"></span>' +
          '<span><b>' + r.total + '</b> 台（未设过滤）</span></div>') +
        '<div class="muted tiny" style="margin-top:10px;line-height:1.7">' +
        esc(r.hint || '') + '</div>' +
        '</div>' +
        '<div class="two" style="margin-top:14px"><button data-no>关闭</button></div>');
    };
  });

  m.querySelectorAll('[data-ed]').forEach(function (n) {
    n.onclick = function () {
      var nm = n.getAttribute('data-ed');
      var a = G.accounts.filter(function (x) { return x.name === nm; })[0];
      if (a) editAcc(a);
    };
  });
  m.querySelectorAll('[data-tg]').forEach(function (n) {
    n.onclick = function () {
      var nm = n.getAttribute('data-tg');
      var r = api('accountToggle', { name: nm });
      if (r.ok) { G.accounts = r.accounts; toast(okOf(r)); V_me(); }
      else toast(r.msg || '操作失败');
    };
  });
  m.querySelectorAll('[data-dl]').forEach(function (n) {
    n.onclick = function () {
      var nm = n.getAttribute('data-dl');
      confirmBox('删除账号', '确定删除「' + nm + '」？该操作不可撤销。', function () {
        var r = api('accountDel', { name: nm });
        if (r.ok) { G.accounts = r.accounts; toast('已删除'); V_me(); }
        else toast(r.msg || '删除失败');
      });
    };
  });

  el('rAdd').onclick = function () { editRule(null); };
  /* 重复提醒策略。
     保存时要连 rules 数组一起提交（后端 rulesSave 是整份覆盖），
     所以这里先拿一份当前配置改两个字段再整体存回去，
     不能只存单字段，那样会把用户已配的规则清空。 */
  function saveRepeat(onlyOn, cd) {
    var r0 = api('rulesGet', {});
    if (!r0.ok) { toast('读取规则失败'); return; }
    /* 注意层级：rulesGet 返回 {ok, rules:{...}}，配置在 .rules 里，
       不是扁平的。读错一层的话 version/flag_blank 全是 undefined，
       存回去就把用户的设置冲掉了。 */
    var cfg = r0.rules || {};
    var next = {
      version: cfg.version || 1,
      stale_minutes: cfg.stale_minutes,
      flag_blank: cfg.flag_blank,
      notify_on_change_only: onlyOn,
      repeat_cooldown_min: cd,
      rules: cfg.rules || []
    };
    var r = api('rulesSave', { rules: next });
    if (!r.ok) { toast(r.msg || '保存失败'); return; }
    loadRules();
    V_me();
    toast(onlyOn ? '已改为只在状态变化时提醒' : '已改为每轮巡检都提醒');
  }

  var rs = el('repSeg');
  if (rs) rs.querySelectorAll('[data-rep]').forEach(function (n) {
    n.onclick = function () {
      if (n.classList.contains('on')) return;
      saveRepeat(n.getAttribute('data-rep') === '1',
        (G.rules && G.rules.repeat_cooldown_min != null)
          ? G.rules.repeat_cooldown_min : 60);
    };
  });
  var cs = el('cdSeg');
  if (cs) cs.querySelectorAll('[data-cd]').forEach(function (n) {
    n.onclick = function () {
      if (n.classList.contains('on')) return;
      saveRepeat(false, parseInt(n.getAttribute('data-cd'), 10));
    };
  });

  /* 【v0.21 新增】编辑规则入口。
     原来规则只能删了重加，改个阈值都得重来一遍。 */
  m.querySelectorAll('[data-re]').forEach(function (n) {
    n.onclick = function () {
      editRule(parseInt(n.getAttribute('data-re'), 10));
    };
  });

  m.querySelectorAll('[data-rd]').forEach(function (n) {
    n.onclick = function () {
      var i = parseInt(n.getAttribute('data-rd'), 10);
      confirmBox('删除规则', '确定删除第 ' + (i + 1) + ' 条规则？', function () {
        var r = api('rulesDel', { index: i });
        if (r.ok) { loadRules(); toast('已删除'); V_me(); }
        else toast(r.msg || '删除失败');
      });
    };
  });
  el('rTest').onclick = function () {
    var r = api('alertsPushTest', {});
    if (!r.ok) { toast(r.msg || '发送失败'); return; }
    /* 如实反馈。后端 v0.08 之前无条件回 ok，前端就弹「已发出，请看下拉通知栏」，
       但实际从没发过任何系统通知，用户点完什么都没发生还以为是手机的问题。 */
    if (r.pushed) {
      toast('已发出测试提醒，请看下拉通知栏');
    } else {
      toast(r.reason || '通知未发出，提醒只记录在 app 内');
    }
  };
  var nb = el('btnNotif');
  if (nb) nb.onclick = function () {
    api('openNotifSettings', {});
    toast('在系统设置里找到「有人云巡站」，把通知打开');
  };
  /* 【v0.20】电池优化白名单入口。权限正常却收不到通知时，问题几乎都在这。 */
  var bb = el('btnBattery');
  if (bb) bb.onclick = function () {
    api('batteryOpt', {});
    toast('在弹出的列表里选「有人云巡站」，允许后台运行');
  };
  el('rClr').onclick = function () {
    confirmBox('清空提醒', '删除全部提醒记录？', function () {
      var r = api('alertsClear', {});
      if (r.ok) { toast('已清空'); pollWatch(); V_me(); }
    });
  };

  m.querySelectorAll('[data-wk]').forEach(function (n) {
    n.onclick = function () {
      var w = parseInt(n.getAttribute('data-wk'), 10);
      var r = api('setWorkers', { workers: w });
      if (r.ok) {
        G.health.workers = r.workers;
        toast('并发线程数 = ' + r.workers);
        V_me();
      } else toast(r.msg || '设置失败');
    };
  });

  /* 【v0.26】陈旧判定阈值分段选择 */
  m.querySelectorAll('[data-sm]').forEach(function (n) {
    n.onclick = function () {
      var v = parseInt(n.getAttribute('data-sm'), 10);
      var r = api('setStaleMin', { minutes: v });
      if (r.ok) {
        G.health.staleMinutes = r.staleMinutes;
        toast('陈旧判定阈值 = ' + r.staleMinutes + ' 分钟');
        V_me();
      } else toast(r.msg || '设置失败');
    };
  });
}

/* ---------- 账号表格原文编辑（v0.19） ---------- */

/* 把 station_kw 显示成一行文本。【v0.20】
   后端返回的可能是数组，也可能是历史上被写脏的字符串 "[]" / "[\"3号\"]"。
   统一在这里剥掉成对方括号引号 —— 纯符号归一成空串，
   免得用户打开弹窗看到 "[]" 以为是自己上次填的、怎么删都删不掉。 */
function kwText(a) {
  var raw = a ? a.station_kw : '';
  if (raw == null) return '';
  if (Array.isArray(raw)) raw = raw.join(',');
  raw = String(raw)
    .replace(/["'\u201c\u201d\u2018\u2019]/g, '')
    .replace(/[\[\]\{\}\(\)]/g, '')
    .trim();
  if (!raw) return '';
  return raw.split(/[,，、;；\s]+/).filter(function (x) {
    return x.trim();
  }).join('、');
}

/* 站点过滤字段的常见错误提示。
   这些都不是「登录失败」，但表现上完全一样 —— 看不到设备，
   用户只会怀疑账号密码。把话说清楚能省掉大量来回。 */
var STATION_KW_TIPS = [
  ['[', '不要带方括号。填：白彦花、乌海、五原（用顿号或逗号分隔）'],
  ['"', '不要带英文双引号。直接填关键词本身'],
  ["'", '不要带英文单引号。直接填关键词本身'],
  ['{', '不要带花括号，那是 JSON 写法，这里填纯文本'],
  ['、,，;；', '多个关键词之间用顿号或逗号分隔']
];

function stationKwTip(v) {
  for (var i = 0; i < STATION_KW_TIPS.length; i++) {
    var key = STATION_KW_TIPS[i][0];
    if (v.indexOf(key) >= 0) return STATION_KW_TIPS[i][1];
  }
  return '';
}

/* ---------- 置顶清单编辑器（v0.35 变量 / v0.36 站名） ----------
 *
 * 两处用的是同一个编辑器：一行一个关键词，↑ ↓ 调先后，✕ 删。
 * **每次改动立刻落盘**（不设「保存」按钮）：手机上一旦要用户记住
 * 「改完还得点一下」，十次里有三次会漏点，然后说「配了没用」。
 * 落盘失败会把列表回滚成服务器上的那一份，界面上不会出现「看着改了其实没改」。
 *
 * DOM 用通用 id（pinList / pinKw / pinAdd / pinTip / pinRaw / pinRawSave）：
 * 弹窗同时只会开一个，两套 id 反而要多维护一倍选择器。
 */
var PIN = null;      // 当前正在编辑的清单（cfg + 列表）

function pinWarn(k) {
  /* 前端只做轻提示，最终把关在 Java（PinList.warn 是同一套口径）：
     两处都查是为了让用户在点之前就看见问题，不是两套规则。 */
  if (!k) return '请先输入关键词';
  if (k.indexOf(',') >= 0) return '关键词里不要带逗号（会被当成两列）';
  if (k.length > 20) return '关键词太长（' + k.length + ' 字），建议不超过 20 字';
  return '';
}

function paintPin() {
  var box = el('pinList');
  if (!box || !PIN) return;
  var cur = PIN.list;
  if (!cur.length) {
    box.innerHTML = '<div class="empty" style="padding:10px 0">' +
      '<span class="tiny">' + esc(PIN.empty || '还没有置顶项 —— 下面输入关键词添加') + '</span></div>';
    return;
  }
  box.innerHTML = cur.map(function (k, i) {
    return '<div class="row" style="padding:9px 0;border-top:1px solid #f1f3f7">' +
      '<span class="mono tiny muted" style="width:20px;flex:0 0 20px">' + (i + 1) + '</span>' +
      '<span style="font-size:14px;flex:1 1 auto;min-width:0;word-break:break-all">' +
      esc(k) + '</span>' +
      '<button class="sm" data-pin-up="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="sm" data-pin-dn="' + i + '"' +
      (i === cur.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="sm dan" data-pin-rm="' + i + '">✕</button>' +
      '</div>';
  }).join('');

  box.querySelectorAll('[data-pin-up]').forEach(function (b) {
    b.onclick = function () { movePin(parseInt(b.getAttribute('data-pin-up'), 10), -1); };
  });
  box.querySelectorAll('[data-pin-dn]').forEach(function (b) {
    b.onclick = function () { movePin(parseInt(b.getAttribute('data-pin-dn'), 10), 1); };
  });
  box.querySelectorAll('[data-pin-rm]').forEach(function (b) {
    b.onclick = function () {
      PIN.list.splice(parseInt(b.getAttribute('data-pin-rm'), 10), 1);
      savePin();
    };
  });
}

function movePin(i, d) {
  if (!PIN) return;
  var j = i + d;
  if (j < 0 || j >= PIN.list.length) return;
  var t = PIN.list[i];
  PIN.list[i] = PIN.list[j];
  PIN.list[j] = t;
  savePin();
}

function savePin() {
  if (!PIN) return;
  var r = api(PIN.saveApi, { list: PIN.list });
  if (r.ok) {
    PIN.list = (r.list || []).slice();
    var tip = el('pinTip');
    if (tip) tip.innerHTML = '<span style="color:#128a3a">' + esc(okOf(r)) + '</span>';
    paintPin();
    if (PIN.onSaved) PIN.onSaved(PIN.list.slice());
  } else {
    /* 写明「已回滚到保存前的样子」，别让用户以为改成了 */
    toast(okOf(r, '保存失败'));
    var g = api(PIN.getApi, {});
    if (g.ok) {
      PIN.list = (g.list || []).slice();
      if (PIN.onSaved) PIN.onSaved(PIN.list.slice());
    }
    paintPin();
  }
}

function addPin() {
  if (!PIN) return;
  var inp = el('pinKw');
  var tip = el('pinTip');
  if (!inp) return;
  var k = (inp.value || '').trim();
  var w = pinWarn(k);
  if (w) {
    if (tip) tip.innerHTML = '<span style="color:#d33d3d">' + esc(w) + '</span>';
    return;
  }
  for (var i = 0; i < PIN.list.length; i++) {
    if (PIN.list[i] === k) {
      if (tip) tip.innerHTML = '<span style="color:#d98a00">「' + esc(k) + '」已经在列表里了</span>';
      return;
    }
  }
  if (PIN.list.length >= 60) {
    if (tip) tip.textContent = '最多 60 条';
    return;
  }
  PIN.list.push(k);
  inp.value = '';
  if (tip) tip.textContent = '';
  savePin();
}

/**
 * cfg: { title, hint, placeholder, empty, list, getApi, saveApi,
 *        path, text, rawApi, rawTitle, onSaved }
 */
function openPinEditor(cfg) {
  PIN = cfg;
  PIN.list = (cfg.list || []).slice();

  openBox(cfg.title,
    '<div class="muted tiny" style="margin-bottom:10px;line-height:1.75">' + cfg.hint + '</div>' +
    '<div id="pinList"></div>' +
    '<div class="row" style="margin-top:12px">' +
    /* 【v0.36 修订】输入框的 flex-basis 给 0：让它只吃剩余宽度，
       不再按 placeholder 的文字长度参与分配。配合 index.html 的
       .row>button{flex:0 0 auto}，按钮才不会被压成两行。 */
    '<input id="pinKw" placeholder="' + esc(cfg.placeholder || '关键词') + '" ' +
    'style="flex:1 1 0;min-width:0;padding:0 10px;height:36px">' +
    '<button class="sm pri" id="pinAdd" style="height:36px">＋ 置顶</button>' +
    '</div>' +
    '<div id="pinTip" class="muted tiny" style="margin-top:8px"></div>' +
    '<div class="two" style="margin-top:14px"><button class="pri" data-ok>完成</button></div>',
    /* 「完成」只是关窗：改动在 ↑↓✕ 那一刻就落盘了。
       这里必须给 onOk（哪怕直接返回 true），否则 openBox 不会绑 data-ok，
       按钮会变成一个按下去没反应的死键。 */
    function () { return true; },
    function () {
      el('pinAdd').onclick = function () { addPin(); };
      el('pinKw').onkeydown = function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) addPin();
      };
      paintPin();
    });
}

function openPinRaw(cfg) {
  openBox(cfg.rawTitle,
    '<div class="muted tiny" style="margin-bottom:9px;line-height:1.7">' +
    '一行一个关键词，越上面优先级越高。<br>' +
    '位置：<span class="mono" style="word-break:break-all">' +
    esc(cfg.path || '') + '</span></div>' +
    '<textarea id="pinRaw" style="width:100%;height:200px;font-size:12px;' +
    'line-height:1.6;font-family:ui-monospace,Menlo,Consolas,monospace;' +
    'border:1px solid #dde1e8;border-radius:8px;padding:8px">' +
    esc(cfg.text || '') + '</textarea>' +
    '<div id="pinRawTip" class="muted tiny" style="margin-top:8px"></div>' +
    '<div class="two" style="margin-top:14px">' +
    '<button data-no>取消</button><button class="pri" id="pinRawSave">保存</button></div>',
    null,
    function () {
      var tip = el('pinRawTip');
      function check() {
        var v = el('pinRaw').value;
        var lines = v.split('\n').filter(function (x) {
          return x.trim() && x.trim().charAt(0) !== '#';
        });
        var head = lines.length && lines[0].split(',')[0].trim() === cfg.header ? 1 : 0;
        var n = lines.length - head;
        if (!n) {
          tip.innerHTML = '<span style="color:#d33d3d">没有关键词，保存会失败（原表不动）</span>';
        } else {
          tip.textContent = '共 ' + n + ' 条（表头行不计数）';
        }
      }
      el('pinRaw').oninput = check;
      check();

      el('mbox').querySelector('[data-no]').onclick = closeBox;
      var sv = el('pinRawSave');
      sv.onclick = function () {
        sv.disabled = true;
        sv.textContent = '保存中…';
        var res = api(cfg.rawApi, { text: el('pinRaw').value });
        sv.disabled = false;
        sv.textContent = '保存';
        if (!res.ok) {
          tip.innerHTML = '<span style="color:#d33d3d">' + esc(res.msg || '保存失败') +
            '（原表没动）</span>';
          return;
        }
        if (cfg.onSaved) cfg.onSaved((res.list || []).slice());
        toast(okOf(res));
        closeBox();
        if (G.tab === 'me') V_me();
      };
    });
}

/* 变量排序（v0.35） */
function editVarOrder() {
  var r = api('varOrder', {});
  if (!r.ok) { toast('读取变量排序失败'); return; }
  openPinEditor({
    title: '变量排序（置顶）',
    hint: '排在上面的是置顶变量，行序就是显示顺序。没置顶的按默认排：' +
      '出水/供水 → 进水/回水 → 其它水温 → 其它温度 → 其余。<br>' +
      '改动即时生效，监控、截图、历史三处一起变。',
    placeholder: '关键词，如 出水温度',
    empty: '还没有置顶项 —— 下面输入关键词添加',
    list: r.list,
    getApi: 'varOrder',
    saveApi: 'varOrderSave',
    onSaved: function (l) { G.vars = l; if (G.tab === 'me') V_me(); }
  });
}

function editVarOrderRaw() {
  var r = api('varOrder', {});
  if (!r.ok) { toast('读取排序表失败'); return; }
  openPinRaw({
    rawTitle: '变量排序表（CSV 原文）',
    header: '关键词',
    path: r.path, text: r.text, rawApi: 'varOrderRawSave',
    onSaved: function (l) { G.vars = l; }
  });
}

/* 置顶站名（v0.36） */
function editDevOrder() {
  var r = api('devOrder', {});
  if (!r.ok) { toast('读取置顶站名失败'); return; }
  openPinEditor({
    title: '置顶站名',
    hint: '排在上面的站点在设备列表和截图列表里都排最前，其余保持原来的顺序。<br>' +
      '关键词按「包含」匹配设备名，写「某线路」就能把这条线上的站一起顶上去。',
    placeholder: '关键词，如 站点C西',
    empty: '还没有置顶站点 —— 下面输入站名关键词',
    list: r.list,
    getApi: 'devOrder',
    saveApi: 'devOrderSave',
    onSaved: function (l) { G.devPins = l; if (G.tab === 'me') V_me(); }
  });
}

function editDevOrderRaw() {
  var r = api('devOrder', {});
  if (!r.ok) { toast('读取站名表失败'); return; }
  openPinRaw({
    rawTitle: '置顶站名表（CSV 原文）',
    header: '站名关键词',
    path: r.path, text: r.text, rawApi: 'devOrderRawSave',
    onSaved: function (l) { G.devPins = l; }
  });
}

function editRawTable() {
  var r = api('accountsRaw', {});
  if (!r.ok) { toast('读取账号表格失败'); return; }

  openBox('账号表格（CSV 原文）',
    '<div class="muted tiny" style="margin-bottom:9px;line-height:1.7">' +
    '这就是实际保存的表格内容，一行一个账号，逗号分隔。<br>' +
    '位置：<span class="mono" style="word-break:break-all">' +
    esc(r.path || '') + '</span></div>' +
    '<textarea id="rawBox" class="ta" style="height:230px;font-size:12px;' +
    'line-height:1.6;font-family:ui-monospace,Menlo,Consolas,monospace">' +
    esc(r.text || '') + '</textarea>' +
    '<div id="rawTip" class="muted tiny" style="margin-top:8px"></div>' +
    '<div class="two" style="margin-top:14px">' +
    '<button data-no>取消</button><button class="pri" id="rawSave">保存</button></div>',
    /* 【v0.19】第 4 参数是 onOpen（弹窗落地回调），第 3 个 onOk 才是点保存。
       实时校验必须绑在 onOpen，否则用户看到的是空提示位，
       要等点一次保存才「突然」出现。 */
    null,
    function () {
      var tip = el('rawTip');

      /* 前端先做一遍轻量检查，只提示不拦。
         最终把关在后端（Java 侧有完整的 CSV 解析），
         前端这套只是让用户在点保存之前就看见问题。 */
      function check() {
        var v = el('rawBox').value;
        var lines = v.split('\n').filter(function (x) {
          return x.trim() && x.trim().charAt(0) !== '#';
        });
        var warn = [];
        if (!v.trim()) {
          tip.innerHTML = '<span style="color:#d33d3d">内容为空，保存会失败（原表不会有改动）</span>';
          return;
        }
        lines.slice(1).forEach(function (ln, i) {
          var kw = ln.split(',')[5] || '';
          var t = stationKwTip(kw);
          if (t) warn.push('第 ' + (i + 2) + ' 行站点过滤' + t);
        });
        if (warn.length) {
          tip.innerHTML = '<span style="color:#d98a00">' +
            esc(warn.slice(0, 3).join('；')) + '</span>';
        } else {
          tip.textContent = '共 ' + Math.max(0, lines.length - 1) + ' 个账号';
        }
      }
      el('rawBox').oninput = check;
      check();

      /* openBox 已经绑了 data-ok，这里我们自己控制保存 */
      el('mbox').querySelector('[data-no]').onclick = closeBox;
      var sv = el('rawSave');
      sv.onclick = function () {
        sv.disabled = true;
        sv.textContent = '保存中…';
        var res = api('accountsRawSave', { text: el('rawBox').value });
        sv.disabled = false;
        sv.textContent = '保存';
        if (!res.ok) {
          /* 明确说「原表没动」，否则用户会以为已经改坏了 */
          tip.innerHTML = '<span style="color:#d33d3d">' + esc(res.msg || '保存失败') +
            '<br>原表没有改动。</span>';
          return;
        }
        closeBox();
        G.accounts = res.accounts;
        loadRules();
        V_me();
        toast('已保存 ' + (res.count || G.accounts.length) + ' 个账号');
      };
    });
}

/* ---------- 账号编辑 ---------- */
function editAcc(a) {
  var isNew = !a;
  a = a || { name: '', account: '', password: '', platform_id: 'W3rfV', enabled: true, station_kw: [] };
  openBox(isNew ? '新增账号' : '编辑账号',
    '<label class="fl">名称 *</label><input id="eName" value="' + esc(a.name) + '" placeholder="如：示例账号">' +
    '<label class="fl">账号（手机号）*</label><input id="eAcc" value="' + esc(a.account) + '">' +
    '<label class="fl">密码 *</label><input id="ePwd" type="password" value="' + esc(a.password) + '">' +
    '<label class="fl">平台ID</label><input id="ePf" value="' + esc(a.platform_id) + '">' +
    '<label class="fl">站点过滤（编号，逗号分隔，留空=全部）</label>' +
    '<input id="eKw" value="' + esc(kwText(a)) + '">' +
    /* 【v0.19】就地提示格式错误。
       用户把站点过滤填成 ["3号"] 这种带方括号的形式，
       结果 12 台设备全被滤掉，表现为「登不上」，
       实际跟账号密码毫无关系 —— 不在填的时候说清楚，
       用户只会反复重输密码。 */
    /* 【v0.40.03】原来 margin-top:-4px 把提示文字吸到输入框下边框上，
       看着像粘在框里。改成正常间距，和上面的填写框拉开。 */
    '<div id="kwTip" class="muted tiny" style="margin-top:6px;line-height:1.6"></div>' +
    '<label class="fl" style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
    '<input type="checkbox" id="eEn" style="width:19px;height:19px;flex:0 0 auto"' +
    (a.enabled ? ' checked' : '') + '> 启用此账号</label>' +
    '<div class="two" style="margin-top:16px"><button data-no>取消</button>' +
    '<button class="pri" data-ok>保存</button></div>',
    /* onOk：点保存 */
    function () {
      var nm = el('eName').value.trim();
      var ac = el('eAcc').value.trim();
      var pw = el('ePwd').value.trim();
      if (!nm || !ac) { toast('名称和账号不能为空'); return false; }
      if (!pw) { toast('密码不能为空'); return false; }
      var kws = el('eKw').value.split(/[,，、;；\s]+/).map(function (x) {
        return x.trim();
      }).filter(function (x) { return x; });
      var r = api('accountSave', {
        old_name: isNew ? '' : a.name,
        name: nm, account: ac, password: pw,
        platform_id: el('ePf').value.trim() || 'W3rfV',
        enabled: el('eEn').checked,
        station_kw: kws
      });
      if (!r.ok) { toast(r.msg || '保存失败'); return false; }
      G.accounts = r.accounts;
      G.picked = {};
      toast(okOf(r));
      V_me();
    },
    /* onOpen：站点过滤实时校验。
       必须和 onOk 分开 —— 绑在 onOk 里的话，用户打开弹窗看到的是空的提示位，
       要点一次保存才「突然」冒出来提醒，等于没提醒。 */
    function () {
      var kwIn = el('eKw');
      var tip = el('kwTip');
      if (!kwIn || !tip) return;
      function kwCheck() {
        var t = stationKwTip(kwIn.value);
        if (t) {
          tip.innerHTML = '<span style="color:#d98a00">⚠ ' + esc(t) + '</span>';
        } else if (kwIn.value.trim()) {
          /* 分隔符必须和后端 Account.keywords() 完全一致（顿号也在内），
             否则用户用顿号分隔时前端算一个、后端算多个，提示的数字是错的。 */
          var n = kwIn.value.split(/[,，、;；\s]+/).filter(function (x) {
            return x.trim();
          }).length;
          tip.textContent = '将只显示设备名里含这些字号的设备（' + n + ' 个关键词）';
        } else {
          tip.textContent = '留空 = 显示该账号全部设备';
        }
      }
      kwIn.oninput = kwCheck;
      kwCheck();
    });
}

/* ---------- 规则输入：实时命中预览（v0.40.04，v0.40.06 修全角空格） ----------
   三个框（账号/设备名/变量名）输入到一半，就告诉用户两件事：
     ① 当前写法是什么功能（* 全部 / 普通包含 / = 一字不差 / 带 * 片段）
     ② 按现有清单实际命中了哪些、几个
   命中语义必须和 Java Watch.matchRuleField 一字不差，否则这里说命中、
   后端却不提醒，比不提示更坑。所以下面 ruleFieldMatch 是后端那段的逐句复刻。 */
/* Java 的 String.trim() 只去码点 <= U+0020 的字符；JS 原生 trim() 还会去掉
   全角空格 U+3000、不换行空格 U+00A0 等。用原生 trim 会让界面说「全部」、
   后端却按字面包含全角空格匹配，两边对不上。这里逐字复刻 Java 的口径。 */
function javaTrim(v) {
  return String(v == null ? '' : v).replace(/^[\x00-\x20]+/, '').replace(/[\x00-\x20]+$/, '');
}

function ruleFieldMatch(pat, s) {
  if (pat == null || pat === '' || javaTrim(pat) === '*') return true;
  /* 空名字这里不放行、也不提前判死：Java matchRuleField 只挡 null，
     名字是空串时继续走——写「=」或纯空格，两边都算「全部」。
     提前 return false 会让界面说命中 0 个、后端照常提醒，宁可照抄后端。 */
  if (s == null) return false;
  var p = javaTrim(pat);
  if (p.charAt(0) === '=') {
    var name = javaTrim(p.slice(1));
    return name === '' ? true : s === name;
  }
  if (p.indexOf('*') < 0) return String(s).indexOf(p) >= 0;
  /* 与 Java wmatch 一致：按 * 切段，各段去空格后 OR 命中任一段即可。
     Java 用 Pattern.quote 做字面比较，这里用 indexOf 同样是字面比较，
     元字符不会被当成正则 —— 语义对齐，不是近似。 */
  var parts = p.split('*').map(javaTrim).filter(function (x) { return x !== ''; });
  if (!parts.length) return true;
  for (var i = 0; i < parts.length; i++) if (String(s).indexOf(parts[i]) >= 0) return true;
  return false;
}

/* 当前写法的功能说明 —— 和 ruleFieldMatch 的四个分支一一对应。 */
function ruleFieldMode(v) {
  v = javaTrim(v);
  if (!v || v === '*') return '全部';
  if (v.charAt(0) === '=') {
    return javaTrim(v.slice(1)) ? '一字不差' : '= 后面还没写名字';
  }
  return v.indexOf('*') >= 0 ? '片段（命中任一段）' : '名称包含';
}

/* 命中清单的真实来源。都取已经加载到本地的数据，不联网、不编造。
   - 账号：G.accounts（启动时 accounts 接口加载）
   - 设备：G.devCache（巡站缓存）+ G.ws.devices（监控状态）合并去重
   - 变量：G.ws.devices[].rows[][0]（监控实际采到的变量名）去重
   还没有数据时返回空数组，界面会如实写「还没有清单」，不假装命中 0 个。 */
function ruleHitSource(kind) {
  var out = [], seen = {};
  function add(s) {
    /* 候选名字按原样交给 ruleFieldMatch —— Java 后端拿到的也是原名，
       不 trim。只用 javaTrim 判空，免得空名字混进清单。 */
    s = s == null ? '' : String(s);
    if (javaTrim(s) && !seen[s]) { seen[s] = true; out.push(s); }
  }
  if (kind === 'acc') {
    (G.accounts || []).forEach(function (a) { add(a && a.name); });
  } else if (kind === 'dev') {
    var cache = G.devCache || {};
    Object.keys(cache).forEach(function (acc) {
      (cache[acc] || []).forEach(function (d) { add(d && d.name); });
    });
    ((G.ws && G.ws.devices) || []).forEach(function (d) { add(d && d.name); });
  } else if (kind === 'var') {
    ((G.ws && G.ws.devices) || []).forEach(function (d) {
      ((d && d.rows) || []).forEach(function (row) { add(row && row[0]); });
    });
  }
  return out;
}

/* 给一个输入框绑实时提示。输入时重算，不输入时在初始化时算一次。 */
function bindRuleHit(inputId, hitId, kind, label) {
  var inp = el(inputId), box = el(hitId);
  if (!inp || !box) return;
  var paint = function () {
    var v = javaTrim(inp.value || '');
    var mode = ruleFieldMode(v);
    var src = ruleHitSource(kind);
    if (!src.length) {
      box.textContent = '当前：' + mode + '；还没有' + label + '清单可比对';
      return;
    }
    var hits = src.filter(function (s) { return ruleFieldMatch(v, s); });
    /* 【v0.40.04 补丁】用户要求只写实际命中几个，不写「/总数」——手机上
       935 个变量那种总数又长又没用，还把名字挤到下一行。 */
    var txt = '当前：' + mode + ' · 命中 ' + hits.length + ' 个' + label;
    if (hits.length) {
      txt += '：' + hits.slice(0, 6).join('、') + (hits.length > 6 ? '…' : '');
    }
    box.textContent = txt;
  };
  inp.oninput = paint;
  paint();
}

/* ---------- 规则编辑 ---------- */
/* 【v0.21】改签名：接索引而不是对象引用。
   原来用 (G.rules.rules||[]).indexOf(r) 反查索引 ——
   规则数组一旦被别处重新赋值（比如 loadRules 拉了新对象），
   indexOf 返回 -1，代码里 `if (idx < 0) idx = 0` 又会默默改成第 0 条，
   用户改的是第 3 条、保存后变成第 1 条被改。这种 bug 极难察觉。
   直接由调用方传索引，来源唯一。 */
function editRule(idx) {
  var isNew = (idx == null || idx < 0);
  /* 【v0.40.04】规则弹窗直接就可能从「我的」页打开，此时还没进过监控页，
     G.ws 是空的，命中预览就没数据可比对。这里补拉一次本地监控状态
     （只读内存快照、不发网络），让账号/设备/变量的命中清单有真数据。 */
  if (!G.ws) {
    var ws0 = api('watchState', {});
    if (ws0 && ws0.ok) G.ws = ws0;
  }
  var list = (G.rules && G.rules.rules) || [];
  var r = isNew
      ? { acc: '*', dev: '*', var: '*', kind: 'offline', op: 'gt', val: 0, stale_min: 15 }
      : list[idx];
  if (!r) r = { acc: '*', dev: '*', var: '*', kind: 'offline', op: 'gt', val: 0, stale_min: 15 };
  var keepIdx = idx;
  openBox(isNew ? '新增规则' : '编辑规则',
    /* 【v0.33】规则名称输入框，放在类型之上、账号之前 ——
       用户原话「在账号上面加一个框供用户自定义填写这条规则的名称」。
       它是这条规则的「标题」：下拉通知栏一屏都是长设备名时，
       靠名字才能认出是哪条规则报的。留空也能存，
       留空时通知标题照旧用设备名，老规则不受影响。 */
    '<label class="fl">规则名称（选填，用于在通知里认出这条规则）</label>' +
    '<input id="rName" maxlength="30" placeholder="如：冬季供水温度过低" value="' +
    esc(r.rule_name || '') + '">' +
    /* 【v0.40.03】类型改成软件同款选择行 + 白底蓝字选项列表。
       原生 <select> 在 WebView 里弹系统绿圆钮单选框，跟整体样式割裂。
       select 仍保留（隐藏）作为值的唯一来源，测试照旧能读/写/触发 change。 */
    '<label class="fl">类型</label>' +
    '<select id="rKind" style="display:none">' +
    KINDS.map(function (k) {
      return '<option value="' + k.v + '"' + (r.kind === k.v ? ' selected' : '') + '>' +
        k.t + '</option>';
    }).join('') + '</select>' +
    '<button id="rKindPick" class="pick"><span class="pf" id="rKindText">' +
    esc(kindText(r.kind)) + '</span><span class="ar">›</span></button>' +
    '<div id="rKindOpts" class="optlist" style="display:none">' +
    KINDS.map(function (k) {
      return '<div class="op' + (r.kind === k.v ? ' on' : '') + '" data-kind="' + k.v + '">' +
        '<span>' + k.t + '</span><span class="ck">' + (r.kind === k.v ? '✓' : '') + '</span></div>';
    }).join('') + '</div>' +
    /* 【v0.40.04】三栏说明改短：一句讲清规则，例子交给下方实时的「命中 N 个」。
       规则不变：* 全部 / 普通写法按包含 / = 开头一字不差 / 带 * 按片段。 */
    '<label class="fl">账号（* 全部；写法按包含；=开头 一字不差）</label>' +
    '<input id="rAcc" value="' + esc(r.acc || '*') + '">' +
    '<div class="muted tiny rHit" id="rAccHit"></div>' +
    '<label class="fl">设备名（* 全部；写法按包含；=开头 一字不差）</label>' +
    '<input id="rDev" value="' + esc(r.dev || '*') + '">' +
    '<div class="muted tiny rHit" id="rDevHit"></div>' +
    '<div id="rStaleBox"' + (r.kind === 'stale' ? '' : ' style="display:none"') + '>' +
    '<label class="fl">停更超过（分钟）</label>' +
    '<input id="rStale" type="number" value="' + (r.stale_min || 15) + '"></div>' +
    '<div id="rValBox"' + (r.kind === 'value' ? '' : ' style="display:none"') + '>' +
    /* 【v0.38g】变量名匹配粒度：用一个 = 提示符显式区分，默认部分包含。
       用户原话：「加个提示符来区分是完全遵守输入的变量还是部分包含就行，
       默认部分包含，在说明中写好」。片段通配功能本身没问题，一个字没动。
       输入框顺手关掉自动填充：真机上输入「进水温度」会弹出历史候选
       （比如「风机化霜出水温度」）挡住半个弹窗，点一下就填错变量。 */
    '<label class="fl">变量名（* 全部；写法按包含；=开头 一字不差）</label>' +
    '<input id="rVar" autocomplete="off" placeholder="温度 或 =进水温度 或 *" value="' +
    esc((r.var_exact ? '=' : '') + (r.var || '*')) + '">' +
    '<div class="muted tiny rHit" id="rVarHit"></div>' +
    '<label class="fl">条件</label><div class="row">' +
    '<select id="rOp" style="width:44%">' +
    OPS.map(function (o) {
      return '<option value="' + o.v + '"' + (r.op === o.v ? ' selected' : '') + '>' +
        o.t + '</option>';
    }).join('') + '</select>' +
    /* 【v0.27】输入框带 placeholder 标明哪个是下限哪个是上限。
       之前两个光秃秃的数字框，用户不知道先填的是啥；
       提示语「大于下限且小于上限」也拗口，重写成大白话。 */
    '<input id="rVal" type="number" step="0.01" style="flex:1" placeholder="阈值" value="' +
    (r.val == null ? 0 : r.val) + '">' +
    /* 【v0.26】区间条件的上限。只在区间类 op 时显示（onchange 里切换）。
       【v0.33】notinrange（不在区间内）同样需要第二个框。 */
    '<input id="rVal2" type="number" step="0.01" style="flex:1' +
    (r.op === 'range' || r.op === 'notinrange' ? '' : ';display:none') +
    '" placeholder="上限" value="' +
    (r.val2 == null ? 0 : r.val2) + '"></div>' +
    '<div class="tiny muted" id="rOpHint" style="margin-top:6px">' +
    (r.op === 'range' ? RANGE_HINT
      : (r.op === 'notinrange' ? NOTIN_RANGE_HINT : '')) + '</div></div>' +
    '<div class="two" style="margin-top:16px">' +
    (isNew ? '<button data-no>取消</button><button class="pri" data-ok>添加</button>'
      : '<button class="dan" data-del2="1">删除</button><button class="pri" data-ok>保存</button>') +
    '</div>');

  el('rKind').onchange = function () {
    var k = this.value;
    el('rStaleBox').style.display = k === 'stale' ? '' : 'none';
    el('rValBox').style.display = k === 'value' ? '' : 'none';
    /* 【v0.40.03】值变了要同步选择行的文字和选项高亮，
       否则下拉选了「数值越限」、上面那行还写着「设备离线」。 */
    var tx = el('rKindText');
    if (tx) tx.textContent = kindText(k);
    var opts = el('rKindOpts');
    if (opts) opts.querySelectorAll('[data-kind]').forEach(function (n) {
      var on = n.getAttribute('data-kind') === k;
      n.classList.toggle('on', on);
      n.querySelector('.ck').textContent = on ? '✓' : '';
    });
  };

  /* 【v0.40.03】点选择行展开软件同款列表；点某项写回 select 并触发 change。
     用 select 当唯一数据源，保存逻辑和原有测试一行都不用改。 */
  var kPick = el('rKindPick');
  var kOpts = el('rKindOpts');
  if (kPick && kOpts) {
    kPick.onclick = function () {
      kOpts.style.display = (kOpts.style.display === 'none') ? '' : 'none';
    };
    kOpts.querySelectorAll('[data-kind]').forEach(function (n) {
      n.onclick = function () {
        var s = el('rKind');
        s.value = n.getAttribute('data-kind');
        s.onchange();
        kOpts.style.display = 'none';
      };
    });
  }

  /* 【v0.40.04】三个框都实时预览：功能说明 + 实际命中清单。 */
  bindRuleHit('rAcc', 'rAccHit', 'acc', '账号');
  bindRuleHit('rDev', 'rDevHit', 'dev', '设备');
  bindRuleHit('rVar', 'rVarHit', 'var', '变量');

/* 【v0.26】切到「介于」时显示上限输入框，并更新提示语与 placeholder。
     【v0.27】placeholder 动态切：区间类第一个框是「下限」，其余是「阈值」。
     【v0.33】反向区间（notinrange）走同一套：也要第二个框、也要下限提示，
     只是提示语换成 NOTIN_RANGE_HINT。 */
el('rOp').onchange = function () {
    var op = this.value;
    var isRange = (op === 'range' || op === 'notinrange');
    el('rVal2').style.display = isRange ? '' : 'none';
    el('rVal').placeholder = isRange ? '下限' : '阈值';
    el('rOpHint').textContent =
        op === 'range' ? RANGE_HINT : (op === 'notinrange' ? NOTIN_RANGE_HINT : '');
  };

  var db = el('mbox').querySelector('[data-del2]');
  if (db) db.onclick = function () {
    closeBox();
    var rr = api('rulesDel', { index: keepIdx });
    if (rr.ok) { loadRules(); toast('已删除'); V_me(); }
  };

  /* 保存/添加（openBox 已绑 data-ok，这里补具体逻辑） */
  var okBtn = el('mbox').querySelector('[data-ok]');
  okBtn.onclick = function () {
    var obj = {
      /* 【v0.33】规则名称。超长截断（后端也限 30），空串就存空串——
         存 undefined 会在覆盖保存时把这个字段整个丢掉。 */
      rule_name: (el('rName').value || '').trim().slice(0, 30),
      acc: el('rAcc').value.trim() || '*',
      dev: el('rDev').value.trim() || '*',
      var: '*',
      kind: el('rKind').value,
      op: el('rOp').value,
      /* 【v0.27】阈值照常先读进来；区间类时下面再按 min/max 归一覆盖 */
      val: parseFloat(el('rVal').value) || 0,
      /* 【v0.26】区间上限。非区间类时也存（默认 0），Java 侧只在区间类用它。 */
      val2: parseFloat(el('rVal2').value) || 0,
      stale_min: parseInt(el('rStale').value, 10) || 15
    };
    /* 【v0.38g】= 提示符只活在输入框里，落盘要拆成两个字段：
       var 存剥掉 = 的真名字，var_exact 存模式。老规则没有这个字段，
       Java 侧 optBoolean 给 false → 默认部分包含，不用迁移数据。 */
    if (obj.kind === 'value') {
      var rv = el('rVar').value.trim() || '*';
      obj.var_exact = rv.charAt(0) === '=';
      obj.var = obj.var_exact ? rv.slice(1).trim() : rv;
      if (!obj.var) { obj.var = '*'; obj.var_exact = false; }
    } else {
      obj.var_exact = false;
    }
    if (obj.kind === 'offline') obj.stale_min = 15;
    /* 【v0.27】介于：min/max 归一，填反了也按「小的=下限、大的=上限」存。
       【v0.33】反向区间同样要归一 —— 「不在 30~8」按语义就该读成「不在 8~30」。 */
    if ((obj.op === 'range' || obj.op === 'notinrange') && obj.val > obj.val2) {
      var tmp = obj.val; obj.val = obj.val2; obj.val2 = tmp;
    }

    var rr;
    if (isNew) {
      rr = api('rulesAdd', { rule: obj });
    } else {
      var cfg = G.rules;
      var list2 = (cfg.rules || []).slice();
      if (keepIdx >= 0 && keepIdx < list2.length) {
        list2[keepIdx] = obj;
      } else {
        list2.push(obj);
      }
      cfg.rules = list2;
      rr = api('rulesSave', { rules: cfg });
    }
    if (rr.ok) {
      closeBox();
      loadRules();
      toast(isNew ? '规则已添加' : '规则已保存');
      V_me();
    } else {
      toast(rr.msg || '保存失败');
    }
  };
}
