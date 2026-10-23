package org.usrcloud.xunjian;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 巡站核心：有人云 API 直调 + 状态判定 + 调度。
 * 从桌面版 run_usrcloud.py 移植，接口与判定规则逐条对齐，
 * 保证手机端与电脑端截图观感、数据口径一致。
 */
public class Core {

    // ---------------- 可调参数（与桌面版一致） ----------------
    /* 【v0.26】陈旧判定阈值不再是常量：
       「我的 → 设置」可改（桥 setStaleMin），持久化在 监控规则.json 的
       stale_minutes 字段，Watch.loadRules() 读进来时反向同步到这里 ——
       巡站页的状态判定（DevData.judgeStatus）和监控判定共用这一个值，
       改一处两边同时生效。 */
    public static volatile int STALE_MINUTES = 15;
    public static final int MAX_CARDS = 10;
    public static final String APP_VERSION = "0.37";
    /* 【v0.36 修订五】打包时刻（build.gradle 注入）。
       版本号不动，光看 v0.36 分不清装的是哪一次打包的包，这个问题页面上要能看出来。 */
    public static final String BUILD_STAMP = BuildConfig.BUILD_STAMP;

    /** 并发线程数，可在「我的 → 设置」里改，落盘到 设置.json */
    public static volatile int WORKERS = 4;
    private static volatile boolean cfgLoaded = false;

    /** 读写 设置.json */
    public static File cfgFile() {
        File d = new File(rootDir(), "设置.json");
        return d;
    }

    public static synchronized void loadCfg() {
        if (cfgLoaded) return;
        cfgLoaded = true;
        File f = cfgFile();
        if (!f.exists()) return;
        try {
            JSONObject o = new JSONObject(readFile(f));
            int w = o.optInt("workers", 4);
            WORKERS = Math.max(1, Math.min(12, w));
        } catch (Exception ignored) {
        }
    }

    public static synchronized void saveWorkers(int w) {
        WORKERS = Math.max(1, Math.min(12, w));
        try {
            File f = cfgFile();
            JSONObject o = new JSONObject();
            if (f.exists()) {
                try {
                    o = new JSONObject(readFile(f));
                } catch (Exception ignored) {
                }
            }
            o.put("workers", WORKERS);
            writeFile(f, o.toString());
            log("[设置] 并发线程数 = " + WORKERS);
        } catch (Exception e) {
            log("[设置] 保存失败: " + e.getMessage());
        }
    }

    public static final String LOGIN_URL = "https://apimp.usr.cn/usrCloud/user/login";
    public static final String DEVS_URL = "https://apimp.usr.cn/usrCloud/cusdevice/getCusdevices";
    public static final String INFO_URL = "https://apimp.usr.cn/usrCloud/cusdevice/getCusdeviceInfo";
    public static final String POINTS_URL =
            "https://apimp.usr.cn/usrCloud/cusdevice/getDataPointInfoForCusdeviceNo";
    public static final String LAST_URL = "https://history.usr.cn:7002/history/cusdevice/lastDataPoint";
    /* 【v0.31】命令下发地址。注意必须走 openapi.mp.usr.cn 这个域 ——
       同一路径在 apimp.usr.cn 上是不存在的（实测 404）。
       token 是通用的（apimp 登录拿到的 token 这个接口认）。 */
    public static final String CMD_ADDR_URL =
            "https://openapi.mp.usr.cn/usrCloud/V6/ucloudSdk/getCommandAddress";

    public static final String STATUS_TAG_ONLINE = "✓在线";
    public static final String STATUS_TAG_STALE = "○离线(数据陈旧)";
    public static final String STATUS_TAG_OFFLINE = "○离线(无数据)";
    public static final String STATUS_TAG_BLANK = "⚠采集异常";

    public static String statusTag(String status) {
        if ("online".equals(status)) return STATUS_TAG_ONLINE;
        if ("stale".equals(status)) return STATUS_TAG_STALE;
        if ("offline".equals(status)) return STATUS_TAG_OFFLINE;
        return STATUS_TAG_BLANK;
    }

    // ---------------- 全局状态 ----------------
    public static volatile boolean running = false;
    public static volatile boolean paused = false;
    public static volatile String stage = "";
    public static volatile String error = null;
    public static volatile boolean finished = false;
    public static volatile int doneCount = 0;
    public static volatile int onlineCount = 0;
    public static volatile int totalCount = 0;
    public static volatile String zipName = null;
    public static volatile String batchDir = null;
    /* 【v0.31 修订】本轮巡站的编号。每启动一轮 +1，前端拿着 run 返回的这个值，
       比对 status 回传的 run_id —— 不一致说明拿到的还是上一轮的残留状态。
       为什么需要它：native 起任务（POOL.execute）与前端第一次 pollStatus()
       之间有时间差，这段时间里 status 报的是上一轮的结果，
       前端会把「上一轮的 finished=true」当成「本轮完成了」。 */
    public static volatile long runSeq = 0;
    public static final java.util.Map<String, AccountResult> results =
            new java.util.LinkedHashMap<>();
    public static final java.util.List<LogLine> logs =
            java.util.Collections.synchronizedList(new ArrayList<LogLine>());
    public static final AtomicInteger logSeq = new AtomicInteger(0);
    public static final Object LOCK = new Object();

    private static Context ctx;
    private static final ExecutorService POOL = Executors.newCachedThreadPool();

    public static class LogLine {
        public final int seq;
        public final String line;

        LogLine(int s, String l) {
            this.seq = s;
            this.line = l;
        }
    }

    public static class AccountResult {
        public String name;
        public String dir;
        public String error;
        public boolean skip;
        public final List<ReportItem> report = new ArrayList<>();
    }

    public static class ReportItem {
        public String device;
        public String status;
        public String preview;
        public String path;      // 私有目录里的文件
        public String pubPath;   // 对外目录里的文件（用户能看到、能分享的那个）
    }

    public static void init(Context c) {
        ctx = c.getApplicationContext();
        loadCfg();
        /* 【v0.36 修订五】升级前留下的私有批次要清掉。
           修订四之后新跑的轮次不留内部副本了，但以前留下的老批次还在，
           用户在文件管理器里翻到 /data/…/files/巡站截图 会以为「还在往这写」。
           只清「对外已经有同一批且那批里真有文件」的，其余一律不动。
           放后台线程：启动时不能因为扫目录把首屏卡住。 */
        new Thread(new Runnable() {
            public void run() {
                try {
                    int n = BatchClean.cleanMirrored(batchesDir(),
                            new File(ShotStore.displayPath()));
                    if (n > 0) Log.i("patrol", "[清理] 升级前留下的私有批次已清 " + n + " 个");
                } catch (Exception e) {
                    Log.w("patrol", "清理旧私有批次失败: " + e);
                }
            }
        }, "clean-old-batches").start();
    }

    public static void log(String msg) {
        String line = "[" + new SimpleDateFormat("HH:mm:ss", Locale.CHINA)
                .format(new Date()) + "] " + msg;
        Log.i("patrol", line);
        synchronized (logs) {
            logs.add(new LogLine(logSeq.incrementAndGet(), line));
            while (logs.size() > 400) logs.remove(0);
        }
    }

    public static File rootDir() {
        return ctx.getFilesDir();
    }

    /** 应用上下文，ShotStore 写 MediaStore 时要用。 */
    public static Context appCtx() {
        return ctx;
    }

    public static File cacheDir() {
        File d = new File(rootDir(), "登录缓存");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /**
     * 截图工作目录：应用私有目录。
     * 私有目录读写最稳（不用任何权限），zip 导出、清理往期、历史统计都基于它；
     * 再由 ShotStore 复制一份到用户能看到的位置。
     */
    public static File batchesDir() {
        File d = new File(rootDir(), "巡站截图");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    public static File newBatchDir() {
        String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.CHINA).format(new Date());
        File d = new File(batchesDir(), stamp + "_截图");
        d.mkdirs();
        return d;
    }

    public static String safeName(String name) {
        return name == null ? "unnamed" : name.replaceAll("[？（）)():：\\s]+", "");
    }

    // ---------------- HTTP / JSON ----------------

    private static JSONObject apiJson(String url, JSONObject payload, String tok, int timeout)
            throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(timeout * 1000);
        c.setReadTimeout(timeout * 1000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        if (tok != null) {
            c.setRequestProperty("token", tok);
            c.setRequestProperty("X-Access-Token", tok);
        }
        c.getOutputStream().write(payload.toString().getBytes("UTF-8"));
        InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
        String body = readAll(in);
        c.disconnect();
        return new JSONObject(body);
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        /* 【v0.33 修复】原来每行只 append(line)、**不补换行符**，
           于是整个文件被拼成一大坨无换行的字符串。
           读 JSON 的调用点无所谓（JSON 里本来就没换行），
           但 accountsRaw()（账号表格原文）直接把这一坨塞进 textarea，
           用户看到的就是「所有账号都在一行」——
           而且保存时按行校验会认为只有 1 行、字段数对不上，直接把表拒掉。
           现在行间补 \r\n：JSON 解析不受影响（org.json 允许空白），
           CSV 原文恢复成真正的一行一个账号。 */
        while ((line = r.readLine()) != null) sb.append(line).append("\r\n");
        r.close();
        return sb.toString();
    }

    public static String md5(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ---------------- 账号管理（accounts.csv，与桌面版同格式） ----------------

    private static final String[] FIELDS =
            {"名称", "账号", "密码", "平台ID", "启用", "站点过滤"};

    private static File accountsFile() {
        return new File(rootDir(), "accounts.csv");
    }

    /**
     * 清洗站点过滤字符串。【v0.20 新增】
     *
     * 【为什么必须有这个函数】用户反馈「新建账号时站点过滤里会冒出 []，
     * 而且删不掉」。根因有两层，缺一不可：
     *
     * 1) 前端传的是 JSON 数组（["a","b"]），Java 侧用 optString("station_kw") 取值。
     *    org.json 对 JSONArray 取不到字符串时会把值原样 toString 返回，
     *    于是 "[]" 就这么原封不动写进了 CSV。
     * 2) 下次读取时，"[]" 作为一个普通字符串进了 stationKw，
     *    匹配设备名永远匹配不上（和 ["3号"] 一模一样的坑）。
     *
     * 所以清洗放在两个地方：
     *   - saveAccounts 落盘前（不让脏值写进去）
     *   - loadAccounts 读出后（把历史脏数据也一起治好）
     *
     * 规则：剥掉外层成对的 [ ] { } 和所有引号，
     * 再按分隔符切成关键词、去掉空项、用分隔符重新拼回去。
     * 纯符号输入（用户只打了 []）直接归一成空串 = 不过滤。
     */
    public static String cleanStationKw(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        // 剥掉所有引号（中文英文单双引号都要）
        s = s.replace("\"", "").replace("'", "")
             .replace("\u201c", "").replace("\u201d", "")
             .replace("\u2018", "").replace("\u2019", "");
        // 剥掉方括号、花括号、圆括号（不管成不成对，用户手抖打半个也照样能治）
        s = s.replace("[", "").replace("]", "")
             .replace("{", "").replace("}", "")
             .replace("(", "").replace(")", "");
        // 按分隔符切、去空项、重新拼
        String[] parts = s.split("[、，,;；\\s]+");
        List<String> keep = new ArrayList<String>();
        for (String p : parts) {
            String t = p.trim();
            if (!t.isEmpty()) keep.add(t);
        }
        if (keep.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < keep.size(); i++) {
            if (i > 0) sb.append("、");
            sb.append(keep.get(i));
        }
        return sb.toString();
    }

    /**
     * 首次启动时把 assets/accounts.csv 复制到私有目录。
     * 只在文件不存在时执行一次；用户之后在 app 里改的账号不会被覆盖。
     */
    private static synchronized void seedAccountsIfAbsent() {
        File dst = accountsFile();
        if (dst.exists()) return;
        try {
            InputStream in = ctx.getAssets().open("accounts.csv");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            byte[] data = bos.toByteArray();
            FileOutputStream fo = new FileOutputStream(dst);
            fo.write(data);
            fo.flush();
            fo.close();
            String s = new String(data, java.nio.charset.Charset.forName("UTF-8"));
            int cnt = 0;
            for (String line : s.split("\n")) {
                if (line.trim().isEmpty() || line.trim().startsWith("#")) continue;
                cnt++;
            }
            log("[账号] 首次启动，已载入预置账号 " + Math.max(0, cnt - 1) + " 个");
        } catch (Exception e) {
            Log.w("patrol", "预置账号载入失败: " + e);
        }
    }

    /**
     * 强制把 assets 里的预置账号表覆盖到手机。【v0.20 新增】
     *
     * 【为什么必须有这个】seedAccountsIfAbsent 只在文件不存在时复制，
     * 而覆盖安装不会删掉应用私有目录 —— 用户从 v0.18 升上来时，
     * 手机里那份含线路丙、共 4 个账号的 accounts.csv 原封不动还在。
     * 于是「我明明删了线路丙，怎么某线路还在」——
     * 用户看的是手机里的旧文件，不是新包里那份。
     *
     * 所以必须给一个用户主动可调的入口：清掉当前表，重新铺预置表。
     * 返回铺进去的账号列表。
     */
    public static List<Account> resetToPreset() throws Exception {
        File dst = accountsFile();
        if (dst.exists() && !dst.delete()) {
            throw new Exception("旧账号表删不掉，可能被其他程序占用");
        }
        seedAccountsIfAbsent();
        List<Account> rows = loadAccounts();
        log("[账号] 已恢复出厂预置，共 " + rows.size() + " 个");
        return rows;
    }

    /**
     * 包里 assets/accounts.csv 自带几个账号（不含表头）。【v0.27 增补】
     *
     * 【为什么要从包里读，而不是前端写死】
     * 界面上「恢复出厂预置账号」按钮要告诉用户会重置成几个，
     * 这个数字以前写死在 JS 里是 3。一旦出一个「不带预置账号」的版本
     * （预置表只有表头），按钮还会说「重置成 3 个」—— 就是在骗人。
     * 现在由包自己报数，代码一份，带预置和不带预置两种包都对。
     */
    public static int presetAccountCount() {
        try {
            InputStream in = ctx.getAssets().open("accounts.csv");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            String s = new String(bos.toByteArray(), Charset.forName("UTF-8"))
                    .replace("\ufeff", "");
            int cnt = 0;
            for (String line : s.split("\n")) {
                String t = line.trim();
                if (t.isEmpty() || t.startsWith("#")) continue;
                cnt++;
            }
            return Math.max(0, cnt - 1);   // 减掉表头
        } catch (Exception e) {
            return 0;
        }
    }

    /** 当前私有目录里那份账号表是不是已经比预置的旧（用于界面提示）。 */
    /** 当前私有目录里那份账号表是不是已经比预置的旧（用于界面提示）。
     *  本包不带任何预置账号（assets/accounts.csv 只有表头），
     *  所有账号都由用户自己添加，不存在「预置表里已删除、手机上还留着」的情况，
     *  因此恒为 false。 */
    /** 当前私有目录里那份账号表是不是已经比预置的旧（用于界面提示）。
     *  本包不带任何预置账号（assets/accounts.csv 只有表头），
     *  所有账号都由用户自己添加，不存在「预置表里已删除、手机上还留着」的情况，
     *  因此恒为 false。 */
    public static boolean accountsLooksStale() {
        return false;
    }

    private static String readTextQuiet(File f) {
        try {
            byte[] b = readAllBytes(f);
            return new String(b, Charset.forName("UTF-8"));
        } catch (Exception e) {
            return "";
        }
    }

    /** 读整个文件为字节数组。供 Watch 恢复监控开关等场景复用。 */
    public static byte[] readAllBytesOf(File f) throws Exception {
        return readAllBytes(f);
    }

    private static byte[] readAllBytes(File f) throws Exception {
        InputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(
                    (int) Math.max(8192L, f.length()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } finally {
            try { in.close(); } catch (Exception ignore) { }
        }
    }

    private static String[] splitCsvLine(String line) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean q = false;
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (ch == '"') {
                q = !q;
            } else if (ch == ',' && !q) {
                out.add(cur.toString());
                cur.setLength(0);
            } else {
                cur.append(ch);
            }
        }
        out.add(cur.toString());
        return out.toArray(new String[0]);
    }

    /** 读 accounts.csv（UTF-8 BOM 容忍）。 */
    public static List<Account> loadAccounts() {
        List<Account> out = new ArrayList<>();
        File f = accountsFile();
        if (!f.exists()) {
            /* 首次启动：把 assets 里预置的账号表播种到私有目录，
               免得装完 app 还得手动一个个敲账号 */
            seedAccountsIfAbsent();
        }
        if (!f.exists()) return out;
        try {
            BufferedReader r = new BufferedReader(
                    new InputStreamReader(new FileInputStream(f), "UTF-8"));
            String header = r.readLine();
            if (header != null && header.startsWith("﻿")) header = header.substring(1);
            String line;
            while ((line = r.readLine()) != null) {
                if (line.trim().isEmpty() || line.trim().startsWith("#")) continue;
                String[] c = splitCsvLine(line);
                if (c.length < 2) continue;
                Account a = new Account();
                a.name = c[0].trim();
                a.account = c[1].trim();
                if (a.name.isEmpty() || a.name.startsWith("#")
                        || a.account.isEmpty() || a.account.startsWith("#")) continue;
                a.password = c.length > 2 ? c[2].trim() : "";
                a.platformId = (c.length > 3 && !c[3].trim().isEmpty()) ? c[3].trim() : "W3rfV";
                String en = c.length > 4 ? c[4].trim().toLowerCase(Locale.CHINA) : "是";
                a.enabled = !(en.equals("否") || en.equals("n") || en.equals("no")
                        || en.equals("0") || en.equals("false") || en.isEmpty());
                /* v0.20：读出来就洗干净，历史遗留的 "[]" / "[\"3号\"]" 一并治好 */
                a.stationKw = cleanStationKw(c.length > 5 ? c[5] : "");
                out.add(a);
            }
            r.close();
        } catch (Exception e) {
            log("账号表格读取失败: " + e);
        }
        return out;
    }

    public static void saveAccounts(List<Account> rows) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append(String.join(",", FIELDS)).append("\r\n");
        for (Account a : rows) {
            sb.append(q(a.name)).append(',').append(q(a.account)).append(',')
              .append(q(a.password)).append(',').append(q(a.platformId)).append(',')
              .append(a.enabled ? "是" : "否").append(',')
              .append(q(cleanStationKw(a.stationKw))).append("\r\n");
        }
        OutputStreamWriter w = new OutputStreamWriter(
                new FileOutputStream(accountsFile()), "UTF-8");
        w.write("﻿");
        w.write(sb.toString());
        w.flush();
        w.close();
    }

    private static String q(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"") || s.contains("\n")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }

    // ---------------- 变量排序 / 置顶（varsort.csv，v0.35） ----------------

    private static File varOrderFile() {
        return new File(rootDir(), "varsort.csv");
    }

    /**
     * 置顶关键词的进程内缓存。
     *
     * <p>为什么要有缓存：这个列表在**渲染每一台设备的每一张截图**时都要读
     * （{@link Renderer} 调一次 {@link ShotOrder#arrange}），
     * 46 个站点一轮下来是几百次；而且 {@code Watch.rowsJson} 每台设备
     * 也要读一次。每次都开文件既慢又容易撞上正在写的文件。
     * 保存后把它置 null 让它下次重读，比直接改缓存更不容易漏。
     */
    private static List<String> varCache = null;

    /**
     * 当前生效的置顶关键词（行序 = 优先级，返回只读视图）。
     *
     * <p>文件还不存在就是空表 —— 空表意味着**全部走默认档**
     * （出水/供水 → 进水/回水 → 其它水温 → 其它温度 → 其余），
     * 所以新装的 app 不用配任何东西，行为就和 v0.35 的默认规则一致。
     */
    public static synchronized List<String> varOrderPinned() {
        if (varCache == null) {
            List<String> l;
            try {
                l = VarOrder.parse(varOrderRaw());
            } catch (Exception e) {
                l = new ArrayList<>();
            }
            varCache = l;
        }
        return java.util.Collections.unmodifiableList(varCache);
    }

    /** 变量排序表原文（没建过文件时返回「只有表头」的空白表，而不是空串）。 */
    public static String varOrderRaw() {
        File f = varOrderFile();
        if (!f.exists()) return VarOrder.toText(new ArrayList<String>());
        try {
            return readFile(f);
        } catch (Exception e) {
            return "";
        }
    }

    public static String varOrderPathHint() {
        return varOrderFile().getAbsolutePath();
    }

    /** 按列表落盘（界面上「新增 / 上移 / 下移 / 删除」走的都是这条路）。 */
    public static void saveVarOrder(List<String> items) throws Exception {
        OutputStreamWriter w = new OutputStreamWriter(
                new FileOutputStream(varOrderFile()), "UTF-8");
        w.write(VarOrder.toText(items));
        w.flush();
        w.close();
        varCache = null;
    }

    /**
     * 保存原文（用户直接改 CSV 的路子）。
     *
     * <p>校验不过就**一个字都不写**：这份表一旦被写坏，
     * 三处顺序会一起乱，而且用户看不出是这张表的问题。
     *
     * @return 空串 = 已保存；否则是拒绝的原因
     */
    public static String saveVarOrderRaw(String text) {
        String err = VarOrder.validate(text);
        if (!err.isEmpty()) return err;
        try {
            List<String> items = VarOrder.parse(text);
            saveVarOrder(items);
            return "";
        } catch (Exception e) {
            return "写入失败: " + e;
        }
    }

    // ---------------- 站名置顶（sitesort.csv，v0.36） ----------------
    /* 与上面变量排序同一套写法：一个小文件 + 进程内缓存 + 保存后失效。
       分开两份文件而不是塞进一张表：两类关键词的匹配对象完全不同
       （变量名 vs 设备名），混在一起会出现「站名关键词把某个变量也顶上去」。 */

    private static File devOrderFile() {
        return new File(rootDir(), "sitesort.csv");
    }

    private static List<String> devCache = null;

    /** 当前生效的置顶站名关键词（行序 = 优先级，返回只读视图）。 */
    public static synchronized List<String> devOrderPinned() {
        if (devCache == null) {
            List<String> l;
            try {
                l = DevOrder.parse(devOrderRaw());
            } catch (Exception e) {
                l = new ArrayList<>();
            }
            devCache = l;
        }
        return java.util.Collections.unmodifiableList(devCache);
    }

    public static String devOrderRaw() {
        File f = devOrderFile();
        if (!f.exists()) return DevOrder.toText(new ArrayList<String>());
        try {
            return readFile(f);
        } catch (Exception e) {
            return "";
        }
    }

    public static String devOrderPathHint() {
        return devOrderFile().getAbsolutePath();
    }

    public static void saveDevOrder(List<String> items) throws Exception {
        OutputStreamWriter w = new OutputStreamWriter(
                new FileOutputStream(devOrderFile()), "UTF-8");
        w.write(DevOrder.toText(items));
        w.flush();
        w.close();
        devCache = null;
    }

    /** @return 空串 = 已保存；否则是拒绝的原因（原表一个字不动） */
    public static String saveDevOrderRaw(String text) {
        String err = DevOrder.validate(text);
        if (!err.isEmpty()) return err;
        try {
            saveDevOrder(DevOrder.parse(text));
            return "";
        } catch (Exception e) {
            return "写入失败: " + e;
        }
    }

    // ---------------- 账号表格原文编辑（v0.19） ----------------

    /**
     * 读账号表格原文（含表头），供界面直接编辑。
     *
     * 【为什么要有这个】用户反馈「预置的主账号和手动添加的账号，
     * 编辑界面看起来不一样」，怀疑细微差别导致登录问题。
     * 实际查下来是他自己把站点过滤填成了 `["3号"]` 这种带方括号的串，
     * 会被当关键词去匹配设备名，永远匹配不上 ——
     * 于是 12 台设备全被过滤掉，看起来就像「登不上」。
     *
     * 但这类问题很难靠「逐个字段的表单」排查：
     * 表单把一切都规整化了，看不见底层到底存了什么。
     * 所以这里直接把原始 CSV 文本摊开给用户看和改。
     */
    public static String accountsRaw() {
        File f = accountsFile();
        if (!f.exists()) seedAccountsIfAbsent();
        if (!f.exists()) return "";
        try {
            return readFile(f);
        } catch (Exception e) {
            return "";
        }
    }

    /** 账号表实际位置，界面上显示出来，方便用户用电脑找。 */
    public static String accountsPathHint() {
        return accountsFile().getAbsolutePath();
    }

    /**
     * 校验并保存账号表格原文。
     *
     * 【为什么必须校验】这是让用户直接编辑原始文本，
     * 手滑打错一个引号、漏一个逗号，整个账号表就会读不出来，
     * 结果是所有账号都用不了 —— 比不给编辑功能更糟。
     * 所以先在内存里解析一遍：表头要对、每行字段数要对、
     * 名称和账号不能空、同一账号不能重复。任一不满足就拒绝并说明原因，
     * **原文件一个字都不动**。
     */
    public static String saveAccountsRaw(String text) {
        if (text == null) return "内容为空";
        String t = text.replace("\r\n", "\n").replace('\r', '\n');
        // 去掉可能的 BOM 与首尾空行，但保留中间的空行（保存时再过滤）
        if (t.startsWith("﻿")) t = t.substring(1);
        t = t.trim();
        if (t.isEmpty()) return "内容为空";

        String[] lines = t.split("\n");
        // 表头校验：允许用户改列名顺序以外的空格，但六列名必须在
        if (lines.length < 1) return "内容为空";
        String[] head = splitCsvLine(lines[0]);
        if (head.length < 2) return "表头格式不对，至少要有「名称,账号」两列";
        StringBuilder missing = new StringBuilder();
        for (String f : FIELDS) {
            boolean hit = false;
            for (String h : head) if (h.trim().equals(f)) { hit = true; break; }
            if (!hit) missing.append(f).append(' ');
        }
        if (missing.length() > 0) {
            return "表头缺少列：" + missing.toString().trim();
        }

        int rows = 0;
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i];
            if (line.trim().isEmpty() || line.trim().startsWith("#")) continue;
            String[] c = splitCsvLine(line);
            if (c.length < 2) {
                return "第 " + (i + 1) + " 行只有 " + c.length + " 列，至少要有名称和账号两列：" + line;
            }
            String nm = c[0].trim();
            String ac = c[1].trim();
            if (nm.isEmpty() || ac.isEmpty()) {
                return "第 " + (i + 1) + " 行的名称或账号是空的：" + line;
            }
            if (!seen.add(nm)) {
                return "第 " + (i + 1) + " 行名称重复：" + nm;
            }
            rows++;
        }
        if (rows == 0) return "一个账号都没有，至少保留一行";

        try {
            StringBuilder sb = new StringBuilder("﻿");
            for (String line : lines) {
                if (line.trim().isEmpty() || line.trim().startsWith("#")) continue;
                sb.append(line.trim()).append("\r\n");
            }
            writeFile(accountsFile(), sb.toString());
            log("[账号] 表格原文已保存，共 " + rows + " 个账号");
            return "";
        } catch (Exception e) {
            return "保存失败：" + e.getMessage();
        }
    }

    // ---------------- 登录 / 设备 / 数据 ----------------

    private static File tokenFile(Account a) {
        return new File(cacheDir(),
                "app_login_" + safeName(a.name + "_" + a.account) + ".json");
    }

    /** token 有效期约 2h，1.5h 内缓存直接复用。 */
    public static synchronized String ensureLogin(Account a) throws Exception {
        File tf = tokenFile(a);
        if (tf.exists()) {
            try {
                JSONObject d = new JSONObject(readFile(tf));
                String ts = d.optString("_saved_at", "");
                if (!ts.isEmpty()) {
                    long at = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.CHINA)
                            .parse(ts).getTime();
                    if (System.currentTimeMillis() - at < 90 * 60 * 1000L) {
                        return d.getJSONObject("data").getString("token");
                    }
                }
            } catch (Exception ignored) {
            }
        }
        JSONObject p = new JSONObject();
        p.put("account", a.account);
        p.put("password", md5(a.password));
        JSONObject r = apiJson(LOGIN_URL, p, null, 30);
        if (r.optInt("status", -1) != 0) {
            throw new RuntimeException("登录失败: " + r.optString("msg", r.toString()));
        }
        r.put("_saved_at", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.CHINA)
                .format(new Date()));
        r.put("_account", a.account);
        r.put("_name", a.name);
        writeFile(tf, r.toString());
        log("[登录] " + a.name + " 成功 uid=" + r.getJSONObject("data").optString("uid"));
        return r.getJSONObject("data").getString("token");
    }

    public static class Dev {
        public String no;
        public String name;
    }

    public static List<Dev> getDevices(String tok) throws Exception {
        JSONObject p = new JSONObject();
        p.put("pageNum", 1);
        p.put("pageSize", 200);
        JSONObject r = apiJson(DEVS_URL, p, tok, 30);
        if (r.optInt("status", -1) != 0) {
            throw new RuntimeException("设备列表失败: " + r.optString("msg", r.toString()));
        }
        JSONArray lst = r.getJSONObject("data").getJSONArray("cusdeviceResponseDTO");
        List<Dev> out = new ArrayList<>();
        for (int i = 0; i < lst.length(); i++) {
            JSONObject d = lst.getJSONObject(i);
            Dev v = new Dev();
            v.no = d.optString("cusdeviceNo");
            v.name = d.optString("cusdeviceName");
            out.add(v);
        }
        log("拉取到 " + out.size() + " 台设备");
        return out;
    }

    /** 三步直调：元信息 / 变量点定义 / 最新值（约 0.3s/台）。 */
    public static DevData fetchDeviceData(String tok, String devNo) throws Exception {
        DevData dd = new DevData();

        JSONObject p1 = new JSONObject();
        p1.put("cusdeviceNo", devNo);
        JSONObject info = apiJson(INFO_URL, p1, tok, 30).optJSONObject("data");
        if (info != null) {
            dd.org = nz(info.optString("projectName"));
            dd.tpl = nz(info.optString("templateName"));
            dd.gw = nz(info.optString("deviceName"));
            dd.addr = nz(info.optString("address"));
            dd.platformOnline = info.optString("onlineOffline");
        }

        JSONObject p2 = new JSONObject();
        p2.put("dataPointType", "");
        p2.put("dataPointName", "");
        p2.put("dataPointIdList", new JSONArray());
        p2.put("slaveId", "");
        p2.put("cusdeviceNo", devNo);
        p2.put("getOperable", 0);
        p2.put("getTimestampDatas", 1);
        p2.put("getLocationDatas", 1);
        p2.put("getStringDatas", 0);
        p2.put("getBitDatas", 0);
        p2.put("pageNo", 1);
        p2.put("pageSize", 500);
        JSONObject pts = apiJson(POINTS_URL, p2, tok, 30);
        JSONArray plst = new JSONArray();
        JSONObject pd = pts.optJSONObject("data");
        if (pd != null) plst = pd.optJSONArray("cusdeviceDataPointList");
        if (plst == null) plst = new JSONArray();

        // 第三步：按 dataPointRelId 批量取最新值
        java.util.Map<String, JSONObject> lastByRel = new java.util.HashMap<>();
        if (plst.length() > 0) {
            JSONArray dps = new JSONArray();
            for (int i = 0; i < plst.length(); i++) {
                JSONObject pt = plst.getJSONObject(i);
                if (pt.isNull("dataPointRelId")) continue;
                JSONObject o = new JSONObject();
                o.put("cusdeviceNo", devNo);
                o.put("dataPointId", pt.get("dataPointRelId"));
                dps.put(o);
            }
            if (dps.length() > 0) {
                JSONObject p3 = new JSONObject();
                p3.put("dataPoints", dps);
                JSONObject last = apiJson(LAST_URL, p3, tok, 30);
                JSONObject ld = last.optJSONObject("data");
                JSONArray ll = ld == null ? null : ld.optJSONArray("list");
                if (ll != null) {
                    for (int i = 0; i < ll.length(); i++) {
                        JSONObject o = ll.getJSONObject(i);
                        lastByRel.put(String.valueOf(o.opt("dataPointId")), o);
                    }
                }
            }
        }

        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);
        for (int i = 0; i < plst.length(); i++) {
            JSONObject pt = plst.getJSONObject(i);
            String unit = pt.optString("unit", "").trim();
            String tm = "-";
            String cur = "-";
            Object relKey = pt.opt("dataPointRelId");
            JSONObject r = relKey == null ? null
                    : lastByRel.get(String.valueOf(relKey));
            if (r != null) {
                long ts = r.optLong("time", 0);
                if (ts > 0) tm = sdf.format(new Date(ts));
                Object v = r.opt("value");
                String val = v == null || v == JSONObject.NULL ? "" : String.valueOf(v).trim();
                if (!val.isEmpty() && !val.equals("-")) {
                    cur = unit.isEmpty() ? val : (val + " " + unit).trim();
                }
            }
            dd.rows.add(new String[]{
                    String.valueOf(pt.opt("dataPointId")), pt.optString("name"),
                    "", tm, cur,
                    /* 【v0.31】第 6 列（桌面版留的「操作」列）现在承载可写元信息：
                       relId|readWrite|permissionOp|dataIdentifier。
                       前端据此决定给不给「调整」按钮，Watch.setVar 据此拿下发用的 id。

                       为什么必须带上：下发请求体的 dataPointId 要用 dataPointRelId，
                       而 dataPointId 是模板级的另一个 id（实测 10641629 vs 42643797），
                       两者混用不会报错、只会静默写到别的地方 —— 一列字符串挡住这个坑。

                       可写判定 = readWrite==1（变量本身可写）且 permissionOp==1（当前账号有操作权限）。
                       实测：线路乙账号 permissionOp 全 0 → 整账号不可调；
                       线路甲账号有 102 个变量 permissionOp=1 → 可调。 */
                    pt.optLong("dataPointRelId", 0) + "|"
                            + pt.optInt("readWrite", 0) + "|"
                            + pt.optInt("permissionOp", 0) + "|"
                            + pt.optString("dataIdentifier", "")});
        }
        return dd;
    }

    /** 给 MainActivity 的历史查询用（apiJson 本身是 private 的）。 */
    public static JSONObject apiPublic(String url, JSONObject payload, String tok) throws Exception {
        return apiJson(url, payload, tok, 30);
    }

    // ---------------- 命令下发（v0.31） ----------------

    /* 命令下发地址缓存。平台对这个接口有频率限制（官方明确要求缓存，建议 2 小时），
       而它返回的地址基本不变，所以进程内缓存 100 分钟，别每次都去问。 */
    private static volatile String cmdAddr = null;
    private static volatile long cmdAddrAt = 0L;

    /** 取命令下发基址（带缓存）。 */
    public static synchronized String commandAddress(String tok) throws Exception {
        long now = System.currentTimeMillis();
        if (cmdAddr != null && now - cmdAddrAt < 100 * 60 * 1000L) return cmdAddr;
        JSONObject r = apiJson(CMD_ADDR_URL, new JSONObject(), tok, 30);
        if (r.optInt("status", -1) != 0) {
            throw new RuntimeException("取命令下发地址失败: "
                    + r.optString("info", r.toString()));
        }
        String a = r.optJSONObject("data") == null ? ""
                : r.optJSONObject("data").optString("commandServerAddr", "");
        if (a == null || a.trim().isEmpty()) throw new RuntimeException("平台没返回命令下发地址");
        cmdAddr = a.trim();
        cmdAddrAt = now;
        log("[下发] 命令下发地址: " + cmdAddr);
        return cmdAddr;
    }

    /**
     * 下发一个变量的值到设备。
     *
     * <p>返回 {ok, accepted, http, msg, url, body}：
     * <ul>
     *   <li>{@code accepted=true} 只表示**平台收下了指令**，不代表设备已经改了 ——
     *       实测连不存在的变量 id 也返回 success。所以界面上说「已下发」，
     *       是否真的变了要等设备回传后重新读一次。</li>
     *   <li>不抛异常（网络/解析失败也包在返回里），让界面能如实显示原因。</li>
     * </ul>
     */
    public static JSONObject setDataPoint(String tok, String devNo, long relId, String value) {
        JSONObject out = new JSONObject();
        String url = "";
        try {
            url = commandAddress(tok) + "/v2.0/dataPoint/" + devNo;
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(30000);
            c.setReadTimeout(30000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("token", tok);
            c.setRequestProperty("X-Access-Token", tok);
            c.getOutputStream().write(
                    Cmd.buildBody(relId, value).getBytes("UTF-8"));
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = readAll(in);
            c.disconnect();

            boolean accepted = Cmd.isAccepted(code, body);
            out.put("ok", accepted);
            out.put("accepted", accepted);
            out.put("http", code);
            out.put("url", url);
            out.put("body", body == null ? "" : body);
            if (!accepted) out.put("msg", Cmd.reason(code, body));
            log("[下发] " + devNo + " 变量id=" + relId + " 值=" + value
                    + " 请求体=" + Cmd.buildBody(relId, value)
                    + " → HTTP " + code + " " + body
                    + (accepted ? "（平台已受理）" : "（失败）"));
        } catch (Exception e) {
            try {
                out.put("ok", false);
                out.put("accepted", false);
                out.put("http", -1);
                out.put("url", url);
                out.put("msg", "下发失败：" + e.getMessage());
            } catch (Exception ignored) {
            }
            log("[下发] " + devNo + " 变量id=" + relId + " 异常: " + e);
        }
        return out;
    }

    private static String nz(String s) {
        return (s == null || s.trim().isEmpty()) ? "--" : s;
    }

    /**
     * 静默取设备列表：监控每轮都要调，getDevices 的日志会刷屏。
     * 传 kws 非空时按关键词过滤（不打印未命中警告）。
     */
    public static List<Dev> getDevicesQuiet(String tok, String[] kws) throws Exception {
        JSONObject p = new JSONObject();
        p.put("pageNum", 1);
        p.put("pageSize", 200);
        JSONObject r = apiJson(DEVS_URL, p, tok, 30);
        if (r.optInt("status", -1) != 0) {
            throw new RuntimeException("设备列表失败: " + r.optString("msg", r.toString()));
        }
        JSONArray lst = r.getJSONObject("data").getJSONArray("cusdeviceResponseDTO");
        List<Dev> out = new ArrayList<>();
        for (int i = 0; i < lst.length(); i++) {
            JSONObject d = lst.getJSONObject(i);
            String name = d.optString("cusdeviceName");
            if (kws != null && kws.length > 0) {
                boolean hit = false;
                for (String k : kws) if (name != null && name.contains(k)) {
                    hit = true;
                    break;
                }
                if (!hit) continue;
            }
            Dev v = new Dev();
            v.no = d.optString("cusdeviceNo");
            v.name = name;
            out.add(v);
        }
        return out;
    }

    /** 静默取设备数据：监控轮询用，不打日志。 */
    public static DevData fetchDeviceDataQuiet(String tok, String devNo) throws Exception {
        return fetchDeviceData(tok, devNo);
    }

    static String readFile(File f) throws Exception {
        return readAll(new FileInputStream(f));
    }

    static void writeFile(File f, String s) throws Exception {
        OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(f), "UTF-8");
        w.write(s);
        w.flush();
        w.close();
    }

    // ---------------- 巡站调度 ----------------

    public static void startPatrol(List<String> pickedNames) {
        if (running) {
            log("已有任务在运行，忽略本次启动");
            return;
        }
        /* 【v0.31 修订】状态重置必须在这里**同步**做完，不能等 worker 线程。
           原来 running/finished/onlineCount 这些都是在 runPatrol() 里才重置的，
           而 runPatrol 是 POOL.execute 丢出去的 —— 桥线程把 run 的返回值交给前端之后，
           worker 可能还没被调度（光开头的 loadAccounts() 读盘解析就要一段时间）。
           这段时间里 status 报的还是上一轮：running=false、finished=true、
           onlineCount=上一轮的数字。前端 pollStatus() 的第一拍正是这时候打的，
           于是「刚点开始」立刻判定完成 → 弹「巡站完成，在线 34 台」（上一轮的数字）、
           停止轮询，而真正跑起来的这轮再没人看进度；用户以为没反应，再点一次，
           native 那边 running 已经 true → 弹「已有任务在运行」这种错误信息。

           现在把重置提到这里同步执行，并在下面同步 +1 runSeq：
           run 一返回，前端读到的就是本轮（running=true / finished=false），
           同时 run_id 也已经是本轮的，任何残留状态都认得出来。 */
        resetRunState();
        long myRun = ++runSeq;
        POOL.execute(() -> runPatrol(pickedNames, myRun));
    }

    /** 新一轮开始的同步重置。桥线程调用，所以前端第一拍就能看到 running=true。
        写顺序有讲究：先铺好各字段，最后才置 running=true ——
        前端一旦看到 running=true，之前的所有写都已可见（volatile 写前的写全可见），
        不会读到「已经说在跑了、数字却还是上一轮的」半初始化状态。 */
    private static void resetRunState() {
        paused = false;
        error = null;
        doneCount = 0;
        onlineCount = 0;
        totalCount = 0;
        zipName = null;
        stage = "正在准备…";
        finished = false;
        synchronized (LOCK) {
            results.clear();
        }
        running = true;
    }

    /** 任务根本没跑起来（所选账号全停用 / 一个启用账号都没有）时的收尾。
        必须闭合状态机：否则前端会一直停在「进行中」等下去（原来这里直接 return，
        running 永远是 false 且 finished 停在上一轮的值，前端要么卡住要么误判）。 */
    private static void abortRun(String msg) {
        error = msg;
        log("✗ " + msg);
        running = false;
        finished = true;
        stage = "";
    }

    private static void runPatrol(List<String> pickedNames, long myRun) {
        List<Account> all = loadAccounts();
        List<Account> picked = new ArrayList<>();
        if (pickedNames != null && !pickedNames.isEmpty()) {
            for (Account a : all) {
                if (a.enabled && pickedNames.contains(a.name)) picked.add(a);
            }
            if (picked.isEmpty()) {
                abortRun("所选账号均未启用，请到「账号」页确认是否勾选并启用");
                return;
            }
        } else {
            for (Account a : all) if (a.enabled) picked.add(a);
        }
        if (picked.isEmpty()) {
            abortRun("没有启用中的账号，请先到「账号」页添加");
            return;
        }

        /* 状态已由 startPatrol() 同步重置过，这里不再重复（重复会把 runSeq 的语义搞乱）。 */
        log("=== 开始巡站 · " + picked.size() + " 个账号 ===");

        File batch = newBatchDir();
        batchDir = batch.getAbsolutePath();
        int nOk = 0, nOn = 0;
        // worker 在线程池里跑，失败数必须用原子计数器（局部 int 无法在 lambda 中自增）
        final AtomicInteger failCnt = new AtomicInteger(0);
        // 对外发布成功的张数，用来在结束时给用户一句明确交代
        final AtomicInteger pubCnt = new AtomicInteger(0);
        /* 【v0.36 修订四】已经被成功复制到对外目录的内部文件。
           对外那份写成功之后，内部副本就是纯占地方（每张图磁盘上躺两份）。
           worker 是并发的，所以用同步 List 收集，等 zip 打完之后再统一删。 */
        final List<String> pubPriv = java.util.Collections.synchronizedList(new ArrayList<>());
        final String batchName = batch.getName();

        try {
            for (Account cfg : picked) {
                String acc = cfg.name;
                log("");
                log("———— 账号：" + acc + "（" + cfg.account + "）————");
                AccountResult ar = new AccountResult();
                ar.name = acc;
                try {
                    String tok = ensureLogin(cfg);
                    List<Dev> devs = getDevices(tok);
                    int totalAll = devs.size();
                    if (cfg.hasFilter()) {
                        String[] kws = cfg.keywords();
                        List<Dev> kept = new ArrayList<>();
                        List<String> miss = new ArrayList<>();
                        for (Dev d : devs) {
                            boolean hit = false;
                            for (String k : kws) {
                                if (d.name != null && d.name.contains(k)) {
                                    hit = true;
                                    break;
                                }
                            }
                            if (hit) kept.add(d);
                        }
                        for (String k : kws) {
                            boolean any = false;
                            for (Dev d : devs) {
                                if (d.name != null && d.name.contains(k)) {
                                    any = true;
                                    break;
                                }
                            }
                            if (!any) miss.add(k);
                        }
                        if (!miss.isEmpty()) log("[警告] 关键词未匹配到设备: " + String.join("、", miss));
                        devs = kept;
                        log("站点过滤: 保留 " + devs.size() + " / 共 " + totalAll + " 台");
                    }
                    if (devs.isEmpty()) {
                        log("[提示] 该账号没有可巡站点，跳过");
                        ar.skip = true;
                        results.put(acc, ar);
                        continue;
                    }

                    totalCount += devs.size();
                    stage = acc;
                    File outDir = new File(batch, safeName(acc));
                    outDir.mkdirs();
                    ar.dir = outDir.getAbsolutePath();

                    final String ftok = tok;
                    final File fout = outDir;
                    final String facc = acc;
                    final List<Dev> fdevs = devs;
                    final AtomicInteger prog = new AtomicInteger(0);
                    int n = Math.max(1, WORKERS);
                    List<java.util.concurrent.Future<?>> futs = new ArrayList<>();
                    for (int w = 0; w < n; w++) {
                        final int wi = w;
                        final List<Dev> mine = new ArrayList<>();
                        for (int i = wi; i < fdevs.size(); i += n) mine.add(fdevs.get(i));
                        if (mine.isEmpty()) continue;
                        futs.add(POOL.submit(() -> {
                            for (int i = 0; i < mine.size(); i++) {
                                // 暂停时阻塞在此：当前设备跑完后停住，恢复后继续
                                int guard = 0;
                                while (paused && guard++ < 200000) {
                                    try {
                                        Thread.sleep(200);
                                    } catch (InterruptedException e) {
                                        return;
                                    }
                                }
                                Dev d = mine.get(i);
                                try {
                                    DevData data = fetchDeviceData(ftok, d.no);
                                    String status = data.judgeStatus();
                                    String fname = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.CHINA)
                                            .format(new Date()) + "_" + safeName(d.name) + ".png";
                                    String path = new File(fout, fname).getAbsolutePath();
                                    Renderer.render(d.name, d.no, data, path, status);
                                    // 复制一份到用户能在文件管理器里看到的位置
                                    // （根目录需「所有文件访问」，没授权就落「下载」目录，不需要权限）
                                    String pub = null;
                                    try {
                                        String rel = batchName + "/" + fout.getName() + "/" + fname;
                                        pub = ShotStore.publishAuto(rel, new File(path));
                                        if (pub != null && pubCnt.getAndIncrement() == 0) {
                                            log("[截图] 对外目录：" + ShotStore.displayPath());
                                        }
                                        /* 记下「这张已经有对外副本」，收尾时删掉内部那份。
                                           没记下的（pub == null）一律保留 —— 那是唯一的图。 */
                                        if (pub != null) pubPriv.add(path);
                                    } catch (Exception pe) {
                                        Log.w("patrol", "截图发布异常: " + pe);
                                    }
                                    String vn = data.rows.size() + " 个变量（水温优先）";
                                    if (data.rows.size() > MAX_CARDS) {
                                        vn = "显示 " + MAX_CARDS + "/" + data.rows.size()
                                                + " 个变量（水温优先）";
                                    }
                                    String preview = d.name + " | " + vn + " | 数据"
                                            + DevData.fmtAge(data.ageMinutes());
                                    synchronized (LOCK) {
                                        ReportItem ri = new ReportItem();
                                        ri.device = d.name;
                                        ri.status = status;
                                        ri.preview = preview;
                                        ri.path = path;
                                        ri.pubPath = pub;
                                        ar.report.add(ri);
                                    }
                                    log("[" + facc + "][w" + wi + "] (" + (i + 1) + "/" + mine.size()
                                            + ") " + statusTag(status) + " " + d.name);
                                } catch (Exception e) {
                                    failCnt.incrementAndGet();
                                    synchronized (LOCK) {
                                        ReportItem ri = new ReportItem();
                                        ri.device = d.name;
                                        ri.status = "error";
                                        ri.preview = String.valueOf(e.getMessage());
                                        ri.path = "";
                                        ar.report.add(ri);
                                    }
                                    log("[" + facc + "][w" + wi + "] (" + (i + 1) + "/" + mine.size()
                                            + ") ✗ " + d.name + " :: " + e);
                                }
                                int c = prog.incrementAndGet();
                                doneCount = c;
                            }
                        }));
                    }
                    for (java.util.concurrent.Future<?> fu : futs) {
                        try {
                            fu.get();
                        } catch (Exception ignored) {
                        }
                    }

                    int aOn = 0;
                    for (ReportItem r : ar.report) {
                        if ("online".equals(r.status)) aOn++;
                    }
                    int aBad = 0;
                    for (ReportItem r : ar.report) {
                        if ("error".equals(r.status)) aBad++;
                    }
                    nOk += ar.report.size() - aBad;
                    nOn += aOn;
                    log(acc + "：" + (ar.report.size() - aBad) + " 张图（在线 " + aOn + " 台）");
                } catch (Exception e) {
                    failCnt.incrementAndGet();
                    ar.error = String.valueOf(e.getMessage());
                    log("✗ 账号 " + acc + " 失败: " + e);
                }
                results.put(acc, ar);
            }

            // 打包
            if (nOk > 0) {
                try {
                    String zn = "有人云巡站截图_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.CHINA)
                            .format(new Date()) + ".zip";
                    File zp = new File(ctx.getExternalFilesDir(null), zn);
                    if (zp.getParentFile() != null) zp.getParentFile().mkdirs();
                    ZipUtil.zip(batch, zp);
                    zipName = zn;
                    log("已打包: " + zn);
                } catch (Exception e) {
                    log("打包失败: " + e.getMessage());
                }
                /* 【v0.36 修订四】zip 已经打好，内部副本可以删了。
                   只删「对外确实写成功」的那些：pub == null 的一张不动 ——
                   那种情况内部这份是唯一的图，删了就真没了。 */
                int gone = 0;
                synchronized (pubPriv) {
                    for (String p : pubPriv) {
                        try {
                            if (new File(p).delete()) gone++;
                        } catch (Exception ignored) {
                        }
                    }
                }
                /* 删完把空掉的账号目录、空掉的批次目录一并收掉。
                   有文件的时候 delete() 会返回 false，不会误删。 */
                int pruned = FilePrune.pruneEmptyDirs(batch);
                /* 每个账号下面显示的那行路径，改成「用户实际能找到的那个」。
                   整个账号的图都发布成功 → 显示对外目录；只要有一张没发出去，
                   就老实显示内部目录（那里才是完整的那份）。 */
                String pubBase = ShotStore.displayPath();
                for (AccountResult ar : results.values()) {
                    if (ar.report.isEmpty()) continue;
                    boolean allPub = true;
                    for (ReportItem it : ar.report) {
                        if (it.pubPath == null) {
                            allPub = false;
                            break;
                        }
                    }
                    if (allPub) {
                        ar.dir = new File(pubBase, batchName + "/" + safeName(ar.name))
                                .getAbsolutePath();
                    }
                }
                if (gone > 0) log("[截图] 已删内部副本 " + gone + " 张（对外那份保留）");
                if (pruned > 0) log("[截图] 收掉空目录 " + pruned + " 个");

                /* 【v0.36 修订三】**不再自动清往期**。
                   原来每轮跑完就把往期批次（私有目录 + 对外目录）一起删掉，
                   用户看到的现象是「跑完一次，上一次的图就没了」——
                   「清理往期」这个按钮也就成了摆设，点不点都一样。
                   现在往期一律保留，清不清、什么时候清由用户点「清理往期」决定。
                   这里只把「还剩几批」写进日志，方便判断该不该清。 */
                try {
                    int n = ZipUtil.listBatches().size();
                    if (n > 0) {
                        log("[批次] 除本次外还有 " + n + " 个往期批次（要删请点「清理往期」）");
                    }
                } catch (Exception e) {
                    Log.w("patrol", "统计往期批次失败: " + e);
                }
            }

            onlineCount = nOn;
            log("=== 巡站结束：共 " + nOk + " 张图，在线 " + nOn + " 台，失败 "
                    + failCnt.get() + " 个 ===");
            if (pubCnt.get() > 0) {
                log("[截图] 已复制 " + pubCnt.get() + " 张到：" + ShotStore.displayPath());
                log("       " + ShotStore.displayHint());
            } else {
                log("[截图] 对外目录写入失败，本次截图仅在应用内；要发出去请点巡站页「导出图片」");
            }
        } catch (Throwable e) {
            error = String.valueOf(e.getMessage());
            log("✗ 严重错误: " + e);
        } finally {
            /* 【v0.31 修订】只收自己这一轮的尾。
               正常情况下不会有第二轮并发（startPatrol 有 running 闸门兜着），
               但这个 guard 现在有了真作用：startPatrol 已经把 running 置 true 并 +1 了 runSeq，
               万一以后有人在这条链上加了新入口，迟到收尾的旧 worker
               也不会把新一轮的「进行中」给关掉。 */
            if (myRun == runSeq) {
                running = false;
                finished = true;
                stage = "";
            }
        }
    }

    public static void deleteTree(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) deleteTree(x);
        f.delete();
    }
}
