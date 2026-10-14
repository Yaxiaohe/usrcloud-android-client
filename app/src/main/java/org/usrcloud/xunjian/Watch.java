package org.usrcloud.xunjian;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 数据监控引擎（移植自电脑版 watch_engine.py）。
 *
 * 与巡站的区别：
 *   巡站 = 跑一次、给每台设备出图
 *   监控 = 常驻后台按间隔（默认 15 分钟）低频轮询，只维护「设备当前状态」，
 *          不出图；状态变化时按规则生成异常提醒。
 *
 * 状态判定沿用同一套口径（在线/数据陈旧/离线/采集异常），保证两页显示一致。
 */
public class Watch {

    // ---- 与电脑版一致的常量 ----
    public static final int DEFAULT_INTERVAL = 900;   // 15 分钟
    public static final int RATE_PER_SEC = 3;         // 令牌桶平均速率
    public static final int RATE_BURST = 5;
    public static final int CONCURRENCY = 3;
    public static final int MAX_BACKOFF = 3600;       // 连续失败最大退避
    public static final int BACKOFF_429 = 1800;       // 触发风控后暂停

    public static final Map<String, String> ST_TEXT = new LinkedHashMap<>();
    public static final Map<String, String> STATUS_LEVEL = new LinkedHashMap<>();

    static {
        // 状态显示文本必须与巡站页一致（前端用字符串比较）
        ST_TEXT.put("online", "在线");
        ST_TEXT.put("stale", "数据陈旧");
        ST_TEXT.put("offline", "离线");
        ST_TEXT.put("blank", "采集异常");
        STATUS_LEVEL.put("离线", "critical");
        STATUS_LEVEL.put("数据陈旧", "critical");
        STATUS_LEVEL.put("采集异常", "warn");
        STATUS_LEVEL.put("在线", "ok");
    }

    // ---- 全局状态 ----
    /* 【v0.20 修复】原来 enabled 是纯内存变量，app 一重启就自动变回 false。
       用户体感是「监控自己停了 / 第二次巡检没反应」，
       而且没有任何提示 —— 因为确实没人再去看这个值。
       现在落盘持久化，重启后自动恢复用户上次的开关状态。 */
    public static volatile boolean enabled = false;
    public static volatile int intervalSec = DEFAULT_INTERVAL;
    /* 【v0.29 修复】并发守卫抽到 WatchGuard（零依赖，可独立单测）。
       原来 scanning 是普通 boolean，靠 scan() 开头置 true、结尾置 false，两个致命缺陷：
         1) 手动「立即巡检」(scanAsync) 和周期巡检(调度器) 都直接调 scan()，
            用同一个 scanning 当锁却都没有 CAS —— 两边都看到 false 就同时进，
            两份 scan() 并发跑、状态互相覆盖。
         2) scan() 中途抛异常时（网络/解析），结尾的 scanning=false 跑不到，
            scanning 永远卡在 true：UI 一直显示「巡检中…」，
            手动巡检在 if (scanning) 处直接被挡掉，周期巡检则「跑着但没结果」
            —— 用户看到的就是「监控中却再也不更新」。
       现在锁统一是 WatchGuard.scanning（AtomicBoolean），由调用方在 finally 释放。
       进度文案 scanProgress 仍在本类（纯字符串，无依赖）。 */
    public static volatile String scanProgress = null;
    public static volatile String lastScan = null;
    public static volatile int backoffSec = 0;
    public static volatile String notice = null;

    /** 监控开关的落盘文件名（放私有目录，覆盖安装不会丢）。 */
    private static final String PREF_FILE = "watch_on.txt";

    private static synchronized void persistEnabled() {
        try {
            java.io.File f = new java.io.File(Core.rootDir(), PREF_FILE);
            java.io.OutputStreamWriter w =
                    new java.io.OutputStreamWriter(new java.io.FileOutputStream(f), "UTF-8");
            w.write(enabled ? "1" : "0");
            w.flush();
            w.close();
        } catch (Exception e) {
            Core.log("[监控] 开关状态保存失败: " + e.getMessage());
        }
    }

    /** 读回上次的状态。只在 app 启动时调一次。 */
    public static synchronized void restoreEnabled() {
        try {
            java.io.File f = new java.io.File(Core.rootDir(), PREF_FILE);
            if (!f.exists()) return;
            byte[] b = Core.readAllBytesOf(f);
            String s = new String(b, java.nio.charset.Charset.forName("UTF-8")).trim();
            enabled = "1".equals(s);
            if (enabled) {
                Core.log("[监控] 已恢复上次的监控开关：开启（间隔 "
                        + (intervalSec / 60) + " 分钟）");
            }
        } catch (Exception e) {
            Core.log("[监控] 开关状态读取失败: " + e.getMessage());
        }
    }

    /** 设备当前状态：key = 账号名 + "|" + 设备号 */
    public static final Map<String, DevState> states = new LinkedHashMap<>();
    /** 异常提醒队列（新的在前） */
    public static final List<Alert> alerts = new ArrayList<>();
    public static int alertSeq = 0;
    /** 选定的监控账号范围；空 = 全部启用账号 */
    public static volatile List<String> scope = new ArrayList<>();

    private static final ScheduledExecutorService SCHED =
            Executors.newSingleThreadScheduledExecutor();
    private static ScheduledFuture<?> handle;

    public static class DevState {
        public String acc;
        public String no;
        public String name;
        public String status = "blank";
        public double ageMin = -1;
        public String dataTime = "--";
        public long updatedAt = 0;
        public List<String[]> rows = new ArrayList<>();
        /** 上一次的判定，用来判断「是否变化」 */
        public String prevStatus = null;

        public String statusText() {
            return ST_TEXT.getOrDefault(status, status);
        }

        public String level() {
            return STATUS_LEVEL.getOrDefault(statusText(), "warn");
        }
    }

    public static class Alert {
        public int id;
        public long time;
        public String acc;
        public String dev;
        public String varName;
        public String message;
        public String level = "warn";
        public boolean fresh = true;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id);
                o.put("time", time);
                o.put("acc", acc);
                o.put("dev", dev);
                o.put("var", varName);
                o.put("msg", message);
                o.put("level", level);
                o.put("fresh", fresh);
            } catch (Exception ignored) {
            }
            return o;
        }
    }

    /**
     * 【v0.18 新增】有异常设备、却没有任何规则覆盖的账号。
     *
     * 【为什么需要】用户反馈「消息提醒不提示示例账号的站点」。
     * 查下来不是代码没跑，而是：他加的规则都是「数值越限」类
     * 且指定了具体账号（线路-*），示例账号名下的设备
     * 一条规则都没匹配上，所以一条提醒都不发。
     *
     * 但界面上完全看不出来这件事 ——
     * 统计条只显示「离线 1 / 陈旧 3」，不告诉你这些异常没人管；
     * 规则列表只显示规则文本，也不显示它覆盖了哪些账号。
     * 用户只能自己在脑子里把「异常设备」和「规则」对上，
     * 对不上就只能得出「功能坏了」的结论。
     *
     * 这里把这件事算出来主动告诉前端。
     * key = 账号名，value = {stale: n, offline: n}，只记异常设备数。
     */
    public static final Map<String, int[]> uncovered = new LinkedHashMap<>();

    // ---------------- 规则（监控规则.json） ----------------

    private static File rulesFile() {
        return new File(Core.rootDir(), "监控规则.json");
    }

    public static JSONObject loadRules() {
        JSONObject base = new JSONObject();
        try {
            base.put("version", 1);
            base.put("stale_minutes", Core.STALE_MINUTES);
            base.put("flag_blank", true);
            /* v0.17：默认不再「只在状态变化时提醒」。
               那样只有第一次有反应，用户以为功能坏了。
               改成每次命中都提醒，靠 repeat_cooldown_min 防刷屏。 */
            base.put("notify_on_change_only", false);
            base.put("repeat_cooldown_min", 60);
            base.put("rules", new JSONArray());
        } catch (Exception ignored) {
        }
        File f = rulesFile();
        if (!f.exists()) return base;
        try {
            JSONObject d = new JSONObject(Core.readFile(f));
            for (String k : new String[]{"stale_minutes", "flag_blank",
                    "notify_on_change_only", "repeat_cooldown_min", "rules"}) {
                if (d.has(k)) base.put(k, d.get(k));
            }
        } catch (Exception e) {
            Core.log("[监控] 规则读取失败: " + e.getMessage());
        }
        /* 【v0.26】把持久化的阈值同步回 Core.STALE_MINUTES：
           监控判定用 cfg 里的 stale_minutes，巡站状态判定（DevData）用
           Core.STALE_MINUTES —— 不同步的话改了设置会出现
           「监控说陈旧、巡站页还显示在线」的两张皮。 */
        Core.STALE_MINUTES = Math.max(1, base.optInt("stale_minutes", Core.STALE_MINUTES));
        return base;
    }

    public static void saveRules(JSONObject rules) throws Exception {
        Core.writeFile(rulesFile(), rules.toString(2));
    }

    /**
     * 通配匹配：`*` 任意串。规则的 账号/设备名/变量名 都支持。
     * 收窄范围：填 * 表示全部。
     */
    /**
     * 通配匹配。【v0.21 重写】
     *
     * 【v0.20 的真缺陷 —— 用户反馈「规则填了没反应」的根因】
     * 原来是把 * 转成 .* 拼正则，然后调 String.matches()。
     * matches() 要求【整串匹配】，于是：
     *     规则填「*回水温度」→ 正则 ^.*回水温度$
     *     变量实际叫「回水温度T2」→ 以 T2 结尾
     *     不匹配 → 规则永远不触发
     *
     * 用户的规则本身完全正确（回水温度 36.7°C，阈值小于 40，确实该报警），
     * 是匹配语义做反了。界面提示写的是「支持 * 通配」，
     * 没人会想到单边 * 是「必须以它结尾」这种反直觉的规则。
     *
     * 【v0.21 改成包含语义】
     * 只要出现 *，就按「名字里含有这些字」处理，三个片段用 | 连接：
     *     *温度     → 含「温度」  → 供水温度T1 / 室内温度T3 都命中
     *     温度*     → 含「温度」  → 同上
     *     供*T1     → 含「供」且含「T1」→ 供水温度T1 命中
     *     某线路*     → 含「某线路」  → 某站补水泵 命中
     *     *         → 全部
     * 不写 * 时是精确相等（用户想精确匹配时仍然可用）。
     *
     * 不再走「* 在头 = 结尾、* 在尾 = 开头」这套前后缀规则 ——
     * 那是把 contains 语义错做成了 prefix/suffix，正是这次的祸根。
     */
    public static boolean wmatch(String pat, String s) {
        if (pat == null || pat.isEmpty() || pat.equals("*")) return true;
        if (s == null) return false;
        String p = pat.trim();
        if (p.indexOf('*') < 0) return s.equals(p);
        StringBuilder core = new StringBuilder();
        for (String part : p.split("\\*", -1)) {
            String t = part.trim();
            if (t.isEmpty()) continue;
            if (core.length() > 0) core.append('|');
            core.append(java.util.regex.Pattern.quote(t));
        }
        if (core.length() == 0) return true;
        try {
            return s.matches("(?s).*(?:" + core + ").*");
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------- 开关 ----------------

    public static synchronized void setEnabled(boolean on) {
        if (on == enabled) return;
        enabled = on;
        /* 【v0.20】落盘。重启后 restoreEnabled() 读回来，
           用户不必每次开 app 都手动重新打开监控。 */
        persistEnabled();
        if (on) {
            Core.log("[监控] 启动监控，间隔 " + (intervalSec / 60) + " 分钟");
            if (handle == null || handle.isCancelled()) {
                handle = SCHED.scheduleWithFixedDelay(() -> {
                    /* 原子守卫：上一轮还没跑完（或手动巡检进行中）就跳过这一拍，
                       不并发、不堆积。CAS 失败说明有别的扫描在跑，直接 return，
                       下一拍调度照常进行 —— 不会因此停摆。 */
                    if (!WatchGuard.tryBeginScan()) return;
                    try {
                        if (enabled) scan();
                    } catch (Throwable e) {
                        Core.log("[监控] 巡检异常: " + e);
                    } finally {
                        WatchGuard.scanning.set(false);
                        scanProgress = null;
                    }
                }, 2, intervalSec, TimeUnit.SECONDS);
            }
        } else {
            Core.log("[监控] 已暂停监控");
            if (handle != null) {
                handle.cancel(false);
                handle = null;
            }
        }
    }

    public static void setInterval(int sec) {
        intervalSec = Math.max(60, sec);
        Core.log("[监控] 间隔改为 " + (intervalSec / 60) + " 分钟");
        if (enabled) {
            setEnabled(false);
            setEnabled(true);
        }
    }

    /** 原子抢锁：同一时刻只允许一个扫描（手动或周期）在跑。
     *  返回 true 表示抢到，调用方负责在 finally 里 WatchGuard.scanning.set(false) 释放。
     *  实际实现在零依赖的 WatchGuard 里，这里只是透传，方便调用处语义清晰。 */
    public static boolean tryBeginScan() {
        return WatchGuard.tryBeginScan();
    }

    public static void scanAsync() {
        if (!WatchGuard.tryBeginScan()) {
            Core.log("[监控] 巡检进行中，忽略本次");
            return;
        }
        new Thread(() -> {
            try {
                scan();
            } catch (Throwable e) {
                Core.log("[监控] 巡检失败: " + e);
            } finally {
                WatchGuard.scanning.set(false);
                scanProgress = null;
            }
        }).start();
    }

    /**
     * 【v0.30 新增】刷新单台设备的实时数据。
     *
     * <p>场景：用户在监控页点开某个站点，希望就地拉一次最新值，
     * 而不用等整轮巡检（一轮要跑几十台，等不起）；以及点系统通知跳进来时
     * 要「直接看到当前数据」。
     *
     * <p>不占用扫描锁（WatchGuard.scanning）—— 它不是整轮巡检，
     * 只查一台，快进快出；也不会去动其它设备的状态，
     * 避免和正在跑的整轮 scan() 互相覆盖。
     *
     * <p>返回更新后的单台状态 JSON（结构与 statesJson 里的一项一致），
     * 前端据此就地替换那一行的数据。
     */
    public static JSONObject refreshDevice(String accName, String devNo) throws Exception {
        if (accName == null || accName.isEmpty()) throw new RuntimeException("缺少账号");
        if (devNo == null || devNo.isEmpty()) throw new RuntimeException("缺少设备编号");

        Account cfg = null;
        for (Account a : Core.loadAccounts()) {
            if (accName.equals(a.name)) { cfg = a; break; }
        }
        if (cfg == null) throw new RuntimeException("账号不存在：" + accName);

        int staleMinutes = Math.max(1, Core.STALE_MINUTES);
        String tok = Core.ensureLogin(cfg);
        DevData dd = Core.fetchDeviceDataQuiet(tok, devNo);

        String key = accName + "|" + devNo;
        DevState st;
        synchronized (states) {
            DevState old = states.get(key);
            st = new DevState();
            st.acc = accName;
            st.no = devNo;
            st.name = old == null ? devNo : old.name;
            st.prevStatus = old == null ? null : old.status;
        }
        st.status = judge(dd, staleMinutes);
        st.ageMin = dd.ageMinutes();
        st.rows = dd.rows;
        st.dataTime = newestTime(dd);
        st.updatedAt = System.currentTimeMillis();
        /* 单台刷新也顺手落盘：用户主动拉的最新值理应进历史，图表才跟得上 */
        if (!dd.rows.isEmpty()) {
            Hist.record(accName, devNo, st.name, dd.rows);
        }
        synchronized (states) {
            states.put(key, st);
        }
        /* 【v0.31】单台刷新也更新快照，否则重开 app 会退回上一次整轮巡检的旧值 */
        saveSnapshot();
        return stateJson(st);
    }

    /**
     * 【v0.31】下发单个变量的值到真实设备。
     *
     * <p>闸门放在 Java 侧，不只靠前端：屏幕上那个「调整」按钮只是 UI，
     * 变量可能已被平台改成只读、账号可能被收走操作权限，而前端手上这份数据
     * （尤其是从磁盘快照恢复来的）完全可能已经过期。
     * 所以这里再拿内存里的真实巡检结果核一遍：
     * ① 变量存在 ② readWrite==1 且 permissionOp==1 ③ 前端传的下发编号与记录一致。
     * 任一不满足直接拒掉，绝不把没核对过的 id 发给设备。
     *
     * <p>返回的 {@code ok=true} 只代表平台受理了指令，不代表设备已改
     * （实测连不存在的变量 id 也返回 success）—— 界面上必须这么说。
     */
    public static JSONObject setVar(String accName, String devNo, long relId,
                                    String varName, String value) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", false);
        if (accName == null || accName.isEmpty()) return o.put("msg", "缺少账号");
        if (devNo == null || devNo.isEmpty()) return o.put("msg", "缺少设备编号");
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) return o.put("msg", "下发值不能为空");

        Account cfg = null;
        for (Account a : Core.loadAccounts()) {
            if (accName.equals(a.name)) { cfg = a; break; }
        }
        if (cfg == null) return o.put("msg", "账号不存在：" + accName);

        DevState st;
        synchronized (states) {
            st = states.get(accName + "|" + devNo);
        }
        if (st == null) return o.put("msg", "还没有这台设备的数据，请先点「刷新这台」");

        String[] meta = null;
        String curVal = "-";
        for (String[] r : st.rows) {
            if (r.length > 1 && varName != null && varName.equals(r[1])) {
                meta = r.length > 5 ? r[5].split("\\|", -1) : null;
                curVal = r.length > 4 ? r[4] : "-";
                break;
            }
        }
        if (meta == null || meta.length < 3) {
            return o.put("msg", "这台设备没有「" + varName + "」的可写信息，请点「刷新这台」后重试");
        }
        long metaRel = 0;
        try { metaRel = Long.parseLong(meta[0]); } catch (Exception ignored) { }
        if (!"1".equals(meta[1]) || !"1".equals(meta[2])) {
            return o.put("msg", "当前账号对「" + varName + "」没有下发权限"
                    + "（平台标记：变量" + ("1".equals(meta[1]) ? "可写" : "只读")
                    + "、账号" + ("1".equals(meta[2]) ? "有权限" : "无权限") + "）");
        }
        if (relId > 0 && metaRel > 0 && relId != metaRel) {
            return o.put("msg", "变量信息已变化，请点「刷新这台」后重试");
        }
        long useRel = relId > 0 ? relId : metaRel;
        if (useRel <= 0) return o.put("msg", "拿不到变量的下发编号，请点「刷新这台」后重试");

        String tok = Core.ensureLogin(cfg);
        Core.log("[下发] " + accName + " / " + st.name + " / " + varName
                + "：" + curVal + " → " + v);

        JSONObject r = Core.setDataPoint(tok, devNo, useRel, v);
        r.put("acc", accName);
        r.put("no", devNo);
        r.put("dev", st.name);
        r.put("var", varName);
        r.put("value", v);
        r.put("before", curVal);
        if (!r.optBoolean("ok", false) && r.optString("msg", "").isEmpty()) {
            r.put("msg", "下发失败");
        }
        return r;
    }

    // ---------------- 监控快照持久化（v0.31） ----------------

    /* 用户反馈：每次重开 app，监控页的站点信息都是空的，得等一整轮巡检才有东西。
       一轮几十台、还要限速，等的就是「一进来什么都没有」。
       所以把每轮巡检的结果落盘，启动时读回来先顶上，新一轮跑完自然覆盖。
       注意是**覆盖写**（快照只留最近一次），不像历史 CSV 那样追加，
       所以文件大小有上界、不会随时间膨胀。 */
    private static final String SNAP_FILE = "监控快照.json";
    /** 本次启动用的是磁盘快照（界面据此说明「这是上次保存的结果」）。 */
    public static volatile boolean restored = false;
    /** 快照体积上限：异常大的文件直接不读，别把启动拖住。 */
    private static final long SNAP_MAX = 8L * 1024 * 1024;

    private static File snapFile() {
        return new File(Core.rootDir(), SNAP_FILE);
    }

    /** 丢掉不在本轮监控范围（账号被停用/删除/移出范围）内的设备状态。 */
    private static void pruneOutOfScope() {
        java.util.Set<String> keep = new java.util.HashSet<>(accountsInScope());
        synchronized (states) {
            java.util.Iterator<String> it = states.keySet().iterator();
            while (it.hasNext()) {
                DevState s = states.get(it.next());
                if (s == null || !keep.contains(s.acc)) it.remove();
            }
        }
    }

    /** 把当前设备列表落盘。覆盖写，不追加。 */
    public static synchronized void saveSnapshot() {
        try {
            JSONObject o = new JSONObject();
            o.put("version", 1);
            o.put("saved_at", System.currentTimeMillis());
            o.put("last_scan", lastScan == null ? JSONObject.NULL : lastScan);
            o.put("devices", statesJson());
            Core.writeFile(snapFile(), o.toString());
        } catch (Exception e) {
            Core.log("[监控] 快照保存失败: " + e.getMessage());
        }
    }

    /**
     * 启动时把上次的设备列表读回来。
     *
     * <p>只恢复「设备列表 + 上次巡检时间」：提醒队列是给用户看的即时消息，
     * 重启后原样弹出来反而像新告警，所以不恢复。
     *
     * <p>顺带清掉账号已经不在账号表里的设备 —— 否则删掉一个账号后，
     * 它的设备会一直留在监控页上，点进去还刷不出来，看着像幽灵数据。
     */
    public static synchronized void restoreSnapshot() {
        try {
            File f = snapFile();
            if (!f.exists()) return;
            if (f.length() > SNAP_MAX) {
                Core.log("[监控] 快照过大（" + (f.length() / 1024) + "KB），跳过恢复");
                return;
            }
            JSONObject o = new JSONObject(Core.readFile(f));
            JSONArray arr = o.optJSONArray("devices");
            if (arr == null || arr.length() == 0) return;

            java.util.Set<String> known = new java.util.HashSet<>();
            for (Account a : Core.loadAccounts()) known.add(a.name);

            int n = 0, dropped = 0;
            synchronized (states) {
                states.clear();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject d = arr.optJSONObject(i);
                    if (d == null) continue;
                    String acc = d.optString("acc", "");
                    if (!known.contains(acc)) { dropped++; continue; }
                    DevState s = new DevState();
                    s.acc = acc;
                    s.no = d.optString("no", "");
                    s.name = d.optString("name", s.no);
                    s.status = d.optString("status", "blank");
                    s.ageMin = d.optDouble("age_min", -1);
                    s.dataTime = d.optString("data_time", "--");
                    /* prevStatus 留 null：这一轮是「恢复」不是「新判定」，
                       拿它去比状态变化会凭空造出一条提醒。 */
                    s.prevStatus = null;
                    JSONArray rows = d.optJSONArray("rows");
                    if (rows != null) {
                        for (int j = 0; j < rows.length(); j++) {
                            JSONArray r = rows.optJSONArray(j);
                            if (r == null) continue;
                            s.rows.add(new String[]{
                                    "", r.optString(0, ""), "",
                                    r.optString(2, "-"), r.optString(1, "-"),
                                    r.length() > 3 ? r.optString(3, "") : ""});
                        }
                    }
                    states.put(s.acc + "|" + s.no, s);
                    n++;
                }
            }
            if (o.has("last_scan") && !o.isNull("last_scan")) {
                lastScan = o.optString("last_scan", null);
            }
            restored = n > 0;
            Core.log("[监控] 已恢复上次的设备列表 " + n + " 台"
                    + (dropped > 0 ? "（丢弃已删账号的设备 " + dropped + " 台）" : "")
                    + "，上次巡检 " + (lastScan == null ? "未知" : lastScan));
        } catch (Exception e) {
            Core.log("[监控] 快照恢复失败: " + e.getMessage());
        }
    }

    /** 单个 DevState → JSON（statesJson 与 refreshDevice 共用，避免两处结构漂移）。 */
    static JSONObject stateJson(DevState s) {
        JSONObject o = new JSONObject();
        try {
            o.put("acc", s.acc);
            o.put("no", s.no);
            o.put("name", s.name);
            o.put("status", s.status);
            o.put("status_text", s.statusText());
            o.put("level", s.level());
            o.put("age_min", s.ageMin);
            o.put("age_text", DevData.fmtAge(s.ageMin));
            o.put("data_time", s.dataTime);
            o.put("rows", rowsJson(s.rows));
        } catch (Exception ignored) {
        }
        return o;
    }

    // ---------------- 巡检主体 ----------------

    private static long lastTokenTime = 0;
    private static int tokenCount = 0;

    /** 令牌桶限速，避免触发平台风控。 */
    private static synchronized void rateLimit() {
        long now = System.currentTimeMillis();
        if (now - lastTokenTime >= 1000) {
            lastTokenTime = now;
            tokenCount = 0;
        }
        if (tokenCount < RATE_BURST) {
            tokenCount++;
            return;
        }
        try {
            Thread.sleep(1000);
            lastTokenTime = System.currentTimeMillis();
            tokenCount = 1;
        } catch (InterruptedException ignored) {
        }
    }

    private static final List<String> accountsInScope() {
        List<Account> all = Core.loadAccounts();
        List<String> out = new ArrayList<>();
        for (Account a : all) {
            if (!a.enabled) continue;
            if (!scope.isEmpty() && !scope.contains(a.name)) continue;
            out.add(a.name);
        }
        return out;
    }

    public static void scan() throws Exception {
        /* 【v0.29】scanning 不再在这里置位/复位：
           抢锁与放锁统一由调用方（scanAsync 的 finally、调度器 lambda 的 finally）
           用 tryBeginScan() 的 CAS 完成。这样无论 scan() 正常返回还是中途抛异常，
           锁一定会被释放，不会卡死在「巡检中…」，也不会让手动巡检被自己堵死。 */
        long t0 = System.currentTimeMillis();
        int devTotal = 0, devOn = 0, devStale = 0, devOff = 0, devBlank = 0;
        int newAlerts = 0;
        int done = 0;
        String endNote = "";
        try {
            JSONObject rules = loadRules();
            int staleMinutes = rules.optInt("stale_minutes", Core.STALE_MINUTES);
            boolean flagBlank = rules.optBoolean("flag_blank", true);
            boolean onlyChange = rules.optBoolean("notify_on_change_only", false);
            /* 每次都提醒时的冷却期（分钟）。0 = 不去重，每轮都发。
               默认 60 分钟：15 分钟一轮的话一小时最多 4 条，既不会静默也不会刷屏。 */
            int cooldownMin = rules.optInt("repeat_cooldown_min", 60);
            JSONArray rls = rules.optJSONArray("rules");
            if (rls == null) rls = new JSONArray();

            List<String> accs = accountsInScope();
            if (accs.isEmpty()) {
                Core.log("[监控] 没有启用中的账号");
                endNote = "（无启用账号）";
                return;
            }

            /* 【v0.18】每轮重算「有异常但没规则覆盖」的账号。
               必须每轮清空：上一轮的残留会让本轮已经补了规则的账号
               继续显示成「无人管」，用户改了规则也不消失。 */
            synchronized (uncovered) {
                uncovered.clear();
            }

            for (String accName : accs) {
                /* 进度上报：进每个账号前先说一声在加载谁 */
                scanProgress = "正在加载 " + accName + " 的设备列表…";
                Account cfg = null;
                for (Account a : Core.loadAccounts()) if (a.name.equals(accName)) cfg = a;
                if (cfg == null) continue;
                try {
                    String tok = Core.ensureLogin(cfg);
                    List<Core.Dev> devs = Core.getDevicesQuiet(tok, cfg.hasFilter() ? cfg.keywords() : null);
                    devTotal += devs.size();

                    for (Core.Dev d : devs) {
                        rateLimit();
                        String key = accName + "|" + d.no;
                        DevState st = new DevState();
                        st.acc = accName;
                        st.no = d.no;
                        st.name = d.name;
                        try {
                            DevData dd = Core.fetchDeviceDataQuiet(tok, d.no);
                            st.status = judge(dd, staleMinutes);
                            st.ageMin = dd.ageMinutes();
                            st.rows = dd.rows;
                            st.dataTime = newestTime(dd);
                            // 巡检结果落盘，供「历史数据」页读本地记录
                            if (!dd.rows.isEmpty()) {
                                Hist.record(accName, d.no, d.name, dd.rows);
                            }
                        } catch (Exception e) {
                            st.status = "blank";
                            st.dataTime = "--";
                        }
                        st.updatedAt = System.currentTimeMillis();

                        DevState old = null;
                        synchronized (states) {
                            old = states.get(key);
                            st.prevStatus = old == null ? null : old.status;
                            states.put(key, st);
                        }

                        if ("online".equals(st.status)) devOn++;
                        else if ("stale".equals(st.status)) devStale++;
                        else if ("offline".equals(st.status)) devOff++;
                        else devBlank++;

                        // 规则匹配
                        /* 【v0.18】covered 记录这台设备有没有被任一规则命中。
                           循环结束后用它判断「异常但无人管」，
                           写进 uncovered 让前端明确提示，而不是让用户猜。 */
                        boolean covered = false;
                        for (int i = 0; i < rls.length(); i++) {
                            JSONObject r = rls.getJSONObject(i);
                            if (!r.optBoolean("on", true)) continue;
                            String msg = matchRule(r, cfg, d, st);
                            if (msg == null) continue;
                            covered = true;
                            /* 【v0.17 修】原来的去重只看「状态有没有变」：
                                 isNew = prevStatus == null || !prevStatus.equals(status)
                               问题是状态一直不变时（设备常年离线、数据常年陈旧）
                               只有第一次会命中，第二次往后再也不提醒——
                               而用户恰恰最需要「它还没恢复」这个持续提醒。
                               现在改成两条路：
                                 · notify_on_change_only=true  → 状态变了才提醒（老行为）
                                 · false（默认）→ 每次巡检命中都提醒，
                                   但用「同设备同变量 冷却期」防刷屏，
                                   否则 5 分钟一轮会把通知栏淹掉。
                               注意：阈值规则（kind=value）本来就跟 status 无关，
                               老逻辑下它几乎只会触发一次，属于明显的功能缺陷。 */
                            boolean isNew = (st.prevStatus == null)
                                    || !st.prevStatus.equals(st.status);
                            if (onlyChange && !isNew) continue;
                            String varName = r.optString("var", "*");
                            /* 冷却期只压「状态没变的重复」。
                               状态变了（刚恢复又坏、或新故障）必须立刻提醒——
                               上一条同样内容可能就在窗口内，但那是上一次故障的事，
                               不该让这一次漏报，用户会以为监控又失灵了。 */
                            if (!isNew && inCooldown(accName, d.name, varName, msg, cooldownMin)) {
                                continue;
                            }
                            pushAlert(accName, d.name, varName, msg, st.level());
                            newAlerts++;
                            break;   // 一台设备一次巡检只出一条，避免刷屏
                        }

                        // 采集异常单独提示（规则可关）
                        if (flagBlank && "blank".equals(st.status)
                                && (st.prevStatus == null || !"blank".equals(st.prevStatus))) {
                            pushAlert(accName, d.name, "-", "未读取到变量数据", "warn");
                            newAlerts++;
                        }

                        /* 【v0.18】这台设备确实有异常，却一条规则都没命中。
                           记下来，由前端如实告诉用户「这些异常目前没人管」——
                           否则用户看到「离线 1 台」却没收到提醒，
                           只会以为提醒功能坏了。 */
                        if (!covered && !"online".equals(st.status)) {
                            markUncovered(accName, st.status);
                        }
                        done++;
                        /* 进度上报：每查完一台刷新一次，用户能看见在动 */
                        scanProgress = "已巡检 " + done + " / " + devTotal
                                + " 台（在线" + devOn + " 陈旧" + devStale + " 离线" + devOff + "）";
                    }
                } catch (Exception e) {
                    Core.log("[监控] 账号 " + accName + " 巡检失败: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            /* 顶层兜底：哪怕 loadRules / 取账号列表等前置步骤抛异常，
               也比「卡死在巡检中、数据再也不更新」强 ——
               至少把时间记上、把锁放掉（调用方 finally 负责放锁），
               用户下一拍还能看到结果。 */
            endNote = "（异常：" + e.getMessage() + "）";
            Core.log("[监控] 巡检异常: " + e.getMessage());
        } finally {
            /* 无论成功还是异常，lastScan 都更新 —— 否则 UI 的「上次巡检」永远停在旧值，
               看起来就像「过了周期也没重复执行」。 */
            lastScan = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(new Date()) + endNote;
            /* 【v0.31】本轮结果落盘：下次重开 app 时监控页不再是空的。
               放在 lastScan 赋值之后，快照里带的时间才是这一轮的。
               落盘前先清掉已停用/已删除账号的设备，免得它们跟着快照一起
               在下次启动时「复活」。 */
            pruneOutOfScope();
            restored = false;
            saveSnapshot();
            long ms = System.currentTimeMillis() - t0;
            Core.log(String.format(Locale.CHINA,
                    "[监控] 巡检完成：%d 台（在线 %d / 陈旧 %d / 离线 %d / 异常 %d），用时 %ds，新增提醒 %d",
                    devTotal, devOn, devStale, devOff, devBlank, ms / 1000, newAlerts));
            /* 【v0.18】把「有异常但没规则覆盖」写进日志。
               用户反馈「不提示示例账号的站点」时，
               这一行能直接看出是规则没覆盖，而不是提醒链路坏了。 */
            JSONObject unc = uncoveredJson();
            if (unc.length() > 0) {
                StringBuilder sb = new StringBuilder("[监控] 以下账号有异常设备但没有规则覆盖，不会提醒：");
                java.util.Iterator<String> it = unc.keys();
                while (it.hasNext()) {
                    String a = it.next();
                    JSONObject one = unc.optJSONObject(a);
                    if (one == null) continue;
                    sb.append(a).append("(");
                    if (one.optInt("stale", 0) > 0) sb.append("陈旧").append(one.optInt("stale")).append(" ");
                    if (one.optInt("offline", 0) > 0) sb.append("离线").append(one.optInt("offline")).append(" ");
                    if (one.optInt("blank", 0) > 0) sb.append("异常").append(one.optInt("blank")).append(" ");
                    sb.setLength(sb.length() - 1);
                    sb.append(") ");
                }
                Core.log(sb.toString().trim());
            }
        }
    }

    /** 与 DevData.judgeStatus 相同，但阈值可按规则覆盖。 */
    private static String judge(DevData dd, int staleMinutes) {
        if (dd.rows.isEmpty()) return "blank";
        boolean hasVal = false;
        long newest = -1;
        for (String[] r : dd.rows) {
            if (r.length < 5) continue;
            String cur = r[4] == null ? "" : r[4].trim();
            if (cur.matches(".*\\d+(\\.\\d+)?\\s*(℃|kpa|bar).*")) hasVal = true;
            String tm = r[3] == null ? "" : r[3].trim();
            if (!tm.isEmpty() && !tm.equals("-")) {
                try {
                    long t = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA)
                            .parse(tm).getTime();
                    if (t > newest) newest = t;
                } catch (Exception ignored) {
                }
            }
        }
        if (!hasVal || newest < 0) return "offline";
        double ageMin = (System.currentTimeMillis() - newest) / 60000.0;
        return ageMin <= staleMinutes ? "online" : "stale";
    }

    private static String newestTime(DevData dd) {
        String t = "--";
        for (String[] r : dd.rows) {
            if (r.length > 3 && r[3] != null && !r[3].trim().isEmpty()
                    && !r[3].trim().equals("-") && r[3].trim().compareTo(t) > 0) {
                t = r[3].trim();
            }
        }
        return t;
    }

    /**
     * 规则匹配。规则字段：
     *   acc=账号名 dev=设备名 var=变量名（均支持 *）
     *   kind: offline(离线) / stale(数据陈旧) / value(数值越限) / blank(采集异常)
     *   stale_min: 数据停更超过 N 分钟判离线（kind=stale/offline 时用）
     *   op / val / val2: 数值比较（kind=value 时用），
     *     op 取 lt/lte/gt/gte，v0.26 起新增 range（val < 数值 < val2，
     *     两个都取开区间 —— 跟「大于8小于30」的口语语义一致）
     */
    private static String matchRule(JSONObject r, Account cfg, Core.Dev d, DevState st) {
        if (!wmatch(r.optString("acc", "*"), cfg.name)) return null;
        if (!wmatch(r.optString("dev", "*"), d.name == null ? "" : d.name)) return null;

        String kind = r.optString("kind", "offline");
        String varPat = r.optString("var", "*");
        int staleMin = r.optInt("stale_min", Core.STALE_MINUTES);
        String txt = st.statusText();

        if ("offline".equals(kind)) {
            if ("offline".equals(st.status)) {
                return "设备离线" + (st.ageMin >= 0 ? "（最后上报 " + DevData.fmtAge(st.ageMin) + "）" : "");
            }
            return null;
        }
        if ("stale".equals(kind)) {
            if ("stale".equals(st.status) || "offline".equals(st.status)) {
                if (st.ageMin > staleMin) {
                    return "数据停更 " + DevData.fmtAge(st.ageMin) + "，超过 " + staleMin + " 分钟";
                }
            }
            return null;
        }
        if ("blank".equals(kind)) {
            return "blank".equals(st.status) ? "未读取到变量数据" : null;
        }
        if ("value".equals(kind)) {
            double lim = r.optDouble("val", 0);
            String op = r.optString("op", "gt");
            /* 【v0.26】区间上限。旧规则里没有 val2 字段，optDouble 给 0，
               但旧规则 op 不会是 range，所以不影响。 */
            double lim2 = r.optDouble("val2", 0);
            /* 【v0.27】介于：min/max 归一。前端保存时已归一，这里再兜一层 ——
               v0.26 短暂发过一版不归一的，用户要是那期间存了「30, 8」，
               不兜底的话这条规则永远不触发（v>30 && v<8 恒假）。
               顺带回答用户的疑问：语义本来就是「大于小的、小于大的」，
               没有反，只是之前框上没标哪个是哪个，提示语也绕。 */
            if ("range".equals(op) && lim > lim2) {
                double t2 = lim; lim = lim2; lim2 = t2;
            }
            for (String[] row : st.rows) {
                if (row.length < 5) continue;
                String vn = row[1] == null ? "" : row[1];
                if (!wmatch(varPat, vn)) continue;
                Double v = parseNum(row[4]);
                if (v == null) continue;
                boolean hit = false;
                switch (op) {
                    case "lt": hit = v < lim; break;
                    case "lte": hit = v <= lim; break;
                    case "gte": hit = v >= lim; break;
                    case "range": hit = v > lim && v < lim2; break;
                    default: hit = v > lim; break;
                }
                if (hit) {
                    /* range 的提示把两个界限都写出来，别让人猜 */
                    String th = "range".equals(op)
                            ? String.format(Locale.CHINA, ">%s 且 <%s", trimNum(lim), trimNum(lim2))
                            : op + trimNum(lim);
                    return String.format(Locale.CHINA, "%s = %s%s（阈值 %s）",
                            vn, trimNum(v), unitOf(row[4]), th);
                }
            }
        }
        return null;
    }

    private static String trimNum(double v) {
        if (v == Math.floor(v) && !Double.isInfinite(v)) return String.valueOf((long) v);
        return String.format(Locale.CHINA, "%.2f", v);
    }

    private static String unitOf(String cur) {
        if (cur == null) return "";
        java.util.regex.Matcher m =
                java.util.regex.Pattern.compile("^(-?\\d+(?:\\.\\d+)?)\\s*(.*)$").matcher(cur.trim());
        return m.matches() ? m.group(2) : "";
    }

    public static Double parseNum(String cur) {
        if (cur == null) return null;
        java.util.regex.Matcher m =
                java.util.regex.Pattern.compile("^(-?\\d+(?:\\.\\d+)?)").matcher(cur.trim());
        if (!m.find()) return null;
        try {
            return Double.parseDouble(m.group(1));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 冷却期内是否已经提醒过同一件事。
     *
     * 【v0.17 新增】用户反馈「只有第一次巡检有反应」，
     * 根因是去重只看状态是否变化。但改成每次都发又不现实——
     * 5 分钟一轮会把通知栏淹掉，用户反而会关掉通知。
     * 所以用「同设备 + 同变量 + 同内容」在时间窗口内去重：
     * 故障持续存在时会周期性重复提醒（用户能看到它还没好），
     * 但不会刷屏。
     *
     * @param minutes <= 0 表示不去重
     */
    private static boolean inCooldown(String acc, String dev, String var,
                                      String msg, int minutes) {
        if (minutes <= 0) return false;
        long now = System.currentTimeMillis();
        long win = minutes * 60_000L;
        synchronized (alerts) {
            for (int i = 0; i < alerts.size(); i++) {
                Alert a = alerts.get(i);
                if (now - a.time > win) break;   // 列表按时间倒序，越往后越旧
                if (eq(a.acc, acc) && eq(a.dev, dev) && eq(a.varName, var)
                        && eq(a.message, msg)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 累计某个账号下「有异常但无规则覆盖」的设备数。 */
    private static void markUncovered(String acc, String status) {
        synchronized (uncovered) {
            int[] n = uncovered.get(acc);
            if (n == null) {
                n = new int[3];   // [stale, offline, blank]
                uncovered.put(acc, n);
            }
            if ("stale".equals(status)) n[0]++;
            else if ("offline".equals(status)) n[1]++;
            else n[2]++;
        }
    }

    /**
     * 覆盖情况诊断（给 watchState 用）。
     * 结构：{ "示例账号": {"stale": 3, "offline": 1}, ... }
     * 只包含「有异常但没规则覆盖」的账号，全覆盖的账号不出现在里面。
     */
    public static JSONObject uncoveredJson() {
        JSONObject o = new JSONObject();
        try {
            synchronized (uncovered) {
                for (Map.Entry<String, int[]> e : uncovered.entrySet()) {
                    int[] n = e.getValue();
                    JSONObject d = new JSONObject();
                    d.put("stale", n[0]);
                    d.put("offline", n[1]);
                    if (n[2] > 0) d.put("blank", n[2]);
                    o.put(e.getKey(), d);
                }
            }
        } catch (Exception ignored) {
        }
        return o;
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    static synchronized void pushAlert(String acc, String dev, String var,
                                               String msg, String level) {
        Alert a = new Alert();
        a.id = ++alertSeq;
        a.time = System.currentTimeMillis();
        a.acc = acc;
        a.dev = dev;
        a.varName = var;
        a.message = msg;
        a.level = level;
        alerts.add(0, a);
        while (alerts.size() > 200) alerts.remove(alerts.size() - 1);
        Core.log("[告警] " + acc + " / " + dev + "：" + msg);
        /* v0.09：真正发系统通知。
           v0.08 之前这里只往内存列表里塞记录 + log 一行，
           界面上「测试提醒」还弹 toast 说"请看下拉通知栏"，
           但全工程没有一处 NotificationManager 调用，通知栏永远是空的。 */
        try {
            Notifier.alert(Core.appCtx(), acc, dev, msg, level);
        } catch (Throwable t) {
            Core.log("[告警] 通知发送异常：" + t);
        }
    }

    /** 手动把一批提醒标记为已读（fres�� 标记是给「新告警」筛选用的）。 */
    public static void markAlertsRead() {
        synchronized (alerts) {
            for (Alert a : alerts) a.fresh = false;
        }
    }

    public static void clearAlerts() {
        synchronized (alerts) {
            alerts.clear();
        }
        Core.log("[告警] 已清空提醒列表");
    }

    public static JSONArray alertsJson() {
        JSONArray arr = new JSONArray();
        synchronized (alerts) {
            for (Alert a : alerts) arr.put(a.toJson());
        }
        return arr;
    }

    /** 设备列表 JSON：按账号分组。 */
    public static JSONArray statesJson() {
        JSONArray arr = new JSONArray();
        List<DevState> list;
        synchronized (states) {
            list = new ArrayList<>(states.values());
        }
        java.util.Collections.sort(list, (x, y) -> {
            int c = x.acc.compareTo(y.acc);
            return c != 0 ? c : String.valueOf(x.name).compareTo(String.valueOf(y.name));
        });
        for (DevState s : list) {
            try {
                arr.put(stateJson(s));
            } catch (Exception ignored) {
            }
        }
        return arr;
    }

    static JSONArray rowsJson(List<String[]> rows) {
        JSONArray a = new JSONArray();
        for (String[] r : rows) {
            try {
                a.put(new JSONArray()
                        .put(r.length > 1 ? r[1] : "")
                        .put(r.length > 4 ? r[4] : "-")
                        .put(r.length > 3 ? r[3] : "-")
                        /* 【v0.31】第 4 项：可写元信息 rel|rw|op|ident。
                           老快照/老数据没有这一项 → 前端按「不可调」处理，
                           不会因为缺字段误露出「调整」按钮。 */
                        .put(r.length > 5 ? r[5] : ""));
            } catch (Exception ignored) {
            }
        }
        return a;
    }

    /** 统计条数据。 */
    public static JSONObject summary() {
        JSONObject o = new JSONObject();
        try {
            int on = 0, stale = 0, off = 0, blank = 0, crit = 0;
            List<DevState> list;
            synchronized (states) {
                list = new ArrayList<>(states.values());
            }
            for (DevState s : list) {
                if ("online".equals(s.status)) on++;
                else if ("stale".equals(s.status)) stale++;
                else if ("offline".equals(s.status)) off++;
                else blank++;
            }
            synchronized (alerts) {
                for (Alert a : alerts) if ("critical".equals(a.level)) crit++;
            }
            o.put("total", list.size());
            o.put("online", on);
            o.put("stale", stale);
            o.put("offline", off);
            o.put("blank", blank);
            o.put("alerts", alerts.size());
            o.put("critical", crit);
            o.put("last_scan", lastScan == null ? JSONObject.NULL : lastScan);
            o.put("scanning", WatchGuard.scanning.get());
            /* 巡检进度：只有正在扫的时候才有值，扫完由调用方置 null。
               前端据此显示「已巡检 X / Y 台」，让用户看见扫描在动。 */
            o.put("progress", scanProgress == null ? JSONObject.NULL : scanProgress);
            o.put("enabled", enabled);
            o.put("interval", intervalSec);
            /* 【v0.31】这份列表是不是「上次保存的结果」。
               是的话界面要明说 —— 否则用户会把这些旧值当成刚跑出来的实时数据，
               而站点信息看起来又「不刷新」，反而更像坏了。 */
            o.put("restored", restored);
        } catch (Exception ignored) {
        }
        return o;
    }
}
