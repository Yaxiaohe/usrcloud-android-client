/* 巡站页 */
var lastResult = null;
/* 【v0.38d】结果列表的搜索词（模糊筛站名 / 编号）。
   放模块级是为了整页重绘（补跑、单张重拍、切页回来）之后还能留住，
   用户搜着「站点E」补跑两台，回来不该又变成全量列表。 */
var kwPatrol = '';

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
  var paths = collectShotPaths(r);
  if (!paths.length) { toast('还没有截图，先跑一次巡站'); return; }
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
    G.accounts.forEach(function (a) {
      var on = !!G.picked[a.name];
      var kw = (a.station_kw || []).join('、');
      s += '<div class="item' + (on ? ' on' : '') + '" data-acc="' + esc(a.name) + '">' +
        '<div class="row"><div class="chk' + (on ? ' on' : '') + '">✓</div>' +
        '<div style="flex:1"><div class="t">' + esc(a.name) + '</div>' +
        '<div class="s mono">' + esc(a.account) +
        (kw ? ' · 过滤' + kw.split('、').length + '站' : '') + '</div></div>' +
        (a.enabled ? '' : '<span class="pill gray">停用</span>') + '</div></div>';
    });
  }
  s += '</div>';

  /* 进度：放在账号和「开始巡站」之间。
     巡站时用户盯着的是「跑到第几台了」，紧挨着账号选择和开始按钮才顺手；
     放在结果卡上面的话，页面一长进度条就被顶到看不见的地方了。 */
  s += '<div class="card" id="progCard"><h2>巡站进度</h2><div id="progBox"></div></div>';

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

  /* 截图保存位置：放在控制区下面。
     放页面最上方时，用户一进来先看到一长串路径，
     真正要做的「选账号 → 开始巡站」被挤到下面去了。
     而这个信息是「跑完之后去哪儿找」才关心的，放开始按钮下面更贴使用顺序。
     路径本身照旧原样显示（用户要照着它去文件管理器找），只是换位置。 */
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

  /* 结果
   * 【v0.22 修问题 5】原来只存在内存变量 lastResult 里，
   * 一按手机返回键切走、app 被系统回收内存，重新打开就是空的 ——
   * 用户描述是「回到桌面，再点开巡站页正常，但站点信息没了，也就没了看截图的入口」。
   * 后端其实有 status 接口能给出上次的巡站结果（result 也在后端存着），
   * 但前端只在巡检刚结束时才读一次，页面重建时没重新取。
   * 现在两处都补上：进页面先从后端拉一次，
   * 再把结果落到 localStorage 兜底（后端结果被清或读失败时仍有）。 */
  loadResult();
  if (lastResult) s += resultHtml(lastResult);
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
    if (r.error) toast(r.error);
    else if (wasRetry) toast('补跑完成，本轮在线 ' + (r.online || 0) + ' 台');
    else toast('巡站完成，在线 ' + (r.online || 0) + ' 台');
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
        return '<div class="ri' + (shot ? ' has' : '') + '" data-q="' + esc(q) + '"' +
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
    h += '<button class="pri blk" id="btnZip2">⬆　导出本次全部图片</button>' +
      '<div class="muted tiny" style="margin-top:7px;text-align:center">' +
      '直接发图片给微信/QQ，不用再解压缩包</div>';
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
 * 【为什么序列只收有截图的行】
 * 失败/离线的行没截图，混进来「下一张」会跳到一张空图。
 *
 * 【为什么用 touch 事件而不是 CSS 横向滚动】
 * CSS scroll-snap 在旧版 Android WebView（Chromium 60 前后）上支持不稳，
 * 而 minSdk 21 的机器上就是那些老 WebView。touchstart/touchend 手算位移最保险。 */
function openShot(acc, idx) {
  var p = findShot(acc, idx);
  if (!p) { toast('这张没有截图'); return; }

  /* 【v0.26】按 results 的键序（也就是结果卡片从上到下的顺序）
     把所有账号下有截图的行串成一条切换序列。
     每个条目记住自己属于哪个账号（acc），跨账号翻页时
     按钮文字和标题都要用它。 */
  var list = [];
  var accs = Object.keys((lastResult && lastResult.results) || {});
  for (var ai = 0; ai < accs.length; ai++) {
    var accName = accs[ai];
    var rep = (lastResult.results[accName] && lastResult.results[accName].report) || [];
    for (var i = 0; i < rep.length; i++) {
      if (rep[i] && (rep[i].pub || rep[i].path)) {
        list.push({ it: rep[i], pos: i, acc: accName });
      }
    }
  }
  if (!list.length) {
    list = [{ it: lastResult.results[acc].report[idx], pos: idx, acc: acc }];
  }

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

/* ---------- 结果列表搜索（v0.38d） ----------
 *
 * 用户要求：巡站页不要「选择站点」那个按钮 —— 它点开是设备勾选，
 * 勾完直接改账号的 station_kw（站点过滤），等于在巡站页悄悄改了账号配置。
 * 换成这里一个输入框，只模糊筛「结果列表」的显示，账号配置一概不动。
 *
 * 为什么用改 display 而不是重建列表：
 *   每行带着 data-shot="账号|序号"，序号是 lastResult.report 的下标。
 *   重建 DOM 时只要有一个账号被过滤掉一行，后面所有序号就会错位，
 *   点开「站点E」看到的是别人的图 —— 这种错位在真机上极难发现。
 *   所以只隐藏行，DOM 结构和序号一律不动。
 */
function filterPatrol() {
  var main = el('main');
  if (!main) return;
  var q = (kwPatrol || '').trim().toLowerCase();
  var rows = main.querySelectorAll('.ri[data-q]');
  var shown = 0;
  rows.forEach(function (n) {
    var hit = !q || n.getAttribute('data-q').indexOf(q) >= 0;
    n.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });

  /* 整张账号卡片都没有可见行时连卡片一起藏掉：
     否则搜「站点E」会留下 3 个只剩标题的空白卡片，看着像加载失败。 */
  main.querySelectorAll('.card').forEach(function (c) {
    var rs = c.querySelectorAll('.ri[data-q]');
    if (!rs.length) return;
    var vis = 0;
    rs.forEach(function (n) { if (n.style.display !== 'none') vis++; });
    c.style.display = vis ? '' : 'none';
    /* 卡片标题的台数跟着筛：不跟就会出现「标题 22 台、列表 2 行」 */
    var cn = c.querySelector('[data-cnt]');
    if (cn) cn.textContent = q ? (vis + ' / ' + rs.length + ' 台') : (rs.length + ' 台');
  });

  var cnt = el('ptCnt');
  if (cnt) cnt.textContent = q ? (shown + ' / ' + rows.length + ' 台')
                              : (rows.length + ' 台');
  var ttl = el('ptTitle');
  if (ttl) ttl.textContent = q ? ('巡站结果 · 搜「' + kwPatrol.trim() + '」') : '巡站结果';
  var empty = el('ptEmpty');
  if (empty) {
    if (q && shown === 0) {
      empty.textContent = '没有匹配「' + kwPatrol.trim() + '」的站点；清空输入框可看全部。';
      empty.style.display = '';
    } else {
      empty.style.display = 'none';
    }
  }
}
