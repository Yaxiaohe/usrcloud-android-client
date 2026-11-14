/* 巡站页 */
var lastResult = null;
/* 【v0.38d】结果列表的搜索词（模糊筛站名 / 编号）。
   放模块级是为了整页重绘（补跑、单张重拍、切页回来）之后还能留住，
   用户搜着「站点E」补跑两台，回来不该又变成全量列表。 */
var kwPatrol = '';

/* ---------- 巡站结果筛选（v0.38f） ----------
 *
 * 用户要求：巡站页顶部加一排仪表（总数 / 在线 / 离线(无数据) / 自定义），
 * 点一下就按这个口径筛下方结果列表；「自定义」长按可以配置变量条件
 * （回水温度 < 30、进水温度 > 40 这种），支持多条。
 *
 * 口径只有一份，四个地方共用：
 *   filterPatrol() 决定谁显示、仪表数字、结果卡计数
 *   visiblePatrolRows() 决定大图弹窗的翻页序列
 *   filteredShotPaths() 决定导出弹窗列哪些图
 *   patrolRowItem() 从行 DOM 找回结果项
 * 不许任何一处另写一套「是不是有数据」，否则按钮写 3 台、导出却是 5 张。
 */
var ptFilter = 'all';               // all | online | bad | custom
var CUSTOM_KEY = 'xunjian.customFilter.v1';
var lpAt = 0;                       // 长按触发的时刻，用来吞掉随后那一下 click

function loadCustomCfg() {
  try {
    var c = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null');
    if (!c || !c.rules) return { rules: [], mode: 'all' };
    return { rules: c.rules || [], mode: c.mode === 'any' ? 'any' : 'all' };
  } catch (e) {
    return { rules: [], mode: 'all' };
  }
}
function saveCustomCfg(c) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(c)); } catch (e) { }
}

/* 有数据 / 没数据。与 emptyStat()（补跑按钮）、后端只跑没数据的口径一致：
   online 有值、stale 只是旧，都算有数据；其余算没取到。 */
function patrolHasData(it) {
  var s = it && it.status;
  return s === 'online' || s === 'stale';
}

/* 每行的稳定身份 data-ref="账号|下标"。
   data-shot 只有真截到图的行才有，筛选和计数不能靠它 ——
   离线的行恰恰是最需要被筛出来的那批。 */
function patrolRowItem(n) {
  var v = n && n.getAttribute('data-ref');
  if (!v || !lastResult || !lastResult.results) return null;
  var i = v.lastIndexOf('|');
  if (i < 0) return null;
  var a = lastResult.results[v.slice(0, i)];
  if (!a || !a.report) return null;
  return a.report[parseInt(v.slice(i + 1), 10)] || null;
}

/* 当前真正看得见的结果行，顺序就是列表从上到下的顺序。
   整张账号卡被收起时，里面行自己的 display 还是 ''，
   必须连父卡一起判，否则「下一张」会翻到一张用户看不见的图。 */
function visiblePatrolRows() {
  var main = el('main');
  if (!main) return [];
  var out = [];
  main.querySelectorAll('.ri[data-q]').forEach(function (n) {
    if (n.style.display === 'none') return;
    var c = n.closest ? n.closest('.card') : null;
    if (c && c.style.display === 'none') return;
    out.push(n);
  });
  return out;
}

/* 截图里的变量值是 "45.2℃" / "320.5kpa" / "-" 这种串。
   只取开头的数字比较，剩下的当单位留着显示给用户。 */
function varNum(raw) {
  var m = /^\s*(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(String(raw == null ? '' : raw));
  if (!m) return null;
  return { v: parseFloat(m[1]), u: m[2].trim() };
}

function customHitOne(it, rule) {
  var rows = (it && it.rows) || [];
  var name = String(rule.name || '').trim();
  var target = parseFloat(rule.num);
  if (!name || !isFinite(target)) return false;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || !r[0] || String(r[0]).indexOf(name) < 0) continue;
    var x = varNum(r[1]);
    if (!x) continue;
    var v = x.v, ok = false;
    switch (rule.op) {
      case 'gt': ok = v > target; break;
      case 'lt': ok = v < target; break;
      case 'ge': ok = v >= target; break;
      case 'le': ok = v <= target; break;
      default:   ok = (v === target); break;
    }
    if (ok) return true;
  }
  return false;
}

function customMatch(it, cfg) {
  var rules = (cfg && cfg.rules) || [];
  if (!rules.length) return false;
  var res = rules.map(function (r) { return customHitOne(it, r); });
  return cfg.mode === 'any' ? res.indexOf(true) >= 0 : res.every(Boolean);
}

/* 导出图片只列当前筛选后还看得见的那几张。
   弹窗里根本不出现被筛掉的图，「勾选未导出」自然也不会勾到它们 ——
   这比在勾选时再排一遍可靠，勾选状态只有一个来源。 */
function filteredShotPaths(r) {
  var main = el('main');
  var rows = main ? main.querySelectorAll('.ri[data-q]') : null;
  if (!rows || !rows.length) return collectShotPaths(r);
  var out = [], seen = {};
  visiblePatrolRows().forEach(function (n) {
    var it = patrolRowItem(n);
    if (!it) return;
    var p = it.pub || it.path;
    if (p && !seen[p]) { seen[p] = 1; out.push(p); }
  });
  return out;
}

/* 收集本次巡站所有截图路径，优先对外目录那份（用户能看到、能分享） */
function collectShotPaths(r) {
  var out = [], seen = {};
  var results = (r && r.results) || {};
  Object.keys(results).forEach(function (k) {
    var rep = results[k] && results[k].report;
    if (!rep || !rep.length) return;
    rep.forEach(function (it) {
      if (!it) return;
      var p = it.pub || it.path;
      if (p && !seen[p]) { seen[p] = 1; out.push(p); }
    });
  });
  return out;
}

/* 导出图片：直接把 PNG 发给微信/QQ，不再打包 zip
 *
 * 【v0.22 改成批量选择 9 张 + 已导出标记】
 * 用户反馈「一次性导出全部会撞到聊天软件的文件数量上限」——
 * 微信/QQ 单次接收几十张图会直接提示「文件过多」，
 * 一次发 46 张的结果就是一张都发不出去，只能硬发然后失败。
 * 所以改成：点「导出图片」先选，多选一次不超过 9 张，分批发。
 *
 * 已导出标记存在 localStorage，键按图片路径存。
 * 存的是「路径」而不是「文件名」，因为清理往期批次后同名文件会重来，
 * 只记文件名会把新批次的图误判成已导出。
 * 后重跑一次巡站的同一个文件名（同名覆盖）不会被误标 ——
 * 批次目录带时间戳，路径不同，自然区分开。 */
var EXPORT_MARK = 'xunjian.exported.v1';
var EXPORT_BATCH = 9;

function loadExported() {
  try {
    return JSON.parse(localStorage.getItem(EXPORT_MARK) || '{}') || {};
  } catch (e) {
    return {};
  }
}

function saveExported(m) {
  try { localStorage.setItem(EXPORT_MARK, JSON.stringify(m)); } catch (e) { }
}

function exportImages() {
  var r = api('result', {});
  var paths = filteredShotPaths(r);
  if (!paths.length) {
    toast('当前筛选下没有可导出的图片；点「显示全部」可以导出全部');
    return;
  }
  openShotPicker(paths);
}

/* 从截图路径里取出站名。
 *
 * 文件名固定是 <yyyyMMdd>_<HHmmss>_<站名>.png（见 Core 里的 fname 拼接），
 * 站名本身可能带下划线，所以只剥掉前两段，剩下的整段当站名 ——
 * 用 split('_')[2] 会在「1_2号机组」这种名字上把站名截断，
 * 置顶就静默失效了（用户只会看到「顶了没反应」）。 */
function shotDevName(p) {
  var nm = String(p || '').split('/').pop().replace(/\.png$/i, '');
  var m = /^\d{8}_\d{6}_(.+)$/.exec(nm);
  return m ? m[1] : nm;
}

/* 批量选择弹窗：勾选后一次导出不超过 9 张
 *
 * 【v0.23 修】原来渲染写成
 *     '<div class="chk' + (marked ? '' : ' on') + '">'
 * 即「未导出的」反而带 on 类（= 已勾选的蓝底白勾样式），
 * 而 sel 却是空的 —— 屏幕上 46 行全是蓝勾，
 * 右上角却写「已选 0 / 9」，导出按钮还是灰的。
 * 用户看到的截图就是这样：视觉上「全选了」，逻辑上一个没选。
 * 现在 on 类严格跟 sel 走，默认一律不勾。
 *
 * 另外原来第二行直接塞完整路径，跟第一行的文件名重复且更长，
 * 46 行根本扫不过来。现在只显示批次目录 + 尺寸，完整路径留到选中后汇总。 */
function openShotPicker(paths) {
  var done = loadExported();
  var sorted = pinSort(paths.slice().sort(), G.devPins, shotDevName);
  var body = '';
  sorted.forEach(function (p, i) {
    var nm = p.split('/').pop();
    var marked = !!done[p];
    /* 从路径里抽出批次目录名：<根>/<批次>/<账号>/<文件名> 或 <根>/<批次>-<文件名> */
    var dir = p.split('/').slice(-2, -1)[0] || '';
    var acc = p.split('/').slice(-2, -1)[0] || '';
    var sub = p.indexOf('/巡站截图/') >= 0
      ? p.split('/巡站截图/')[1].split('/') : [];
    var batch = sub.length > 1 ? sub[0] : (dir || '本次巡站');
    if (sub.length > 1) acc = sub[1];
    body += '<label class="pick' + (marked ? ' off' : '') + '" data-pk="' + i
      + '" style="margin-bottom:7px">' +
      '<div class="chk"><span class="tick">✓</span></div>' +
      '<div style="flex:1;min-width:0">' +
      '<div class="t" style="font-size:13.5px;overflow:hidden;'
      + 'text-overflow:ellipsis;white-space:nowrap">' + esc(nm) + '</div>' +
      '<div class="s tiny" style="overflow:hidden;text-overflow:ellipsis;'
      + 'white-space:nowrap">' + esc(batch) + (acc && acc !== batch ? ' · ' + esc(acc) : '')
      + '</div></div>' +
      (marked ? '<span class="pill gray">已发</span>' : '') + '</label>';
  });

  openBox('选择要导出的图片',
    '<div class="muted tiny" style="margin-bottom:9px;line-height:1.7">' +
    '一次最多选 <b>' + EXPORT_BATCH + '</b> 张（微信/QQ 单次接收太多会提示文件过多）。' +
    '已导出过的标灰显示「已发」，避免重复发。</div>' +
    '<div class="row" style="margin-bottom:8px">' +
    '<button class="sm" id="pkNone">清空勾选</button>' +
    '<button class="sm" id="pkNew">勾选未导出</button>' +
    '<span class="sp"></span>' +
    '<span class="muted tiny" id="pkCnt">已选 0 / ' + EXPORT_BATCH + '</span></div>' +
    body +
    '<div class="tiny muted" id="pkTip" style="margin-top:9px;line-height:1.6"></div>' +
    '<div class="two" style="margin-top:12px">' +
    '<button data-no>取消</button><button class="pri" id="pkOk">导出选中</button></div>',
    null,
    /* 【v0.22 修】这层回调必须传第 4 个参数 onOpen（弹窗落地就跑），
       不能传第 3 个 onOk —— onOk 只绑 [data-ok] 按钮且要点保存才触发，
       放这里等于整段绑定代码永远不执行：
       「清空勾选」「只选未导出」「导出选中」三个按钮全都没 onclick，
       弹窗就是个死的列表。这跟 v0.19 在 editRawTable 上踩的是同一个坑。 */
    function () {
      var sel = {};
      var cnt = el('pkCnt');
      var tip = el('pkTip');
      /* ★ 勾选状态只由这里决定，UI 和计数永远同源。
         以前是渲染时写死的样式 + 另一份 sel 数组，两边对不上，
         才会出现「一屏蓝勾但已选 0」。 */
      function paint() {
        el('mbox').querySelectorAll('[data-pk]').forEach(function (n) {
          var on = !!sel[n.getAttribute('data-pk')];
          n.classList.toggle('seld', on);
          var c = n.querySelector('.chk');
          if (c) c.classList.toggle('on', on);
        });
        var n2 = Object.keys(sel).filter(function (k) { return sel[k]; }).length;
        if (cnt) cnt.textContent = '已选 ' + n2 + ' / ' + EXPORT_BATCH;
        var ok = el('pkOk');
        if (ok) ok.disabled = n2 === 0;
        if (tip) {
          tip.textContent = n2 === 0
            ? '勾选后点「导出选中」。想一次发完就分几次点这个按钮。'
            : '将导出 ' + n2 + ' 张' + (n2 >= EXPORT_BATCH
              ? '（已达单次上限，剩余的分批再点一次）' : '');
        }
      }
      el('mbox').querySelectorAll('[data-pk]').forEach(function (n) {
        n.onclick = function () {
          var i = n.getAttribute('data-pk');
          /* 已导出的允许再选 —— 用户可能确实要重发一次，
             这里只是默认不勾，不是禁止。 */
          sel[i] = !sel[i];
          paint();
        };
      });
      el('pkNone').onclick = function () {
        sel = {};
        paint();
      };
      el('pkNew').onclick = function () {
        sel = {};
        sorted.forEach(function (p, i) {
          if (!done[p]) sel[i] = true;
        });
        /* 超量的只留前 9 个，不然用户以为能一次全发出去 */
        var over = 0;
        for (var k in sel) {
          if (sel[k]) {
            if (over < EXPORT_BATCH) over++;
            else sel[k] = false;
          }
        }
        paint();
      };
      el('pkOk').onclick = function () {
        var picked = Object.keys(sel).filter(function (k) { return sel[k]; })
          .sort(function (a, b) { return a - b; })
          .map(function (i) { return sorted[i]; });
        if (!picked.length) { toast('先勾选要导出的图片'); return; }
        if (picked.length > EXPORT_BATCH) {
          picked = picked.slice(0, EXPORT_BATCH);
          toast('一次最多 ' + EXPORT_BATCH + ' 张，已取前 ' + EXPORT_BATCH + ' 张');
        }
        var m = loadExported();
        picked.forEach(function (p) { m[p] = 1; });
        saveExported(m);
        closeBox();
        Android.exportImages(JSON.stringify(picked));
        toast('正在导出 ' + picked.length + ' 张，剩余未导出的可再点一次');
      };
      paint();
    });
}

/* 【v0.25 移除】「用文件管理器打开这个目录」整条链路下线。
 *
 * 【这一版之前的三次尝试，逐个说明为什么没成】
 * v0.22：直接调 openDir 桥接让系统自己挑 →
 *   每次都被拦到系统自带那个「文件」App。
 * v0.23：先给一份候选清单让用户点，并用 FileProvider 发 content:// URI →
 *   修好了「点了没反应」（file:// 在 targetSdk 24+ 根本不能跨应用传），
 *   但候选里混进笔记/电话/设置，只好加 looksLikeFileManager() 过滤。
 *   同一版还把 ACTION_OPEN_DOCUMENT_TREE 提成主推按钮，理由是「成功率最高」——
 *   这判断本身就错了：那个 Intent 的语义是「**授权**用户挑一个目录」，
 *   UI 天生是目录选择器，不是「打开目录」。
 * v0.24：SAF 降回兜底，MIME 依次试 resource/folder → 通配 → 只给 URI，
 *   全失败就拉起文件管理器本体并如实提示用户自己导航。
 *
 * 【为什么最终还是删掉】
 * 三轮下来真正的障碍不是代码写错，是**目标能力本身不统一**：
 * 「用外部应用打开一个目录」这件事 Android 从来没有标准 Intent，
 * 各家文件管理器实现不同、有的根本不接目录 URI，
 * 再怎么轮着试 MIME 也只是把「打不开」换一种形式交给用户。
 * 用户反馈原话：「这样吧 我不死磕这个按钮了」。
 * 那就把按钮和这条链路一起删掉，别留一个时灵时不灵的功能占位置。
 *
 * 【删掉之后怎么找截图】
 * 路径提示必须留着（见 V_patrol() 里的 #dirbar）——
 * /storage/emulated/0/巡站截图 在文件管理器第一层就能看到，
 * 用户自己点进去比程序代跳更可控。
 * Java 侧的 openDir / openDirWith / filePickTree 桥接一并摘掉，
 * 免得留下没人调的入口（bridgetest 会把它们判成「Java 有、JS 没调」的死代码）。 */

/* 上一轮「没取到数值」的站点统计（只统计，不改数据）。
   口径必须和后端一致：online 有值、stale 只是旧，都算有数据；
   offline / blank / error 才算没取到 —— 两边算不一样的话，
   按钮上写「12 台」而后端只想跑 9 台，用户会以为按钮坏了。 */
function emptyStat() {
  var out = { total: 0, byAcc: {} };
  var r = lastResult;
  if (!r || !r.results) return out;
  Object.keys(r.results).forEach(function (k) {
    (r.results[k].report || []).forEach(function (it) {
      if (it.status === 'online' || it.status === 'stale') return;
      out.total++;
      (out.byAcc[k] = out.byAcc[k] || []).push(it.device);
    });
  });
  return out;
}

/* 「只跑没数据的站点」按钮：没有可补跑的就整个不出现，别占地方。 */
function retryHtml() {
  var es = emptyStat();
  if (!es.total) return '';
  return '<button class="blk" id="btnRetry" style="margin-top:10px">' +
    '⟳　只跑没数据的 ' + es.total + ' 台</button>' +
    '<div class="muted tiny" style="margin-top:6px;text-align:center">' +
    '上一轮离线 / 采集异常 / 失败的站点，已取到值的不重跑</div>';
}

function V_patrol() {
  if (G.tab !== 'patrol') return;
  var h = G.health || {};
  var accs = G.accounts.filter(function (a) { return a.enabled; });
  var allOn = accs.length > 0 && accs.every(function (a) { return G.picked[a.name]; });
  /* 【v0.38g】结果必须在拼 HTML **之前** 就加载好。
     原来 loadResult() 放在结果卡那一段才调，可「只跑没数据的 N 台」按钮
     在更前面的控制区就要读 lastResult —— 首次进页面时它是空的，
     于是列表有了、按钮却没有，要等下一次重绘才冒出来。
     两处现在用同一份数据，首屏就一致。 */
  loadResult();
  var s = '';

  /* 账号选择 */
  s += '<div class="card"><h2>选择账号' +
    '<span class="r" id="accTip">已选 ' + Object.keys(G.picked).filter(function (k) {
      return G.picked[k];
    }).length + ' / ' + accs.length + '</span></h2>';
  s += '<div class="row" style="margin-bottom:10px">' +
    '<button class="sm" id="pAll">' + (allOn ? '全不选' : '全选') + '</button>' +
    '<span class="sp"></span><span class="muted tiny">停用账号不参与巡站</span></div>';
  if (!G.accounts.length) {
    s += '<div class="empty">还没有账号<br><span class="tiny">去「我的」页添加</span></div>';
  } else {
    /* 【v0.38f】半宽两列：四个账号原来竖着占四行，把进度和按钮全顶下去了。
       格子里的文字区必须带 min-width:0，否则长手机号会把另一列撑出屏幕。 */
    s += '<div class="accgrid">';
    G.accounts.forEach(function (a) {
      var on = !!G.picked[a.name];
      var kw = (a.station_kw || []).join('、');
      s += '<div class="item' + (on ? ' on' : '') + '" data-acc="' + esc(a.name) + '">' +
        '<div class="row"><div class="chk' + (on ? ' on' : '') + '">✓</div>' +
        '<div style="flex:1;min-width:0"><div class="t">' + esc(a.name) + '</div>' +
        '<div class="s mono">' + esc(a.account) + '</div>' +
        /* 半宽格子放不下「手机号 · 过滤3站」一整行，硬塞会被省略号吃掉后半句。
           过滤站数单独一行，两个数都看得全。 */
        (kw ? '<div class="s" style="margin-top:1px;font-size:10px;color:#2b62e0">' +
          '过滤 ' + kw.split('、').length + ' 站</div>' : '') + '</div>' +
        (a.enabled ? '' : '<span class="pill gray">停用</span>') + '</div></div>';
    });
    s += '</div>';
  }
  s += '</div>';

  /* 控制区 */
  s += '<div class="card">' +
    '<button class="big" id="btnRun">▶　开始巡站截图</button>' +
    /* 【v0.38b】只跑没数据的站点。
       限流、隧道里弱网、平台抽风都会导致整批没取到值；补跑 47 台要等两分钟，
       而这 47 台里往往只有十几台是空的 —— 这个按钮把它们挑出来单独跑。 */
    retryHtml() +
    '<div class="two" style="margin-top:10px">' +
    '<button id="btnPause">‖　暂停</button>' +
    '<button id="btnExport">⬆　导出图片</button></div>' +
    /* 【v0.38d】原来这里左边是「选择站点」，点开是个设备勾选弹窗，
       勾完直接写进账号的 station_kw（站点过滤）—— 等于在巡站页改账号配置，
       用户以为只是筛一下列表，结果账号的巡站范围被改了。
       用户要求：删掉这个按钮，改成结果列表上方一个搜索框，只模糊筛列表、不动账号。
       所以这里只剩「清理往期」，单独占一行。 */
    '<button class="sm blk" id="btnClean" style="margin-top:10px">清理往期</button></div>';

  /* 【v0.38g】巡站进度：放在控制区下面、保存路径提示上面。
     原来夹在账号和「开始巡站」之间，把按钮顶到第二屏；
     现在点完开始，往下一眼就看到跑到第几台了。 */
  s += '<div class="card" id="progCard"><h2>巡站进度</h2><div id="progBox"></div></div>';

  /* 【v0.38g】统计仪表：放在结果卡正上方。
     首版插在账号下面，点完「在线」还要往下滚一屏才看得到筛出来的列表，
     用户反馈「仪表离结果太远」。现在和搜索框、结果卡连成一片，点完立刻见效。
     数字是**全部站点**里各分类的台数，不受搜索词影响 —— 这样和监控页
     顶部那排统计的语义一致，也保证「总数 = 在线 + 离线(无数据)」当场能验算。
     搜索词是另一个独立的收窄条件，结果卡里会写清「搜 X · 在线」。 */
  s += '<div class="card" style="padding:12px 10px">' +
    '<div class="stat" id="ptStat" style="margin:0;padding:2px 0;background:transparent;box-shadow:none">' +
    '<div data-st="all"><b id="stAll">0</b><span>总数</span></div>' +
    '<div data-st="online"><b id="stOn" class="cg">0</b><span>在线</span></div>' +
    '<div data-st="bad"><b id="stBad" class="cr">0</b><span>离线(无数据)</span></div>' +
    '<div data-st="custom"><b id="stCus" class="cb">—</b><span>自定义</span></div>' +
    '</div>' +
    '<div class="row" style="margin-top:9px;gap:6px">' +
    '<span class="muted tiny" style="flex:1;min-width:0">点数字筛下方列表；长按「自定义」配条件</span>' +
    '<button class="sm" id="btnCusCfg">设置条件</button>' +
    '</div></div>';

  /* 结果
   * 【v0.22 修问题 5】原来只存在内存变量 lastResult 里，
   * 一按手机返回键切走、app 被系统回收内存，重新打开就是空的 ——
   * 用户描述是「回到桌面，再点开巡站页正常，但站点信息没了，也就没了看截图的入口」。
   * 后端其实有 status 接口能给出上次的巡站结果（result 也在后端存着），
   * 但前端只在巡检刚结束时才读一次，页面重建时没重新取。
   * 现在两处都补上：进页面先从后端拉一次，
   * 再把结果落到 localStorage 兜底（后端结果被清或读失败时仍有）。
   * 【v0.38g】加载动作已提到 V_patrol() 开头（见那里），这里只负责渲染。 */
  if (lastResult) s += resultHtml(lastResult);

  /* 【v0.38h】截图保存位置挪到整页最下面。
     原来夹在「巡站进度」和「仪表」之间，点完开始要往下滚过一长串路径、
     还可能有权限说明，才看得到仪表和结果。这信息只有「跑完去哪儿找图」
     的时候才用得上，放结果列表之后最不挡事。
     路径本身一字不改 —— 用户还要照着它去文件管理器找截图。 */
  var allFiles = h.allFiles !== false;
  s += '<div class="bar" id="dirbar">📁 截图保存到<br>' +
    '<span class="mono tiny">' + esc(h.saveDir || '...') + '</span><br>' +
    '<span class="tiny">' + esc(h.saveHint || '') + '</span>' +
    /* 【v0.25】原来下面跟着一个「用文件管理器打开这个目录」按钮。
       用户放弃这个按钮了（各家文件管理器对「目录 URI」的支持差异太大，
       逐个试 MIME 也只是把失败推给用户，不如不加），
       但「路径在哪」这个信息必须留着 ——
       这是用户唯一能自己去文件管理器找截图的途径。
       没有按钮时，这段文字就从「补充说明」升级成「唯一的入口」，
       所以把逐层路径也写全。 */
    '<br><span class="tiny" style="display:block;margin-top:4px;opacity:.85">' +
    '打开手机任意文件管理器 → 内部存储 → 巡站截图</span></div>';

  /* 未授权时不阻断，只提供一个可选的「升级到根目录」入口。
     跟保存位置提示放一起，因为两件事说的是同一件事。 */
  if (!allFiles) {
    s += '<div class="card"><h2>想让截图放在手机根目录？</h2>' +
      '<div class="muted tiny" style="margin-bottom:10px;line-height:1.7">' +
      '现在截图放在「下载」目录，不用任何权限，文件管理器里点「下载」就能看到，' +
      '一样找得到。<br>如果你想放到根目录（打开文件管理器第一层就能看到「巡站截图」），' +
      '需要额外开启「所有文件访问」。</div>' +
      '<button class="blk" id="btnAsk">开启「所有文件访问」（可选）</button></div>';
  }

  el('main').innerHTML = s;
  bindPatrol();
  bindResult();
  paintProg();
}

var RESULT_KEY = 'xunjian.lastResult.v1';

/* 重新进页面时把上次结果捡回来。
   先试后端（权威，能拿到最新一批），失败再用 localStorage 兜底。

   【v0.22 补】只在内存里还没有结果时才去读 ——
   V_patrol() 每次重渲染都会调本函数，如果无条件覆盖，
   巡检刚结束时的内存结果会被后端读数顶掉；
   页面重绘的时机又早于后端落盘，表现就是「站点信息又没了」。
   内存里已有就直接用，下次开始新巡站时才清空（见 btnRun）。 */
function loadResult() {
  if (lastResult && lastResult.results
    && Object.keys(lastResult.results).length) return lastResult;
  var got = null;
  try {
    var r = api('result', {});
    if (r && r.ok && r.results && Object.keys(r.results).length) got = r;
  } catch (e) { }
  if (!got) {
    try {
      var t = JSON.parse(localStorage.getItem(RESULT_KEY) || 'null');
      if (t && t.results && Object.keys(t.results).length) got = t;
    } catch (e2) { }
  }
  if (got) lastResult = got;
  return got;
}

function saveResult(r) {
  lastResult = r;
  try { localStorage.setItem(RESULT_KEY, JSON.stringify(r)); } catch (e) { }
}

function bindPatrol() {
  var m = el('main');

  /* 【v0.38f】仪表：短按切筛选，长按「自定义」配条件，另有「设置条件」兜底。
     长按是用户点名要的，但真机上不好发现，所以同时给一个显式按钮。
     【v0.38g】按钮改回软件标准的 .sm 尺寸（原来内联缩小成小胶囊、还带 ⚙，
     和「全选 / 显示全部」这些按钮放一起明显不是一套东西）。 */
  var stat = el('ptStat');
  if (stat) stat.querySelectorAll('[data-st]').forEach(function (n) {
    var key = n.getAttribute('data-st');
    n.onclick = function () {
      /* 长按刚弹过配置窗，随后那一下 click 不能再把筛选切走 */
      if (Date.now() - lpAt < 1200) return;
      if (key === 'custom' && !loadCustomCfg().rules.length) {
        openCustomFilter();
        return;
      }
      ptFilter = key;
      filterPatrol();
    };
    if (key === 'custom') bindLongPress(n);
  });
  var cfgBtn = el('btnCusCfg');
  if (cfgBtn) cfgBtn.onclick = openCustomFilter;
  var clr = el('ptFilClear');
  if (clr) clr.onclick = function () {
    kwPatrol = '';
    ptFilter = 'all';
    var se = el('pSearch');
    if (se) se.value = '';
    filterPatrol();
  };

  var ab = el('btnAsk');
  if (ab) ab.onclick = function () {
    api('askAllFiles', {});
    toast('已跳转系统设置，开启后返回本 app 即可');
  };

  /* 【v0.25】原来这里绑 #btnOpen（用文件管理器打开这个目录）。
     用户明确表示不再死磕这个按钮，功能与 UI 一并移除。
     目录路径的提示保留在 #dirbar 里 —— 见 V_patrol() 里的说明。 */

  m.querySelectorAll('[data-acc]').forEach(function (n) {
    n.onclick = function () {
      var k = n.getAttribute('data-acc');
      G.picked[k] = !G.picked[k];
      V_patrol();
    };
  });

  var pa = el('pAll');
  if (pa) pa.onclick = function () {
    var accs = G.accounts.filter(function (a) { return a.enabled; });
    var allOn = accs.length && accs.every(function (a) { return G.picked[a.name]; });
    G.picked = {};
    if (!allOn) accs.forEach(function (a) { G.picked[a.name] = true; });
    V_patrol();
  };

  /* 启动一轮（全跑 / 只跑没数据的，共用这套流程） */
  function startRun(onlyEmpty) {
    if (G.busy) { toast('任务进行中'); return; }
    var names;
    if (onlyEmpty) {
      /* 补跑时账号列表由「哪些账号有空的站点」决定，不看当前勾选 ——
         用户可能只勾了一个账号，但上一轮是三个账号一起跑的。 */
      names = Object.keys(emptyStat().byAcc);
    } else {
      names = Object.keys(G.picked).filter(function (k) { return G.picked[k]; });
    }
    var r = api('run', { names: names, only_empty: !!onlyEmpty });
    if (r.ok) {
      G.busy = true;
      /* 【v0.31 修订】记下本轮的 run_id。后端在 startPatrol 里同步重置状态并 +1 编号，
         所以 run 一返回，status 报的就是本轮 —— 第一拍不会再读到上一轮的 finished。 */
      G.runId = r.run_id || 0;
      resetLogs();   /* 【v0.22】日志改成合并式，新开一轮要连去重表一起清 */
      /* 【v0.22】新开一轮就把上轮结果连同落盘一起清掉，
         否则 loadResult() 会把旧的「看截图」入口捡回来，
         跟本轮进度混在一起。

         【v0.38c】补跑例外：只补几台，其余站点这轮根本不跑，
         清掉的话「正在补跑」这段时间里列表就只剩那几台，
         用户会以为正常站点丢了。后端这轮做完会把完整结果回来（合并过）。 */
      if (!onlyEmpty) {
        lastResult = null;
        try { localStorage.removeItem(RESULT_KEY); } catch (e) { }
      }
      G.onlyEmptyRun = !!onlyEmpty;
      G.seq = 0;
      if (onlyEmpty) toast('只补跑没数据的 ' + names.length + ' 个账号');
      else toast(names.length ? '开始巡站：' + names.length + ' 个账号' : '开始巡站：全部启用账号');
      pollStatus();
    } else if (r.running) {
      /* 【v0.31 修订】后端说任务正在跑 —— 这不是「错误」，是「跟着看进度」。
         老版本这里统一 toast(r.msg)，用户看到的就是一句「已有任务在运行」的错误信息，
         而进度区一动不动。现在挂上这一轮的进度继续轮询。 */
      G.busy = true;
      G.runId = r.run_id || 0;
      toast('本轮巡站进行中，正在同步进度');
      pollStatus();
    } else {
      toast(r.msg || '启动失败');
    }
  }

  el('btnRun').onclick = function () { startRun(false); };

  /* 只在有可补跑的站点时才存在这个按钮（retryHtml 里控制） */
  var rb = el('btnRetry');
  if (rb) rb.onclick = function () { startRun(true); };

  el('btnPause').onclick = function () {
    var r = api('pause', {});
    if (r.ok) toast(r.paused ? '已暂停（当前设备跑完后停住）' : '继续巡站');
    else toast(r.msg || '操作失败');
    paintProg();
  };

  el('btnExport').onclick = exportImages;

  el('btnClean').onclick = function () {
    confirmBox('清理往期批次',
      '将删除手机「' + (G.health && G.health.allFiles !== false ? '根目录' : '下载') +
      '」巡站截图目录下和 app 内部的所有历史批次（本次巡站除外），此操作不可撤销。确定继续？',
      function () {
        var r = api('clean', {});
        if (!r.ok) { toast(r.msg || '清理失败'); return; }
        var n = (r.removed || 0) + (r.removedPub || 0);
        toast(n ? ('已清理 ' + n + ' 个批次')
          : '没有往期批次可清理（当前批次会保留）');
      });
  };
}

/* ---------- 进度 ---------- */
var stTid = null;

/* 【v0.38h】把后端给的完成时刻写成「11-14 15:57」。
   时间来自 Core.finishedAt（任务真正收尾那一刻），不是前端轮询到 finished 的时刻。
   没有时间戳（老结果 / 还没跑过）就返回空串，界面只写「已完成」，不编一个时间。 */
function finishTimeText(ms) {
  if (!ms || !isFinite(ms)) return '';
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '';
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes());
}
function lastFinishAt() {
  var r = G.st || {};
  return r.finished_at || (lastResult && lastResult.finished_at) || 0;
}
function pollStatus() {
  if (stTid) clearInterval(stTid);
  step();
  stTid = setInterval(step, 800);
}

function step() {
  var r = api('status', { since: G.seq });
  if (!r.ok) return;
  /* 【v0.31 修订】本轮守门。
     后端起任务是丢进线程池的（POOL.execute），而这里是「点完开始立刻」的第一拍，
     两者之间有时间差 —— 这段时间 status 报的还是上一轮：
     running=false、finished=true、online=上一轮的数字（用户截图里就是「在线 34 台」）。
     于是刚点开始就被判成「已完成」，弹「巡站完成，在线 34 台」，同时 clearInterval 停掉轮询，
     真正跑起来的这轮再没人看进度；用户以为没反应、再点一次，撞上后端的
     「已有任务在运行」，又是一条错误信息。
     认 run_id 就能把这种情况挡掉：编号对不上＝这份状态不是本轮的，直接跳过这一拍。
     条件里带上 r.run_id，是为了「后端万一没回这个字段」时退化成原来的行为 ——
     宁可按老样子跑，也不要因为读不到编号就把界面永久卡在转圈上。 */
  if (G.busy && G.runId && r.run_id && (r.run_id || 0) !== G.runId) return;
  if (r.logs && r.logs.length) {
    /* 【v0.22】走统一的 mergeLogs，不再直接 G.logs.push ——
       日志页有自己的游标 G.logSeq，两边并行拉同一份环形缓冲，
       不用 seq 去重就会出现重复行。 */
    if (mergeLogs(r.logs)) paintLog();
    G.seq = r.seq;
  }
  G.st = r;
  paintProg();
  if (r.finished || (!r.running && G.busy)) {
    clearInterval(stTid);
    stTid = null;
    var wasRetry = !!G.onlyEmptyRun;
    G.onlyEmptyRun = false;
    G.busy = false;
    G.runId = 0;
    var rr = api('result', {});
    if (rr.ok) saveResult(rr);   /* 【v0.22】连同落盘，返回/重启后仍能看截图 */
    if (G.tab === 'patrol') V_patrol();
    /* 【v0.31 修订】后端把「任务压根没跑起来」的原因放在 error 里
       （账号全停用之类），这时说「巡站完成，在线 0 台」是误导，
       直接把原因说给用户听。 */
    /* 【v0.38c】补跑只说这轮的结果：整份列表里的「在线台数」是上一轮全跑出来的，
       直接报总数会让人以为补跑把全部站点又跑了一遍。 */
    /* 【v0.38h】完成提示带上真正跑完的时刻，事后回来看也知道这批图是哪一轮的。 */
    var ft = finishTimeText(lastFinishAt());
    var tail = ft ? '（' + ft + '）' : '';
    if (r.error) toast(r.error);
    else if (wasRetry) toast('补跑完成，本轮在线 ' + (r.online || 0) + ' 台' + tail);
    else toast('巡站完成，在线 ' + (r.online || 0) + ' 台' + tail);
  }}

function paintProg() {
  /* 巡站是后台任务，切到别的页就别动 DOM 了 */
  if (G.tab !== 'patrol') return;
  var b = el('progBox');
  if (!b) return;
  var r = G.st;
  if (!r) {
    b.innerHTML = '<div class="empty">尚未开始</div>';
    return;
  }
  var tot = r.total || 0;
  var done = r.acc_done || 0;
  var pct = tot ? Math.min(100, Math.round(done / tot * 100)) : 0;
  var h = '';
  if (r.running) {
    h += '<div class="row" style="margin-bottom:8px"><b style="font-size:22px">' + pct +
      '%</b><span class="sp"></span><span class="muted tiny">' + done + ' / ' + tot + ' 台</span></div>';
    h += '<div style="height:7px;background:#eef1f6;border-radius:4px;overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:#2b62e0"></div></div>';
    if (r.stage) h += '<div class="muted tiny" style="margin-top:8px">' + esc(r.stage) + '</div>';
    if (r.paused) h += '<div class="pill y" style="margin-top:8px">已暂停</div>';
    if (r.error) h += '<div class="bar w" style="margin:8px 0 0">⚠ ' + esc(r.error) + '</div>';
  } else if (r.finished) {
    /* 【v0.31 修订】没跑成（账号全停用之类的 abort）也算 finished，
       这时候显示「已完成 在线 0 台」是骗人的，把原因摆出来。 */
    if (r.error) {
      h += '<div class="row"><span class="pill y">未跑成</span></div>';
      h += '<div class="bar w" style="margin:8px 0 0">⚠ ' + esc(r.error) + '</div>';
    } else {
      h += '<div class="row"><span class="pill b">已完成</span><span class="sp"></span>' +
        '<span class="muted tiny">在线 ' + (r.online || 0) + ' 台</span></div>';
      /* 【v0.38h】执行完毕的时间单独一行，不跟「在线 N 台」挤在一起。
         老结果没有时间戳时只写「已完成」，不编一个时间出来。 */
      var ft = finishTimeText(lastFinishAt());
      if (ft) h += '<div class="muted tiny" style="margin-top:6px">完成于 ' + ft + '</div>';
    }
  } else {
    h += '<div class="empty">尚未开始</div>';
  }
  b.innerHTML = h;
}

/* ---------- 结果 ---------- */
function resultHtml(r) {
  var names = Object.keys(r.results || {});
  if (!names.length) return '';
  var total = 0;
  names.forEach(function (n) {
    var rr = (r.results[n] || {}).report;
    total += (rr ? rr.length : 0);
  });
  /* 【v0.38d】结果列表上方的搜索框（替代原来的「选择站点」按钮）。
     只筛这张列表的显示，不改账号的站点过滤 —— 那是「我的 → 编辑账号」里的事。
     输入框的值存在 kwPatrol 里，整页重绘（补跑 / 重拍后都会重绘）也能留住。 */
  var h = '<div class="card"><h2><span id="ptTitle">巡站结果</span>' +
    '<span class="r" id="ptCnt">' + total + ' 台</span></h2>' +
    '<input id="pSearch" placeholder="搜索站名或编号" value="' + esc(kwPatrol) +
    '" autocomplete="off">' +
    /* 【v0.38f】当前生效的筛选条件写在这里。
       仪表在页面最上面，用户点完往下滚到结果时，得能一眼看出
       「为什么只剩 12 台」，而不是以为数据丢了。 */
    '<div class="row" style="margin-top:8px;gap:6px">' +
    '<span class="muted tiny" id="ptFilNow" style="flex:1;min-width:0"></span>' +
    '<button class="sm" id="ptFilClear" style="display:none">显示全部</button></div>' +
    '<div class="muted tiny" id="ptEmpty" style="display:none;margin-top:8px"></div></div>';
  names.forEach(function (n) {
    var a = r.results[n];
    /* 【v0.38d】台数包一层 [data-cnt]：搜索筛完要跟着变成「2 / 22」。
       不跟着改的话，标题写着 22 台、下面只剩 2 行，看着像数据丢了。 */
    h += '<div class="card"><h2>' + esc(n) + '<span class="r"><span data-cnt>' +
      (a.report ? a.report.length : 0) + ' 台</span>' +
      '<span class="tiny muted" style="font-weight:400">· 点行看截图</span></span></h2>';
    /* 【v0.38b】整批都被平台限流时，先在卡片顶上说明白。
       原来 47 台全是「✗失败」，用户看不出是自己网络问题、账号问题还是软件坏了；
       现在明确告诉他是平台限流、等一会儿重跑就行，别去查站点。 */
    var limited = 0;
    (a.report || []).forEach(function (it) {
      if (it.note && it.note.indexOf('限流') >= 0) limited++;
    });
    if (limited > 0) {
      h += '<div class="bar w" style="margin-bottom:8px">⚠ ' + limited +
        ' 台这次没取到数值：平台「最新值」接口限流（同一账号请求太频繁，约 20 秒自动恢复）。' +
        '截图里变量名和状态仍在，数值为空不是站点掉线。稍后点「开始巡站截图」重跑一次即可。</div>';
    }
    if (a.error) {
      h += '<div class="bar w">⚠ ' + esc(a.error) + '</div>';
    } else if (a.skip) {
      h += '<div class="muted tiny">' + esc(a.skip_reason || '该账号无启用的设备，已跳过') + '</div>';
    } else if (a.report && a.report.length) {
      /* 结果用行而不是 table：行要整行可点，table 的td 不好做整行点击，
         而且设备名长的时候 td 会被挤得很难看 */
      h += '<div class="rl">' + a.report.map(function (it, i) {
        var tag = it.tag || '';
        var cls = tag.indexOf('在线') >= 0 ? 'g' : (tag.indexOf('失败') >= 0 ? 'r' : 'y');
        /* 只有真截到图的行才可点，失败/离线的行点了没反应会让人以为坏了 */
        var shot = (it.pub || it.path || '');
        /* 【v0.38b】站名下面补一行原因。没有这行的话，「采集异常」和「离线」
           在界面上长得一样，用户只能去翻日志猜是限流、没权限还是网络断。 */
        var note = it.note || '';
        /* data-q 只给「模糊筛列表」用：站名 + 编号，小写。
           过滤靠改 display，不重建 DOM —— 行里的 data-shot 带着序号，
           重建会让序号和 lastResult.report 对不上，点开就是别人的图。 */
        var q = ((it.device || '') + ' ' + (it.no || '')).toLowerCase();
        /* data-ref 是每行的稳定身份：筛选计数、大图翻页、导出取图都按它取回结果项。
           data-shot 继续只给「真有图」的行，点击绑定沿用，不动那套逻辑。 */
        return '<div class="ri' + (shot ? ' has' : '') + '" data-q="' + esc(q) + '"' +
          ' data-ref="' + esc(n) + '|' + i + '"' +
          (shot ? ' data-shot="' + esc(n) + '|' + i + '"' : '') + '>' +
          '<div class="t">' + esc(it.device) +
          (note ? '<div class="tiny muted" style="margin-top:2px;font-weight:400">' +
            esc(note) + '</div>' : '') +
          '</div>' +
          '<span class="pill ' + cls + '">' + esc(tag) + '</span>' +
          (shot ? '<span class="ar">›</span>' : '') + '</div>';
      }).join('') + '</div>';
      if (a.dir) h += '<div class="muted tiny mono" style="margin-top:9px;word-break:break-all">' +
        esc(a.dir) + '</div>';
    } else {
      h += '<div class="muted tiny">无设备</div>';
    }
    h += '</div>';
  });
  if (r.zip) {
    h += '<button class="pri blk" id="btnZip2">⬆　导出当前列表里的图片</button>' +
      '<div class="muted tiny" style="margin-top:7px;text-align:center">' +
      '只列筛选后还看得到的那些；直接发图片给微信/QQ，不用解压缩包</div>';
  }
  return h;
}

/* 点结果行 → 弹出这张截图。
 *【为什么要预取base64 而不是直接给路径】
 * WebView 里的 <img src="/storage/..."> 是 file:// 源，
 * 在 Android 上对外部存储的 PNG 经常加载失败（跨进程读不到），
 * 表现就是「点了没反应」或一片空白。
 * 所以让原生把图读出来转成 data: URI，WebView 一定能显示。
 * 原图1~3MB 量级，base64 约 1.3 倍，单张打开完全够用。 */
function shotDataUri(p) {
  try {
    var r = api('viewShot', { path: p });
    if (!r.ok) return null;
    return r.data || null;
  } catch (e) {
    return null;
  }
}

function findShot(acc, idx) {
  var r = lastResult;
  if (!r || !r.results) return null;
  var a = r.results[acc];
  if (!a || !a.report || !a.report[idx]) return null;
  var it = a.report[idx];
  return it.pub || it.path || null;
}

/* 截图预览弹窗（可左右滑 / 按钮切换）。
 *
 * 必须给「关闭」按钮：#mask 本身点不关（点空白处没反应），
 * 没有按钮的话用户看完截图就被困在弹窗里了，只能重启 app。
 *
 * 【v0.25】原来只能看当前点开的那一张，看完要关掉弹窗、
 * 再去列表里找下一行点开，一次巡站几十台站点根本看不过来。
 * 现在把「有截图的行」拉成一个序列：
 *   - 底部三按钮：‹ 上一张 / 关闭 / 下一张 ›
 *   - 图片上左右滑动切换手势
 *   - 标题显示「第 N / M 张 · 设备名」，滑到哪张一目了然
 *   - 首尾两张时对应按钮置灰（button[disabled] 已有样式）
 *   - 只有一张图时隐藏切换按钮，不占地方
 *
 * 【v0.26】序列从「只限当前账号」放宽为「跨所有账号连续」。
 * 用户反馈：翻到当前账号最后一张时就断了，得关掉弹窗再点另一个
 * 账号卡片里的行，多账号巡站（有人云主 + 各线路账号）一次几十台，
 * 这个断点太烦。现在把所有账号的有截图行按 results 的顺序串成
 * 一条序列，翻页自然跨过账号边界；跨边界那一刻按钮文字变成
 * 「‹ 上一账号 / 下一账号 ›」，标题里也带上账号名，
 * 让人明确知道「已经切到另一个账号的卡片了」，而不是看串了。
 *
 * 【v0.38f】序列进一步收窄为「当前筛选后可见的行」，顺序就是列表顺序。
 * 跨账号连续仍然成立，但被搜索词或仪表筛掉的站不再混进「下一张」。
 *
 * 【为什么序列只收有截图的行】
 * 失败/离线的行没截图，混进来「下一张」会跳到一张空图。
 *
 * 【为什么用 touch 事件而不是 CSS 横向滚动】
 * CSS scroll-snap 在旧版 Android WebView（Chromium 60 前后）上支持不稳，
 * 而 minSdk 21 的机器上就是那些老 WebView。touchstart/touchend 手算位移最保险。 */
function openShot(acc, idx) {
  var p = findShot(acc, idx);
  if (!p) { toast('这张没有截图'); return; }

  /* 【v0.38f】切换序列 = 当前筛选后还看得见的行，按列表从上到下的顺序。
     原来是把所有账号的有图行全串起来，用户筛完「在线 12 台」再点开一张，
     「下一张」却翻到被筛掉的离线站 —— 等于筛选白做了。
     visiblePatrolRows() 已经把整卡收起的情况算在内，这里不再另判一遍。 */
  var main = el('main');
  var hasList = !!(main && main.querySelectorAll('.ri[data-q]').length);
  var list = [];
  if (!hasList) {
    /* 结果列表还没渲染（从别处直接调进来）时退回全量序列：
       跨所有账号连续，保持 v0.26 以来的行为，不让弹窗只剩一张图。 */
    var accs = Object.keys((lastResult && lastResult.results) || {});
    for (var ai = 0; ai < accs.length; ai++) {
      var accName = accs[ai];
      var rep = (lastResult.results[accName] && lastResult.results[accName].report) || [];
      for (var ri = 0; ri < rep.length; ri++) {
        if (rep[ri] && (rep[ri].pub || rep[ri].path)) {
          list.push({ it: rep[ri], pos: ri, acc: accName });
        }
      }
    }
  } else {
    visiblePatrolRows().forEach(function (n) {
      var it = patrolRowItem(n);
      if (!it || !(it.pub || it.path)) return;
      var v = n.getAttribute('data-ref');
      var j = v.lastIndexOf('|');
      list.push({ it: it, pos: parseInt(v.slice(j + 1), 10), acc: v.slice(0, j) });
    });
  }
  /* 点开的这张不在筛选结果里（条件刚改过、或从别处调进来）时，
     只显示这一张：用户明确点了它，不能悄悄换成序列里的第一张。 */
  var inList = false;
  for (var t = 0; t < list.length; t++) {
    if (list[t].acc === acc && list[t].pos === idx) { inList = true; break; }
  }
  if (!inList) {
    var only = lastResult && lastResult.results && lastResult.results[acc]
      && lastResult.results[acc].report && lastResult.results[acc].report[idx];
    list = only ? [{ it: only, pos: idx, acc: acc }] : [];
  }
  if (!list.length) { toast('这张没有截图'); return; }

  /* 序列里是否存在多个账号 —— 决定标题要不要带账号名前缀。 */
  var multiAcc = false;
  for (var k2 = 1; k2 < list.length; k2++) {
    if (list[k2].acc !== list[0].acc) { multiAcc = true; break; }
  }

  /* 当前点开的那张在序列里的位置（账号 + 行号双匹配；
     点进来的行可能本来就没截图，这时退回从头找，找不到就从 0 开始）。 */
  var cur = 0;
  for (var k = 0; k < list.length; k++) {
    if (list[k].acc === acc && list[k].pos === idx) { cur = k; break; }
  }

  var many = list.length > 1;
  var html = '<div class="shotwrap" id="shotWrap"><img class="shot" id="shotImg" ' +
    'alt="左右滑动或用下方按钮切换截图"></div>' +
    '<div class="tiny muted" id="shotTip" style="margin-top:9px"></div>';

  openBox(many ? '截图 1 / ' + list.length : lastResult.results[acc].report[idx].device,
    html, null,
    /* 【必须走 onOpen（第 4 参数）】v0.19 / v0.22 都踩过这个坑：
       绑事件写到 onOk（第 3 参数）里去，按钮会一个都点不动。 */
    function () {
      var foot = el('mbox').querySelector('.mboxfoot');
      if (!foot) {
        foot = document.createElement('div');
        foot.className = 'mboxfoot';
        el('mbox').appendChild(foot);
      }
      /* 【v0.26】底部按钮：多张时 = 三按钮行 + 通栏按钮；
         单张时 = 分享 / 关闭 两个并排（没有切换按钮，不占地方）。
         【v0.38c】两种布局都加「⟳ 重新获取这张截图」：某一台当时被限流、
         值全是 - 时，不必为这一台把整批重跑一遍。 */
      foot.innerHTML = (many
        ? '<div class="three">' +
            '<button id="shotPrev">‹ 上一张</button>' +
            '<button id="shotClose">关闭</button>' +
            '<button id="shotNext">下一张 ›</button></div>'
        : '<div class="three">' +
            '<button id="shotShare">⬆ 分享到微信 / QQ</button>' +
            '<button id="shotClose">关闭</button></div>') +
        '<button id="shotReget" class="sharebtn">⟳ 重新获取这张截图</button>' +
        (many ? '<button id="shotShare" class="sharebtn">⬆ 分享这张截图（微信 / QQ）</button>' : '');

      el('shotClose').onclick = closeBox;

      /* 【v0.26】分享当前这一张到微信 / QQ。
         复用导出图片的桥 Android.exportImages —— 那是 v0.24 已经
         在真机上和微信调通过的全套流程（复制到 cacheDir →
         FileProvider content:// → type=image/* → ClipData 逐个授权），
         传单元素数组就是单张分享，Java 侧一行不用改。
         路径在点击那一刻取 list[cur]：用户完全可能先翻了页再点分享，
         必须分享「眼前这张」而不是「点开时的那张」。 */
      el('shotShare').onclick = function () {
        var e2 = list[cur];
        var p2 = (e2 && e2.it) ? (e2.it.pub || e2.it.path) : '';
        if (!p2) { toast('这张没有可分享的截图'); return; }
        Android.exportImages(JSON.stringify([p2]));
      };

      var pv = many ? el('shotPrev') : null;
      var nx = many ? el('shotNext') : null;

      /* 【v0.38c】重新获取眼前这一张。
         两段式：reshootStart 只起线程立刻返回，这里按 600ms 轮询；
         同步等网络会把界面冻住（v0.37「刷新这台」踩过，最弱网 30 秒 0 帧）。
         拿到结果后就地替换这一项 —— 列表范围不动，别的站点不动。 */
      var reget = el('shotReget');
      reget.onclick = function () {
        var e2 = list[cur];
        var it = e2 && e2.it;
        if (!it) return;
        if (!it.no) { toast('这一项没有设备编号，先巡一轮再来'); return; }
        if (reget.disabled) return;
        var oldTxt = reget.textContent;
        reget.disabled = true;
        reget.textContent = '正在获取…';
        var r = api('reshootStart', { acc: e2.acc, no: it.no });
        if (!r || !r.ok) {
          reget.disabled = false;
          reget.textContent = oldTxt;
          toast((r && r.msg) || '启动失败');
          return;
        }
        var t0 = Date.now();
        var tid = setInterval(function () {
          var p;
          try { p = api('reshootPoll', { acc: e2.acc, no: it.no }); }
          catch (ex) { p = null; }
          if (!p) return;
          if (p.running) {
            var sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
            reget.textContent = '正在获取… ' + sec + ' 秒';
            /* 写界面的字也要给个上限：真卡住了不能一直转下去 */
            if (Date.now() - t0 > 90000) {
              clearInterval(tid);
              reget.disabled = false;
              reget.textContent = oldTxt;
              toast('还没取回来，稍后再点一次');
            }
            return;
          }
          clearInterval(tid);
          reget.disabled = false;
          reget.textContent = oldTxt;
          if (!p.ok) { toast('没取到：' + (p.error || '未知原因')); return; }
          /* 替换这一项：状态、说明、路径全换成新的 */
          it.status = p.status;
          it.tag = p.tag;
          it.preview = p.preview;
          it.note = p.note || '';
          it.path = p.path;
          it.pub = (p.pub === null || p.pub === undefined) ? '' : p.pub;
          it.device = p.device || it.device;
          /* 变量值也要换，否则自定义筛选还在拿旧图的温度判断这台站 */
          if (p.rows) it.rows = p.rows;
          saveResult(lastResult);     /* 连同落盘：关掉 app 再进来也是新图 */
          if (G.tab === 'patrol') V_patrol();   /* 列表上的胶囊/说明同步换掉 */
          paint();                     /* 弹窗里的图换成新这张 */
          toast('已重新获取「' + it.device + '」');
        }, 600);
      };

      /* 渲染第 cur 张：换图、换标题、换副标题、刷新按钮禁用态 */
      function paint() {
        var e = list[cur];
        var it = e.it;
        var img = el('shotImg');
        var tip = el('shotTip');

        /* 图先置半透明再塞 src。
           base64 一张 1~3MB，同步解码的那一瞬是白屏，
           半透明 + 淡入至少让用户知道「在加载」而不是「卡死了」。 */
        if (img) img.className = 'shot loading';
        if (tip) tip.textContent = '加载中…';

        /* 用 setTimeout 让浏览器先把半透明的框画出来，
           再去做同步的 base64 解码，否则 loading 态根本来不及显示。 */
        setTimeout(function () {
          var uri = shotDataUri(it.pub || it.path);
          var im = el('shotImg');
          if (!im) return;          /* 期间已经关掉弹窗了 */
          if (!uri) {
            im.removeAttribute('src');
            im.className = 'shot';
            var t2 = el('shotTip');
            if (t2) t2.textContent = '这张打不开（可能已被清理）';
            return;
          }
          im.className = 'shot';
          im.src = uri;
          var t3 = el('shotTip');
          if (t3) t3.textContent = it.preview || '';
        }, 16);

        /* 【v0.26】标题带账号名（多账号时）：跨账号翻页的那一刻，
           用户必须能看出「已经切到另一个账号的卡片了」。
           【v0.38c】只有一张时标题仍只写站名，不写「截图 1 / 1」。 */
        var h = el('mbox').querySelector('h3');
        if (h) h.textContent = many
          ? '截图 ' + (cur + 1) + ' / ' + list.length + '　' +
            (multiAcc ? e.acc + ' · ' : '') + it.device
          : it.device;
        /* 【v0.26】翻过账号边界时按钮文字换成「上一账号 / 下一账号」，
           置灰（首尾）时保持默认文案 —— 置灰按钮的文字不参与表达。 */
        if (pv) {
          pv.disabled = (cur <= 0);
          pv.textContent = (cur > 0 && list[cur - 1].acc !== e.acc)
            ? '‹ 上一账号' : '‹ 上一张';
        }
        if (nx) {
          nx.disabled = (cur >= list.length - 1);
          nx.textContent = (cur < list.length - 1 && list[cur + 1].acc !== e.acc)
            ? '下一账号 ›' : '下一张 ›';
        }
      }

      function step(d) {
        var n = cur + d;
        if (n < 0 || n >= list.length) return;
        cur = n;
        paint();
      }

      if (pv) pv.onclick = function () { step(-1); };
      if (nx) nx.onclick = function () { step(1); };

      /* 左右滑手势。判定条件三条同时满足才算切换：
         1) 位移超过 42px —— 太小的抖动（比如手指按住时轻微移动）不算；
         2) 横向位移大于纵向位移 —— 纵向是滚动，看长图时不能被误判；
         3) 500ms 以内完成 —— 长时间按住再拖多半是想滚动，不是想翻页。 */
      var sx = 0, sy = 0, st = 0, tracking = false;
      var wrap = el('shotWrap');
      if (wrap) {
        wrap.addEventListener('touchstart', function (e) {
          if (e.touches.length !== 1) { tracking = false; return; }
          tracking = true;
          sx = e.touches[0].clientX;
          sy = e.touches[0].clientY;
          st = Date.now();
        }, { passive: true });
        wrap.addEventListener('touchend', function (e) {
          if (!tracking) return;
          tracking = false;
          var t = e.changedTouches[0];
          var dx = t.clientX - sx;
          var dy = t.clientY - sy;
          if (Date.now() - st > 500) return;
          if (Math.abs(dx) < 42) return;
          if (Math.abs(dx) <= Math.abs(dy)) return;
          step(dx < 0 ? 1 : -1);   /* 手指往左滑 = 看下一张 */
        }, { passive: true });
      }

      paint();
    });
}

/* 重新绑定结果区导出按钮 + 点行看截图 */
function bindResult() {
  var b = el('btnZip2');
  if (b) b.onclick = function () { exportImages(); };
  var main = el('main');
  if (!main) return;
  /* 【v0.38d】结果列表搜索框：输入即筛，不重建列表。 */
  var se = el('pSearch');
  if (se) {
    se.oninput = function () { kwPatrol = this.value; filterPatrol(); };
    /* 重绘后用 kwPatrol 回填并重新套用过滤，否则输入框显示着字、列表却是全量 */
    if (se.value !== kwPatrol) se.value = kwPatrol;
    filterPatrol();
  }
  main.querySelectorAll('[data-shot]').forEach(function (n) {
    n.onclick = function () {
      var v = n.getAttribute('data-shot');
      var i = v.lastIndexOf('|');
      openShot(v.slice(0, i), parseInt(v.slice(i + 1), 10));
    };
  });
}

/* ---------- 结果列表筛选（v0.38f） ----------
 *
 * 只改 display，不重建 DOM：每行带着 data-shot / data-ref 的序号，
 * 重建会让序号前移，点「补水泵」打开「循环泵」的图 —— 真机上极难发现。
 *
 * 两遍扫描：第一遍算属性 + 全量分类计数（仪表数字），
 * 第二遍按「搜索词 ∩ 仪表条件」决定谁显示。
 * 仪表数字只按全量算，所以「总数 = 在线 + 离线(无数据)」当场能验算。
 */
function filterPatrol() {
  var main = el('main');
  if (!main) return;
  var q = (kwPatrol || '').trim().toLowerCase();
  var rows = main.querySelectorAll('.ri[data-q]');
  if (!rows.length) return;

  var cfg = loadCustomCfg();
  var tAll = 0, tOn = 0, tBad = 0, tCus = 0;
  rows.forEach(function (n) {
    var it = patrolRowItem(n);
    var has = patrolHasData(it);
    var cus = cfg.rules.length ? customMatch(it, cfg) : false;
    n.setAttribute('data-byq',
      (!q || n.getAttribute('data-q').indexOf(q) >= 0) ? '1' : '0');
    n.setAttribute('data-has', has ? '1' : '0');
    n.setAttribute('data-cus', cus ? '1' : '0');
    tAll++;
    if (has) tOn++; else tBad++;
    if (cus) tCus++;
  });

  var shown = 0;
  rows.forEach(function (n) {
    var ok = n.getAttribute('data-byq') === '1';
    if (ok && ptFilter === 'online') ok = n.getAttribute('data-has') === '1';
    else if (ok && ptFilter === 'bad') ok = n.getAttribute('data-has') === '0';
    else if (ok && ptFilter === 'custom') ok = n.getAttribute('data-cus') === '1';
    n.style.display = ok ? '' : 'none';
    if (ok) shown++;
  });

  var sa = el('stAll'), so = el('stOn'), sb = el('stBad'), sc = el('stCus');
  if (sa) sa.textContent = tAll;
  if (so) so.textContent = tOn;
  if (sb) sb.textContent = tBad;
  if (sc) sc.textContent = cfg.rules.length ? tCus : '—';
  /* 【v0.38h】「总数」是没筛的默认状态，不该给任何数字套蓝框 ——
     套了会让人以为当前正用着某个筛选条件。监控页顶部那排统计也是不画框的。
     点「在线 / 离线 / 自定义」之后才高亮当前项，好让用户知道列表为什么变短。 */
  var stat = el('ptStat');
  if (stat) stat.querySelectorAll('[data-st]').forEach(function (n) {
    n.classList.toggle('on', ptFilter !== 'all' && n.getAttribute('data-st') === ptFilter);
  });

  /* 整张账号卡片都没有可见行时连卡片一起藏掉；标题台数跟着筛。 */
  main.querySelectorAll('.card').forEach(function (c) {
    var rs = c.querySelectorAll('.ri[data-q]');
    if (!rs.length) return;
    var vis = 0;
    rs.forEach(function (n) { if (n.style.display !== 'none') vis++; });
    c.style.display = vis ? '' : 'none';
    var cn = c.querySelector('[data-cnt]');
    if (cn) cn.textContent = (vis !== rs.length)
      ? (vis + ' / ' + rs.length + ' 台') : (rs.length + ' 台');
  });

  var parts = [];
  if (q) parts.push('搜「' + kwPatrol.trim() + '」');
  if (ptFilter === 'online') parts.push('在线');
  else if (ptFilter === 'bad') parts.push('离线(无数据)');
  else if (ptFilter === 'custom') parts.push('自定义 ' + cfg.rules.length + ' 条');
  var filtering = parts.length > 0;

  var cnt = el('ptCnt');
  if (cnt) cnt.textContent = filtering
    ? (shown + ' / ' + tAll + ' 台') : (tAll + ' 台');
  var ttl = el('ptTitle');
  if (ttl) ttl.textContent = '巡站结果';
  var now = el('ptFilNow');
  if (now) now.textContent = filtering
    ? ('当前：' + parts.join(' · ') + ' → ' + shown + ' 台') : '当前：全部站点';
  var clr = el('ptFilClear');
  if (clr) clr.style.display = filtering ? '' : 'none';
  var empty = el('ptEmpty');
  if (empty) {
    if (filtering && shown === 0) {
      empty.textContent = '没有匹配当前条件的站点（' + parts.join(' · ') +
        '）；点「显示全部」或改条件。';
      empty.style.display = '';
    } else {
      empty.style.display = 'none';
    }
  }
}

/* 长按 600ms 打开条件配置。
   长按触发后紧跟着会来一次 click，用 lpAt 把它吞掉；
   不依赖「一定会来 click」，所以 1200ms 后自动失效，不会吞掉下一次短按。 */
function bindLongPress(n) {
  var tid = null;
  function cancel() { if (tid) { clearTimeout(tid); tid = null; } }
  function fire() { tid = null; lpAt = Date.now(); openCustomFilter(); }
  n.addEventListener('touchstart', function () {
    cancel(); tid = setTimeout(fire, 600);
  }, { passive: true });
  n.addEventListener('touchmove', cancel, { passive: true });
  n.addEventListener('touchend', cancel, { passive: true });
  n.addEventListener('touchcancel', cancel, { passive: true });
  /* 鼠标长按：模拟器 / 接了鼠标的设备也能配条件 */
  n.addEventListener('mousedown', function () {
    cancel(); tid = setTimeout(fire, 600);
  });
  n.addEventListener('mouseup', cancel);
  n.addEventListener('mouseleave', cancel);
}

var CF_OPS = [['lt', '小于'], ['le', '不大于'], ['gt', '大于'],
              ['ge', '不小于'], ['eq', '等于']];

/* 自定义筛选条件编辑窗。
   条件可以加多条，选「全部满足」或「满足任一」；删光再保存 = 清空条件。
   草稿在每次增删/保存前先从 DOM 读回来，否则加第二条会把第一条填的字冲掉。 */
function openCustomFilter() {
  var cfg = loadCustomCfg();
  var draft = { rules: JSON.parse(JSON.stringify(cfg.rules || [])), mode: cfg.mode };
  if (!draft.rules.length) draft.rules = [{ name: '', op: 'lt', num: '' }];

  function syncDraft() {
    var arr = [];
    el('mbox').querySelectorAll('.cfr').forEach(function (row) {
      arr.push({
        name: (row.querySelector('[data-k="name"]') || {}).value || '',
        op: (row.querySelector('[data-k="op"]') || {}).value || 'lt',
        num: (row.querySelector('[data-k="num"]') || {}).value || ''
      });
    });
    draft.rules = arr;
  }

  function ruleHtml(r, i) {
    return '<div class="cfr" data-i="' + i + '">' +
      '<input data-k="name" placeholder="变量名" autocomplete="off" value="' +
        esc(r.name || '') + '">' +
      '<select data-k="op">' + CF_OPS.map(function (o) {
        return '<option value="' + o[0] + '"' + (r.op === o[0] ? ' selected' : '') +
          '>' + o[1] + '</option>';
      }).join('') + '</select>' +
      '<input class="n" data-k="num" type="number" step="any" placeholder="数值" value="' +
        esc(r.num || '') + '">' +
      '<button class="sm" data-del="' + i + '">删</button></div>';
  }

  var html = '<div class="muted tiny" style="line-height:1.7;margin-bottom:10px">' +
    '按截图里的变量数值筛站点。变量名支持模糊匹配，数值只比数字、单位自动忽略。' +
    '例：回水温度 小于 30、进水温度 大于 40。可加多条。</div>' +
    '<div id="cfRules"></div>' +
    '<button class="sm" id="cfAdd">＋ 添加条件</button>' +
    '<label class="fl">多条条件之间</label>' +
    '<div class="seg" id="cfMode">' +
      '<div class="s' + (draft.mode === 'any' ? '' : ' on') + '" data-mode="all">全部满足</div>' +
      '<div class="s' + (draft.mode === 'any' ? ' on' : '') + '" data-mode="any">满足任一</div>' +
    '</div>' +
    '<div class="muted tiny" id="cfTip" style="margin-top:9px"></div>' +
    '<div class="two" style="margin-top:12px">' +
      '<button data-no>取消</button>' +
      '<button class="pri" data-ok id="cfSave">保存并筛选</button></div>';

  openBox('自定义筛选条件', html,
    function () {
      syncDraft();
      var rules = draft.rules.filter(function (r) {
        return String(r.name).trim() || String(r.num).trim();
      }).map(function (r) {
        return { name: String(r.name).trim(), op: r.op, num: String(r.num).trim() };
      });
      var bad = rules.filter(function (r) {
        return !r.name || r.num === '' || !isFinite(parseFloat(r.num));
      });
      var tip = el('cfTip');
      if (bad.length) {
        if (tip) tip.textContent = '每条都要填变量名和数字；只填一半的条件先删掉或补完。';
        return false;
      }
      if (!rules.length) {
        try { localStorage.removeItem(CUSTOM_KEY); } catch (e) { }
        ptFilter = 'all';
        filterPatrol();
        toast('已清空条件，显示全部');
        return;
      }
      var on = el('mbox').querySelector('#cfMode .s.on');
      saveCustomCfg({ rules: rules, mode: on ? on.getAttribute('data-mode') : 'all' });
      ptFilter = 'custom';
      filterPatrol();
      toast('已按 ' + rules.length + ' 条条件筛选');
    },
    function () {
      function draw() {
        var box = el('cfRules');
        if (!box) return;
        box.innerHTML = draft.rules.map(ruleHtml).join('');
        box.querySelectorAll('[data-del]').forEach(function (b) {
          b.onclick = function () {
            syncDraft();
            draft.rules.splice(parseInt(b.getAttribute('data-del'), 10), 1);
            draw();
          };
        });
      }
      el('cfAdd').onclick = function () {
        syncDraft();
        if (draft.rules.length >= 8) { toast('最多 8 条条件'); return; }
        draft.rules.push({ name: '', op: 'lt', num: '' });
        draw();
      };
      el('mbox').querySelectorAll('#cfMode .s').forEach(function (n) {
        n.onclick = function () {
          el('mbox').querySelectorAll('#cfMode .s').forEach(function (x) {
            x.classList.remove('on');
          });
          n.classList.add('on');
        };
      });
      var tip = el('cfTip');
      if (tip) tip.textContent = '变量名按包含匹配：写「回水温度」能命中「回水温度T2」。';
      draw();
    });
}
