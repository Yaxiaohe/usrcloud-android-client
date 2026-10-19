/* 启动 */
var booted = false;

function loadHealth() {
  var r = api('health', {});
  if (r.ok) {
    G.health = r;
    el('hver').textContent = 'v' + r.version;
  }
}

function loadAccounts() {
  var r = api('accounts', {});
  if (r.ok) {
    G.accounts = r.accounts || [];
    if (!Object.keys(G.picked).length) {
      G.accounts.forEach(function (a) { if (a.enabled) G.picked[a.name] = true; });
    }
  }
}

function loadRules() {
  var r = api('rulesGet', {});
  if (r.ok) G.rules = r.rules;
}

/* 【v0.35】变量置顶清单。读不到就当空表 —— 空表 = 全走默认分档，
   也就是「出水/供水 → 进水/回水 → …」，不会因为读失败把顺序搞乱。 */
function loadVarOrder() {
  var r = api('varOrder', {});
  if (r.ok) G.vars = r.list || [];
}

/* 【v0.36】置顶站名清单。同样读不到就当空表 = 保持各处原有顺序。 */
function loadDevOrder() {
  var r = api('devOrder', {});
  if (r.ok) G.devPins = r.list || [];
}

function boot() {
  /* WebView 有时会重复抛 DOMContentLoaded，重复初始化会把 busy 状态搞乱 */
  if (booted) return;
  booted = true;

  /* 【v0.23 修问题 1 后半段】记住上次停在哪个页签。
     以前 tab 只是个内存变量，进程一死就回到默认值 'watch'，
     用户反馈「再打开时无论之前在哪个页面都会回到监控页面」。
     现在切页时把页签落到 localStorage，启动时读回来。
     只认已知的 5 个页签，脏值一律退回监控 ——
     之前 v0.20 就是被「localStorage 里存了脏值」坑过。 */
  try {
    var lt = localStorage.getItem('xunjian.tab.v1');
    if (lt) {
      var known = false;
      for (var i = 0; i < TABS.length; i++) {
        if (TABS[i].k === lt) { known = true; break; }
      }
      if (known) G.tab = lt;
    }
  } catch (e) { }

  loadHealth();
  loadAccounts();
  loadRules();
  loadVarOrder();
  loadDevOrder();
  var s = api('status', { since: 0 });
  if (s.ok) {
    /* 【v0.22 修】这里原来直接 G.seq = s.seq，把游标设成了「后端当前最新」。
       而 pollLog / step 都用 since=G.seq 做增量拉取 ——
       于是日志页第一次打开时 since 已经等于最新，
       只能拉到「打开之后新写的」，之前累积的日志一条都取不到。
       切到别的页再回来，同样什么也没有。
       现在游标从 0 起步，让日志页把历史补齐（后端 logs 是环形缓冲，
       最多 200 行，一次拉完没有压力）。 */
    G.seq = 0;
    G.st = s;
    /* 【v0.31 修订】恢复轮询时也记下 run_id：不然 G.runId 是 0，
       上面的「本轮守门」不生效，切页回来仍可能被残留状态骗一次。 */
    if (s.running) { G.busy = true; G.runId = s.run_id || 0; pollStatus(); }
  }
  // 走 go() 而不是 buildNav()+render()，否则标题栏不会更新成当前页签名
  go(G.tab);
}

/* 原生 onResume 检测到「所有文件访问」授权变化时回调 */
window.onAllFilesChanged = function (granted) {
  loadHealth();
  if (granted) toast('已获得授权，截图将保存到手机根目录');
  if (G.tab === 'patrol') render();
};

/* 原生 onResume 检测到通知授权变化时回调（用户去系统设置里开完通知返回） */
window.onNotifyChanged = function (on) {
  loadHealth();
  if (on) toast('通知已开启，设备异常会弹通知提醒');
  if (G.tab === 'me') render();
};

document.addEventListener('DOMContentLoaded', boot);
