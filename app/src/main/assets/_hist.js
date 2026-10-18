/* 历史数据页 */
var HOURS = [
  { v: 6, t: '6小时' }, { v: 24, t: '24小时' }, { v: 72, t: '3天' },
  { v: 168, t: '7天' }, { v: 720, t: '30天' }
];
var PAL = ['#2b62e0', '#12a19a', '#d97a29', '#7c5cff', '#e0518a', '#2f9e44'];
/* 【v0.33 修订六】移除「平台云端」来源。
   原云端历史走 history.usr.cn:7002 的 historyData 接口，实测该路径
   HTTP 404（平台已下线）；新控制台的多曲线历史接口
   （new.cloudapi.usr.cn/usrCloud/datadic/getMultiCurveDataPointHistory）
   属于另一套设备体系，本账号的设备不在其中（getDevs 为空），
   参数结构也探不明。功能既然拉不通，留着只会让用户点了没反应 ——
   删掉，只保留本地记录（监控自动落盘 + 导入，足够用）。 */
/* 【v0.28】默认 24 小时。原来默认 7 天：一是读的文件多、出图慢，
   二是 7 天的曲线挤在一起看不出细节，真要查长期趋势再点一下就好。 */
var hHours = 24;
var hOn = {};        // 变量名 -> true（勾选显示）
/* 【v0.33 修订三】hOn 是不是已经被「确定」过。
   false = 还没人动过（刚查出来），此时全空会兜底默认前 3 条；
   true  = 用户动过了，此时全空就是用户的意思 —— 一条都不显示。
   没有这个标志就区分不了这两种「空」，用户把按钮全点掉会被兜底顶回来。 */
var hInit = false;
var hAcc = null;      // null=未选择；''=全部账号；否则账号名
var hDevLabel = '';   // 【v0.28】已选设备的显示名（本地直选时用）

function V_hist() {
  if (G.tab !== 'hist') return;
  var s = '<div class="card"><h2>时间范围</h2><div class="seg" id="hhSeg">' +
    HOURS.map(function (x) {
      return '<div class="s' + (hHours === x.v ? ' on' : '') + '" data-hh="' + x.v + '">' +
        x.t + '</div>';
    }).join('') + '</div></div>';

  /* 汇总模式：hAcc = '' 表示「全部账号」，此时后端跨账号汇总所有变量 */
  var allAcc = (hAcc === '');

  /* 【v0.28】本地记录：两步出图。
     原来要「选账号 → 读取设备 → 选设备 → 查询」四步，其中「读取设备」
     还是走平台接口拉全量设备（耗额度，且线上有的设备本地未必有记录，
     点进去是张空图）。现在设备列表直接从本地 CSV 里提（histDevs），
     跨账号一次列全，点一台就出图。
     账号不单独选了 —— 设备行里带着账号名，搜索框也能按账号搜。 */
  s += '<div class="card"><h2>选择设备</h2>' +
    '<button class="pick" id="hPick"><span class="pf' +
    (hDevLabel ? '' : ' ph') + '">' +
    esc(hDevLabel || '点击选择设备') + '</span><span class="ar">›</span></button>' +
    '<div class="muted tiny" style="margin-top:9px">' +
    (allAcc
      ? '正在汇总全部设备的记录，变量名会带「设备名·」前缀。'
      : '列表直接来自本地落盘记录，不发平台请求；可以按站名、编号或账号搜索。') +
    '</div>' +
    '<div class="row" style="margin-top:10px">' +
    '<button class="sm" id="hAll">全部设备汇总</button>' +
    (hDevLabel ? '<button class="sm" id="hSwap">换一台设备</button>' : '') +
    '</div></div>';

  /* 结果区 */
  s += '<div id="hRes">' + histResultHtml() + '</div>';

  el('main').innerHTML = s;
  bindHist();
}

function histResultHtml() {
  if (!G.hist) return '';
  var r = G.hist;
  if (r.error) return '<div class="bar w">⚠ ' + esc(r.error) + '</div>';
  var vars = r.vars || [];
  if (!vars.length || !r.count) {
    return '<div class="card"><div class="empty">' +
      (hAcc === '' ? '全部账号在所选范围内没有历史数据' : '该设备在所选范围内没有历史数据') +
      '<br><span class="tiny">本地记录需要先启动「监控」并跑过巡检' +
      '</span></div></div>';
  }
  var keys = Object.keys(r.series || {});
  /* 【v0.33】高亮与曲线共用一个口径（activeCurves），并显式传这次的 series：
     此刻 G.hist 可能还是上一次查询的结果，直接用会算错对象。 */
  var on = activeCurves(r.series);
  /* 【v0.33 修订】把兜底结果**落进 hOn**。
     否则「一个都没勾选」时 hOn 是空的，而界面亮着 3 条 ——
     内部状态和屏幕上的事实对不上（正是这次 bug 的土壤）。
     落进去之后：hOn 永远等于「实际显示哪些」，
     点「关掉最后一条」也不会被兜底立刻顶回来。 */
  hOn = {};
  on.forEach(function (k) { hOn[k] = true; });
  /* 渲染本身就是一次「确定」：此刻兜底选出的那几条就是当前显示的。
     之后用户把它们全点掉，就该真的什么都不显示。 */
  hInit = true;

  /* 全部账号汇总时变量会非常多，只列出前若干个，避免刷屏 */
  var shown = keys.slice(0, 60);
  var title = (hAcc === '')
      ? '全部账号'
      : (G.histName || G.histNo || '');
  var s = '<div class="card"><h2>' + esc(title) +
    '<span class="r">' + r.count + ' 个变量 · ' + r.hours + '小时 · ' +
    '本地</span></h2>';

  if (keys.length > shown.length) {
    s += '<div class="bar w" style="margin-bottom:10px">⚠ 共 ' + keys.length +
      ' 个变量，图表只列前 ' + shown.length + ' 个。请缩小时间范围或指定单个账号。</div>';
  }
  /* 图表放在变量选项上面：先看图，再决定要看哪几条线，不用往下翻 */
  s += '<canvas class="cv" id="hCv" width="700" height="300"></canvas>';
  s += '<div class="lg" id="hLg"></div>';
  s += '<div class="muted tiny" style="margin-top:9px" id="hAx"></div>';

  s += '<div class="muted tiny" style="margin:14px 0 8px">点变量名可显示/隐藏曲线' +
    (keys.length > shown.length ? '（仅前 ' + shown.length + ' 个）' : '') + '</div>';
  s += '<div class="row wrap">';
  shown.forEach(function (k) {
    s += '<span class="vchip' + (on.indexOf(k) >= 0 ? ' on' : '') + '" data-var="' +
      esc(k) + '">' + esc(k) + '</span>';
  });
  s += '</div></div>';

  s += '<div class="two"><button class="sm" id="hSave">⬇ 立即落盘</button>' +
    '<button class="sm" id="hFiles">📁 历史文件</button></div>';
  return s;
}

function bindHist() {
  var m = el('main');

  m.querySelectorAll('[data-hh]').forEach(function (n) {
    n.onclick = function () {
      hHours = parseInt(n.getAttribute('data-hh'), 10);
      /* 必须先 V_hist() 重画分段控件，否则 data-hh 的 .on 高亮不会跟着变，
         看上去就是"点了没反应"。原来只调 doQuery()，高亮永远停在旧值。 */
      V_hist();
      if (G.hist) doQuery();
    };
  });

  /* 【v0.28】本地：一步打开设备列表，点中即查 */
  var pk = el('hPick');
  if (pk) pk.onclick = pickLocalDevice;

  var sw = el('hSwap');
  if (sw) sw.onclick = pickLocalDevice;

  var ha = el('hAll');
  if (ha) ha.onclick = function () {
    hAcc = '';
    hDevLabel = '';
    G.histAcc = null;
    G.histNo = null;
    G.hist = null;
    hOn = {};
    hInit = false;
    V_hist();
    doQuery();
  };

  /* 【v0.33 修订六】删「查询曲线」按钮 —— 云端来源移除后，
     本地模式点中设备即查，不再需要单独的查询确认键。 */

  m.querySelectorAll('[data-var]').forEach(function (n) {
    n.onclick = function () {
      var k = n.getAttribute('data-var');
      /* 【v0.33 修订】切换必须基于「**当前实际显示**的那几条」，而不是 hOn[k] 本身。
       *
       * 用户报的现象：打开时默认显示供水T1/回水T2/室外T4 三条、三个按钮都是亮的，
       * 点「室外温度T4」却只剩它一条 —— 期望是它灰掉、保留供回水两条。
       *
       * 真因：刚查出来时 hOn 是**空的**（谁都没勾选过），那三条只是
       * activeCurves 的兜底「默认前 3 条」。于是 `hOn[k] = !hOn[k]`
       * 把一个 undefined 取反成 true，hOn 里就只剩 k 一个 ——
       * 曲线从 3 条塌成 1 条。用户看到的是「点一下反而只剩它」，
       * 语义正好反了：他点的是一条**正在显示**的线，期望是关掉它。
       *
       * 现在：先问「它现在显示着吗」，显示着就移出、不显示就加入，
       * 算完把结果**整体写回 hOn** —— hOn 从此精确等于「实际显示哪些」，
       * 再也不会出现「按钮亮着但 hOn 里没有」这种两边不一致的状态。 */
      var cur = activeCurves();
      var next = cur.slice();
      var i = next.indexOf(k);
      if (i >= 0) {
        next.splice(i, 1);            // 正在显示 → 关掉它（用户这次的期望）
      } else {
        next.push(k);
        /* 已满 6 条还点新的：挤掉第 5 条，把刚点的这条留在最后。
           不这么处理的话，它会被 slice(0,6) 直接截掉，
           结果就是「点了没反应」—— 比画错更让人莫名其妙。 */
        if (next.length > 6) next = next.slice(0, 5).concat([k]);
      }
      hOn = {};
      next.forEach(function (x) { hOn[x] = true; });
      /* 用户已经动过了 —— 从这一刻起「空」就是用户的意思，
         再不该被兜底顶回来（这正是用户报的「全点掉又变回三条」）。 */
      hInit = true;
      /* 所有 chip 按同一口径重画 */
      var onNow = activeCurves();
      m.querySelectorAll('[data-var]').forEach(function (x) {
        x.className = 'vchip' + (onNow.indexOf(x.getAttribute('data-var')) >= 0 ? ' on' : '');
      });
      drawChart();
    };
  });

  var sv = el('hSave');
  if (sv) sv.onclick = function () {
    var r = api('histSave', {});
    toast(r.ok ? '已落盘到本地 CSV' : (r.msg || '落盘失败'));
  };

  var fl = el('hFiles');
  if (fl) fl.onclick = showFiles;

  var hd = el('hDev');
  if (hd) hd.onchange = function () {
    G.histNo = this.value;
    G.histName = this.options[this.selectedIndex].text;
    doQuery();
  };

  drawChart();
}

/* 设备列表项 HTML。抽成函数是为了搜索时能原样重画，不用两套写法。 */
function hdItemHtml(d, on) {
  return '<div class="item' + (on ? ' on' : '') + '" data-hd="' + esc(d.no) + '" data-ha="' +
    esc(d.acc) + '" data-hn="' + esc(d.name || '') + '">' +
    '<div class="t">' + esc(d.name || d.no) + '</div>' +
    '<div class="s">' + esc(d.acc) + ' · ' + esc(d.no) + '</div>' +
    '<div class="s mono tiny">最后记录 ' + esc(d.last || '-') + ' · ' +
    (d.n || 0) + ' 行</div></div>';
}

function hdListHtml(ds, kw, sel) {
  var list = ds;
  if (kw) {
    var q = kw.toLowerCase();
    list = ds.filter(function (d) {
      return ((d.name || '') + ' ' + (d.no || '') + ' ' + (d.acc || ''))
        .toLowerCase().indexOf(q) >= 0;
    });
  }
  if (!list.length) {
    return '<div class="empty">' + (kw ? '没有匹配「' + esc(kw) + '」的设备'
      : '本地还没有落盘记录<br><span class="tiny">启动「监控」跑一次巡检后就有</span>') +
      '</div>';
  }
  return list.map(function (d) { return hdItemHtml(d, d.no === sel); }).join('');
}

function pickLocalDevice() {
  var r = api('histDevs', {});
  var ds = (r && r.devs) || [];
  if (!ds.length) {
    openBox('选择设备',
      '<div class="empty">本地还没有落盘记录<br><span class="tiny">' +
      '启动「监控」跑一次巡检后，这里会自动列出有数据的设备</span></div>',
      null);
    return;
  }
  openBox('选择设备（本地记录）',
    '<input id="hdKw" placeholder="搜站名 / 编号 / 账号" autocomplete="off">' +
    '<div class="tiny muted" id="hdCnt" style="margin:7px 0 9px"></div>' +
    '<div id="hdL">' + hdListHtml(ds, '', G.histNo) + '</div>' +
    '<div class="two" style="margin-top:12px"><button data-no>关闭</button>' +
    '<button class="pri" data-ok>好</button></div>',
    null);

  var kw = '';
  function paint() {
    el('hdL').innerHTML = hdListHtml(ds, kw, G.histNo);
    el('hdCnt').textContent = kw
      ? ('匹配 ' + el('hdL').querySelectorAll('[data-hd]').length + ' / ' + ds.length + ' 台')
      : ('共 ' + ds.length + ' 台，按最后记录时间排序');
    el('hdL').querySelectorAll('[data-hd]').forEach(function (n) {
      n.onclick = function () {
        /* 点中即查 —— 不再多一个「查询」确认键 */
        G.histAcc = n.getAttribute('data-ha');
        G.histNo = n.getAttribute('data-hd');
        G.histName = n.getAttribute('data-hn') || '';
        hAcc = G.histAcc;
        hDevLabel = G.histName || G.histNo;
        hOn = {};
    hInit = false;
        closeBox();
        V_hist();
        doQuery();
      };
    });
  }
  el('hdKw').oninput = function () { kw = this.value.trim(); paint(); };
  paint();
}

function doQuery() {
  /* 全部账号：acc='' 、no=''，后端跨账号汇总 */
  if (hAcc === null) { toast('先选账号'); return; }
  if (hAcc !== '' && !G.histNo) { toast('先选设备'); return; }
  var box = el('hRes');
  if (box) box.innerHTML = '<div class="card"><div class="empty">查询中…</div></div>';
  setTimeout(function () {
    /* 【v0.33 修订六】src 参数去掉云端分支 —— 平台历史接口已 404，
       只剩本地记录一种来源。 */
    var r = api('histGet', {
      acc: hAcc === '' ? '' : G.histAcc, no: hAcc === '' ? '' : G.histNo,
      hours: hHours
    });
    /* 查询期间用户可能已经切走，别覆盖当前页 */
    if (G.tab !== 'hist') return;
    G.hist = r;
    hOn = {};
    hInit = false;
    var box2 = el('hRes');
    if (box2) box2.innerHTML = histResultHtml();
    bindHist();
    var keys = Object.keys((r && r.series) || {});
    toast(r.ok && r.count ? ('查到 ' + r.count + ' 个变量') :
      (r.error || '没有数据'));
  }, 30);
}

function showFiles() {
  var r = api('histFiles', {});
  var fs = (r && r.files) || [];
  /* 历史文件会随监控持续增长（每轮巡检落一个），所以同样给搜索框。
     【v0.27】只读改成可勾选删除 —— 表格数据膨胀快（监控每轮落一次盘，
     一个站点一个月能落几十 MB），没有清理入口目录只会越攒越大。
     勾选删除而不是「保留最近 N 个月」：看着每个文件多大自己挑，
     手动保存的历史数据_*.csv 可能是特意留的底账，不能替人做主。 */
  function hfListHtml(kw) {
    var list = fs;
    if (kw) {
      var q = kw.toLowerCase();
      list = fs.filter(function (f) { return (f.name || '').toLowerCase().indexOf(q) >= 0; });
    }
    if (!list.length) {
      return '<div class="empty">' + (kw ? '没有匹配「' + esc(kw) + '」的文件'
        : '还没有历史文件<br><span class="tiny">启动监控后会自动落盘</span>') + '</div>';
    }
    return list.map(function (f) {
      /* 勾选框放在行内，label 包住整行让点文字也能勾 */
      return '<label class="item" style="display:flex;align-items:center;gap:9px">' +
        '<input type="checkbox" class="hfck" data-fn="' + esc(f.name) + '" ' +
        'style="width:19px;height:19px;flex:none">' +
        '<span style="flex:1;min-width:0"><span class="t" style="display:block">' +
        esc(f.name) + '</span>' +
        '<span class="s">' + (f.auto ? '监控自动落盘' : '手动保存') + ' · ' +
        (f.size / 1024).toFixed(1) + ' KB</span></span></label>';
    }).join('');
  }

  /* 【v0.33 修订六】文件操作区：删除之外补上导入/导出。
     原来这个弹窗只有删除 —— 数据只能进不能出：换手机、给同事看曲线、
     留底账全都抓瞎。导入放在没有文件时也显示（空列表恰恰是
     最想恢复备份的场景），导出沿用删除的勾选语义（勾谁导谁）。 */
  var impBtn = '<button class="sm" id="hfImp">⬆ 导入文件…</button>';
  openBox('历史数据文件',
    (fs.length
      ? '<input id="hfKw" placeholder="搜索文件名" autocomplete="off">' +
        '<div class="tiny muted" id="hfCnt" style="margin:7px 0 9px"></div>' +
        '<div id="hfL">' + hfListHtml('') + '</div>' +
        '<div class="tiny muted" style="margin-top:8px">勾选要删除的文件，' +
        '删了不可恢复；正在写入的本月文件删了下轮巡检会重新生成。</div>'
      : '<div class="empty">还没有历史文件<br><span class="tiny">启动监控后会自动落盘，' +
        '也可以从文件导入备份</span></div>') +
    (fs.length
      ? '<div class="two" style="margin-top:12px">' + impBtn +
        '<button class="sm" id="hfExp" disabled>⬇ 导出选中</button></div>'
      : '<div class="two" style="margin-top:12px">' + impBtn +
        '<button class="sm" data-no>关闭</button></div>') +
    (fs.length
      ? '<div class="two" style="margin-top:12px"><button data-no>关闭</button>' +
        '<button class="dan" id="hfDel" disabled>🗑 删除选中</button></div>'
      : ''));

  /* 导入的结果是异步的（用户要去文件选择器里挑），原生完成后
     回调 window.onHistImported。全局挂一次，弹窗重开也不会丢。 */
  window.onHistImported = function (r) {
    if (!r) return;
    if (r.ok) {
      toast('已导入 ' + (r.name || '') + '（' +
        ((r.size || 0) / 1024).toFixed(1) + ' KB）');
      closeBox();
      showFiles();     // 重新拉列表，新文件立刻可见
    } else {
      toast(r.error || '导入失败');
    }
  };

  var imp = el('hfImp');
  if (imp) imp.onclick = function () {
    if (typeof Android === 'undefined' || !Android.importHist) {
      toast('当前版本不支持导入，请更新到最新版');
      return;
    }
    Android.importHist();
    toast('请在文件选择器里挑历史 CSV（表头含「时间/变量」列）');
  };

  if (fs.length) {
    var kw = '';
    function paint() {
      el('hfL').innerHTML = hfListHtml(kw);
      var shown = el('hfL').querySelectorAll('.item').length;
      el('hfCnt').textContent = kw
        ? ('匹配 ' + shown + ' / ' + fs.length + ' 个')
        : ('共 ' + fs.length + ' 个');
      bindCk();
      refreshActs();
    }
    /* 「删除选中」按钮：无勾选时置灰，有勾选时显示会释放多少空间。
       导出按钮同一份勾选状态，一起刷新。 */
    function picked() {
      return [].slice.call(el('hfL').querySelectorAll('.hfck:checked'));
    }
    function refreshActs() {
      var n = picked().length;
      var b = el('hfDel');
      if (b) {
        b.disabled = !n;
        b.textContent = n ? ('🗑 删除选中 (' + n + ')') : '🗑 删除选中';
      }
      var e = el('hfExp');
      if (e) {
        e.disabled = !n;
        e.textContent = n ? ('⬇ 导出选中 (' + n + ')') : '⬇ 导出选中';
      }
    }
    function bindCk() {
      el('hfL').querySelectorAll('.hfck').forEach(function (ck) {
        ck.onchange = refreshActs;
      });
    }
    el('hfDel').onclick = function () {
      var cks = picked();
      if (!cks.length) return;
      var names = cks.map(function (ck) { return ck.getAttribute('data-fn'); });
      var bytes = 0;
      names.forEach(function (n) {
        fs.forEach(function (f) { if (f.name === n) bytes += (f.size || 0); });
      });
      confirmBox('删除 ' + names.length + ' 个历史文件',
        '共 ' + (bytes / 1024).toFixed(1) + ' KB，删除后不可恢复。\n\n' +
        '里面是监控自动落盘的曲线数据，删掉后这段时间的曲线就查不到了。',
        function () {
          var rr = api('histClean', { names: names });
          if (!rr.ok) { toast(rr.error || '删除失败'); return; }
          toast('已删 ' + rr.deleted + ' 个文件，释放 ' +
            (rr.freed / 1024).toFixed(1) + ' KB');
          closeBox();
        });
    };
    /* 导出：把勾选的文件交给系统分享。原生侧会做和删除同一套的
       名字校验（前缀/.csv/防穿越），这里只负责把名单递过去。
       传数组顶层 —— Java 侧按 exportImages 的老教训先判顶层是不是数组。 */
    var exp = el('hfExp');
    if (exp) exp.onclick = function () {
      var cks = picked();
      if (!cks.length) return;
      if (typeof Android === 'undefined' || !Android.exportHist) {
        toast('当前版本不支持导出，请更新到最新版');
        return;
      }
      var names = cks.map(function (ck) { return ck.getAttribute('data-fn'); });
      Android.exportHist(JSON.stringify(names));
    };
    el('hfKw').oninput = function () { kw = this.value.trim(); paint(); };
    paint();
  }
}

/* ---------- 折线图 ---------- */

/**
 * 当前该显示哪几条曲线 —— **唯一口径**，按钮高亮与画布绘制都走它。
 *
 * 【v0.33 修复】原来这里是两套各算各的：
 *   渲染按钮时（第 97 行附近）：on = hOn 过滤 → 空则取 keys.slice(0,3)，**不截 6**；
 *   画曲线时（drawChart）    ：keys = hOn 过滤 → 空则取前 3 → **再截 6**。
 * 两处 fallback 的截断规则不一致，于是出现用户截图那个现象：
 * 按钮上「出水温度/进水温度」是亮的，图表里却画着「水流量」——
 * 因为「都不勾选」这个状态下，按钮高亮的那 3 个和画布画的那 3 个
 * 根本不保证是同一批；点一下取消勾选，两边就彻底错位。
 * 现在统一：谁要显示哪些线，只由这一个函数说了算。
 *
 * series 允许显式传入：渲染按钮那一刻 G.hist 可能还是上一次的
 * （用的是这次查询返回的局部 r），传进来才不会算错对象。
 */
function activeCurves(seriesIn) {
  var series = seriesIn || (G.hist && G.hist.series) || {};
  var all = Object.keys(series);
  var on = all.filter(function (k) { return hOn[k]; });
  /* 【v0.33 修订三】「默认前 3 条」只在**还没设置过**时兜底。
     原来不管什么时候只要一个都没选，就强行顶回前 3 条 ——
     于是用户把高亮的按钮一个个点掉，最后一条点完又被顶回来 3 条，
     怎么关都关不掉（用户报的就是这个）。
     现在区分两种「空」：
       · 刚查出来、用户还没动过 → 兜底前 3 条（保持「先看个大概」的老体验）
       · 用户已经动过、主动全关   → 就是空，一条都不画
     hInit 就是这个「有没有被确定过」的标志：换设备/换时间重新查询会重置它。 */
  if (!on.length && !hInit) on = all.slice(0, 3);
  /* 最多 6 条：再多就糊成一片，看不出单条曲线 */
  if (on.length > 6) on = on.slice(0, 6);
  return on;
}

function drawChart() {
  var cv = el('hCv');
  if (!cv || !G.hist) return;
  var series = G.hist.series || {};
  var keys = activeCurves();

  var W = cv.width, H = cv.height;
  var g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);

  var padL = 52, padR = 14, padT = 14, padB = 30;
  var iw = W - padL - padR, ih = H - padT - padB;

  /* 值域 */
  var tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  keys.forEach(function (k) {
    (series[k] || []).forEach(function (p) {
      var t = p[0], v = p[1];
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    });
  });
  /* 【v0.33 修订三】一个变量都没选时（用户主动全关掉）：
     画布上明确写一句「未选择变量」，别留一块空白让人以为图坏了。
     注意下面 isFinite 的提前返回在无数据时也会走到，
     所以这句提示放在两个分支之前，坐标轴那条路已经提前 return。 */
  if (!keys.length) {
    g.fillStyle = '#8b93a1';
    g.font = '14px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('未选择变量 —— 点下面的变量名即可显示曲线', W / 2, H / 2);
    var lg0 = el('hLg');
    if (lg0) lg0.innerHTML = '';
    var ax0 = el('hAx');
    if (ax0) ax0.textContent = '未选择任何变量';
    return;
  }
  if (!isFinite(tMin)) return;
  if (tMax === tMin) tMax = tMin + 1;
  if (vMax === vMin) { vMax = vMin + 1; }

  var pad = (vMax - vMin) * 0.1;
  vMin -= pad; vMax += pad;

  function X(t) { return padL + (t - tMin) / (tMax - tMin) * iw; }
  function Y(v) { return padT + ih - (v - vMin) / (vMax - vMin) * ih; }

  /* 横向网格 + Y 轴 */
  g.strokeStyle = '#eceff4';
  g.fillStyle = '#8b93a1';
  g.font = '11px sans-serif';
  g.textAlign = 'right';
  g.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var v = vMin + (vMax - vMin) * i / 4;
    var y = Y(v);
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(W - padR, y);
    g.stroke();
    g.fillText(fmtV(v), padL - 6, y + 4);
  }

  /* X 轴时间刻度 */
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (var j = 0; j <= 3; j++) {
    var t = tMin + (tMax - tMin) * j / 3;
    var x = X(t);
    g.strokeStyle = '#f2f4f8';
    g.beginPath();
    g.moveTo(x, padT);
    g.lineTo(x, padT + ih);
    g.stroke();
    g.fillStyle = '#8b93a1';
    g.fillText(fmtT(t), x, padT + ih + 7);
  }

  /* 曲线 */
  keys.forEach(function (k) {
    var pts = series[k] || [];
    if (!pts.length) return;
    var c = PAL[Object.keys(series).indexOf(k) % PAL.length];
    g.strokeStyle = c;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach(function (p, i) {
      var x = X(p[0]), y = Y(p[1]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
    /* 末点 */
    var last = pts[pts.length - 1];
    g.fillStyle = c;
    g.beginPath();
    g.arc(X(last[0]), Y(last[1]), 3, 0, 6.284);
    g.fill();
  });

  /* 图例 */
  var lg = el('hLg');
  if (lg) {
    lg.innerHTML = keys.map(function (k) {
      var idx = Object.keys(series).indexOf(k) % PAL.length;
      var nm = '';
      (G.hist.vars || []).forEach(function (v) {
        if (v.name === k) nm = v.unit || '';
      });
      var last = '';
      var pts = series[k] || [];
      if (pts.length) last = fmtV(pts[pts.length - 1][1]);
      return '<i><b style="background:' + PAL[idx] + '"></b>' + esc(k) +
        (nm ? '(' + esc(nm) + ')' : '') + ' ' + last + '</i>';
    }).join('');
  }

  var ax = el('hAx');
  if (ax) ax.textContent = fmtT(tMin) + '　至　' + fmtT(tMax) + '　共 ' +
    keys.length + ' 条曲线';
}

function fmtV(v) {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function fmtT(ms) {
  var d = new Date(ms);
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
