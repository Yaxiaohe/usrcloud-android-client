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
  s += '<div class="card" style="position:relative">' +
    '<h2>账号管理<span class="r">' + G.accounts.length + ' 个</span></h2>' +
    '<div class="fab" id="mAdd">＋ 新增</div>';
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
        (a.enabled ? '⏻ 停用' : '⏻ 启用') + '</button>' +
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
  s += '<div class="card" style="position:relative">' +
    '<h2>异常提醒规则<span class="r">' +
    ((G.rules && G.rules.rules) ? G.rules.rules.length : 0) + ' 条</span></h2>' +
    '<div class="fab" id="rAdd">＋ 新增</div>';
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
    '<div class="muted tiny" style="margin-top:9px">线程越多越快，但可能触发平台限速，建议 4。</div>' +
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
    '<span>有人云巡站 v' + esc(h.version || '0.33') + '</span></div>' +
    '<div class="row tiny muted" style="margin-top:7px"><span>说明</span><span class="sp"></span>' +
    '<span>与 Windows 版同一套接口与判定规则</span></div>' +
    '<div class="row tiny muted" style="margin-top:7px"><span>制作</span><span class="sp"></span>' +
    '<span>by Yang</span></div>' +
    /* 【v0.33 修订八】项目地址入口。不用 <a href>：WebView 里直接跳过去
       会变成一个没有地址栏的浏览器，用户既回不去也没法复制链接，
       所以交给系统浏览器（走 Android.openUrl 桥）。 */
    '<div class="row tiny muted" style="margin-top:7px"><span>项目地址</span><span class="sp"></span>' +
    '<span id="mGh" style="color:#2b62e0">GitHub 主页 ›</span></div></div>';

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
      t.push('变量 ' + (r.var || '*') + (op === 'range'
        ? ' 介于 ' + lo + ' ~ ' + hi
        : ' 不在区间内（低于 ' + lo + ' 或 高于 ' + hi + '）'));
    } else {
      t.push('变量 ' + (r.var || '*') + ' ' + opText(op) + ' ' + (r.val == null ? 0 : r.val));
    }
  }
  return t.join(' · ');
}

function opText(v) {
  for (var i = 0; i < OPS.length; i++) if (OPS[i].v === v) return OPS[i].t;
  return '大于';
}

function bindMe() {
  var m = el('main');

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
    '<div id="kwTip" class="muted tiny" style="margin-top:-4px"></div>' +
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

/* ---------- 规则编辑 ---------- */
/* 【v0.21】改签名：接索引而不是对象引用。
   原来用 (G.rules.rules||[]).indexOf(r) 反查索引 ——
   规则数组一旦被别处重新赋值（比如 loadRules 拉了新对象），
   indexOf 返回 -1，代码里 `if (idx < 0) idx = 0` 又会默默改成第 0 条，
   用户改的是第 3 条、保存后变成第 1 条被改。这种 bug 极难察觉。
   直接由调用方传索引，来源唯一。 */
function editRule(idx) {
  var isNew = (idx == null || idx < 0);
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
    '<label class="fl">类型</label><select id="rKind">' +
    KINDS.map(function (k) {
      return '<option value="' + k.v + '"' + (r.kind === k.v ? ' selected' : '') + '>' +
        k.t + '</option>';
    }).join('') + '</select>' +
    '<label class="fl">账号（填 * 表示全部）</label>' +
    '<input id="rAcc" value="' + esc(r.acc || '*') + '">' +
    /* 【v0.21】通配说明按实际语义改了。
       原来写「支持 * 通配」但没说清 * 放哪有效 ——
       用户填「*回水温度」以为能匹配「回水温度T2」，
       实际上旧实现要求「必须以回水温度结尾」，永远不匹配，
       规则看着对却一条提醒都不来。 */
    '<label class="fl">设备名（填 * = 全部；写「某线路」= 名字里含某线路）</label>' +
    '<input id="rDev" value="' + esc(r.dev || '*') + '">' +
    '<div id="rStaleBox"' + (r.kind === 'stale' ? '' : ' style="display:none"') + '>' +
    '<label class="fl">停更超过（分钟）</label>' +
    '<input id="rStale" type="number" value="' + (r.stale_min || 15) + '"></div>' +
    '<div id="rValBox"' + (r.kind === 'value' ? '' : ' style="display:none"') + '>' +
    '<label class="fl">变量名（填 * = 全部；写「回水温度」= 名字里含这四个字）</label>' +
    '<input id="rVar" value="' + esc(r.var || '*') + '">' +
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
  };

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
    if (obj.kind === 'value') obj.var = el('rVar').value.trim() || '*';
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
