/* 日志页 */

/* ---------- v0.22：日志合并与去重 ----------
 *
 * 【原来的问题】用户报「只有第一次点进去有日志，切页面再进去就被清空了」。
 * 两个原因叠在一起：
 *   1) _boot.js 里 G.seq = s.seq，游标直接设成后端最新值 ——
 *      日志页第一次打开时 since 已经等于最新，只能拉到「打开之后新写的」。
 *   2) 巡站页的 step() 和日志页的 pollLog() 共用同一个 G.seq ——
 *      巡站跑完 G.seq 被推到最新，切到日志页就再也拉不到之前的内容。
 *
 * 【现在怎么做】
 * 巡站页和日志页各有各的游标（G.seq / G.logSeq），互不干扰。
 * 两边拉回来的日志都走 mergeLogs()，按 seq 去重后合并进 G.logBuf。
 * 后端 logs 是环形缓冲（最多 200 行），用 seq 做键不会重复，
 * 也不会因为「谁先拉」而漏行。 */
function mergeLogs(lines) {
  if (!lines || !lines.length) return 0;
  if (!G.logSeen) G.logSeen = {};
  if (!G.logBuf) G.logBuf = [];
  var added = 0;
  lines.forEach(function (l) {
    var seq = (l && typeof l.seq === 'number') ? l.seq : null;
    var line = (l && typeof l === 'object') ? l.line : l;
    if (typeof line !== 'string') return;
    /* 没有 seq 的（理论上不该有）按内容+长度做粗去重 */
    var k = seq === null ? ('t:' + line) : ('s:' + seq);
    if (G.logSeen[k]) return;
    G.logSeen[k] = 1;
    G.logBuf.push({ s: seq === null ? 1e15 : seq, t: line });
    added++;
  });
  if (added) {
    G.logBuf.sort(function (a, b) { return a.s - b.s; });
    if (G.logBuf.length > 200) {
      var cut = G.logBuf.splice(0, G.logBuf.length - 200);
      /* 丢弃的行要从去重表里清掉，否则 seq 回绕时会漏行 */
      cut.forEach(function (x) {
        var k = x.s === 1e15 ? ('t:' + x.t) : ('s:' + x.s);
        delete G.logSeen[k];
      });
    }
  }
  return added;
}

function resetLogs() {
  G.logBuf = [];
  G.logSeen = {};
  G.logSeq = 0;
}

function V_log() {
  if (G.tab !== 'log') return;
  var h = '<div class="card" style="padding:10px">' +
    '<div class="row" style="margin-bottom:8px;padding:0 4px">' +
    '<span class="muted tiny" id="lgInfo">界面显示最近 200 行</span>' +
    '<span class="sp"></span>' +
    '<button class="sm" id="lgClr">清屏</button></div>' +
    '<div id="logbox"></div></div>';
  el('main').innerHTML = h;
  el('lgClr').onclick = function () {
    resetLogs();
    paintLog();
    toast('已清屏（不影响后台日志）');
  };
  pollLog();
}

function pollLog() {
  /* 日志页用自己的游标，不再跟巡站页抢 G.seq。
     进页面一律从 0 拉一次（环形缓冲最多 200 行，一次拉完没压力），
     之后才用 logSeq 做增量。 */
  var since = G.logSeq || 0;
  var r = api('status', { since: since });
  if (!r.ok) return;
  if (r.logs && r.logs.length) {
    mergeLogs(r.logs);
    G.logSeq = r.seq;
  } else if (!since && r.seq) {
    /* 后端一条都没有，但游标得跟上，否则每次进页面都白拉一次 */
    G.logSeq = r.seq;
  }
  paintLog();
  var i = el('lgInfo');
  if (i) {
    i.textContent = (r.running ? '巡站运行中 · ' : '') + '最近 ' + G.logBuf.length + ' 行';
  }
}

function paintLog() {
  var b = el('logbox');
  if (!b) return;
  var atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 30;
  b.innerHTML = (G.logBuf || []).map(function (x) { return logCls(x.t); }).join('');
  if (atBottom) b.scrollTop = b.scrollHeight;
}

function logCls(line) {
  var c = '';
  if (line.indexOf('[错误]') >= 0 || line.indexOf('失败') >= 0 || line.indexOf('ERROR') >= 0) c = 'e';
  else if (line.indexOf('[警告]') >= 0 || line.indexOf('异常') >= 0) c = 'w';
  else if (line.indexOf('[完成]') >= 0 || line.indexOf('成功') >= 0) c = 'g';
  else if (line.indexOf('[') === 7) c = 'i';
  /* 【v0.18 修】原来每行是一个 <span>，而 span 是 inline 元素，
     29 行日志会连成一整块浆糊，完全没法读。
     两行日志之间必须真的有换行。
     这里在末尾补 \\n：父容器 #logbox 有 white-space:pre-wrap，
     会把它渲染成真实换行。不加 display:block 是因为那会让
     每行的背景色/间距跟着变，影响观感。 */
  return '<span class="' + c + '">' + esc(line) + '</span>\n';
}
