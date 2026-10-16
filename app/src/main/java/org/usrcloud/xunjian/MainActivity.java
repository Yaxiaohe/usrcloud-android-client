package org.usrcloud.xunjian;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 有人云巡站 · 原生壳
 *
 * WebView 承载 ui/index.html，网页通过 Android.xxx(...) 调本机能力。
 * 巡站全部逻辑在 Core（纯 Java + Canvas 渲染），不依赖 Python 运行时，
 * 安装包小、启动快、也不受 WebView 跨域限制。
 */
public class MainActivity extends Activity {

    private WebView web;

    /* 【v0.25 移除】文件管理器候选清单相关的整套代码：
     * FM_EXTRA_PKGS（已知包名表）、fileManagers()（查可响应 ACTION_VIEW 的应用）、
     * looksLikeFileManager()（按包名/应用名特征词过滤）、
     * appLabel()、isSystemPkg()、dirUri()（目录转 content:// URI）。
     *
     * 这六个方法构成一个自闭环，外部没有任何调用者：
     * 只有 openDir / openDirWith 那条已下线的链路会用它们。
     * 一并删掉，免得留下「看着能用其实没人调」的死代码。
     *
     * 注意别把 FileProvider 本身删了 ——
     * 导出图片功能（doExportImages）还在用它发 content:// URI。 */
    private String resStr(int id) {
        try {
            return getString(id);
        } catch (Throwable t) {
            return "";
        }
    }

    private ValueCallback<Uri[]> fileCb;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Core.init(this);
        // 通知渠道必须在第一次 notify 之前建好，否则静默失败
        Notifier.init(this);
        /* 【v0.20】恢复上次的监控开关。之前 enabled 只在内存里，
           重启就丢 —— 用户每次都得手动重新打开监控开关。
           注意 restoreEnabled() 已把 enabled 置成 true，
           此时再 setEnabled(true) 会因「值没变」直接返回、调度器不会起，
           所以先把内存值清掉再调，强制走一次启动流程。 */
        Watch.restoreEnabled();
        /* 【v0.33 修订四】恢复上次设置的轮询间隔。必须在 restoreEnabled 之前/之后都行，
           但要在网页加载之前 —— 否则监控页首帧画的是默认 15 分钟，
           用户会以为设置没保存。intervalSec 只影响后续调度与界面显示。 */
        Watch.restoreInterval();
        /* 【v0.31】把上次巡检的设备列表读回来。用户反馈「每次重开 app，
           监控页的站点信息都是空的」—— 一轮巡检几十台还要限速，等的就是
           「一进来什么都没有」。先拿上次的结果顶上，新一轮跑完自然覆盖。
           必须在 Core.init 之后（要读账号表），在 loadUrl 之前（网页一加载
           就能拿到数据）。 */
        Watch.restoreSnapshot();
        if (Watch.enabled) {
            Watch.enabled = false;
            Watch.setEnabled(true);
            WatchService.start(this);
        }

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(0xFFF2F4F8);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        // 图片走 file:///android_asset 拿不到私有目录，改为自定义 scheme 拦截
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                if (url != null && url.startsWith("appfile://")) {
                    try {
                        String p = url.substring("appfile://".length());
                        return new WebResourceResponse(
                                "image/png", "UTF-8", new FileInputStream(new File(p)));
                    } catch (Exception e) {
                        return null;
                    }
                }
                return null;
            }

            /* 【v0.30】页面加载完成后，把「点通知要跳到的目标设备」交给网页。
               时序很关键：loadUrl 是异步的，onCreate 里直接 evaluateJavascript
               网页还没初始化完、window.onOpenTarget 还不存在，注入会静默丢失。
               必须等 onPageFinished。 */
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pushOpenTarget();
            }
        });

        askPermissions();
        webRef = web;
        hadAllFiles = hasAllFilesAccess();
        hadNotify = Notifier.canNotify(this) && Notifier.channelOn(this, "patrol_alert");
        /* 【v0.30】先记下通知点击带来的目标设备，等 onPageFinished 再注入网页
           （网页此刻还没加载完，立刻注入会丢）。 */
        readOpenTarget(getIntent());
        web.loadUrl("file:///android_asset/index.html");
    }

    private WebView webRef = null;
    private boolean hadAllFiles = false;
    private boolean hadNotify = false;

    /* 【v0.30】点通知跳转的目标设备。通知点击时带 acc/dev 过来，
       网页加载完成后由 pushOpenTarget() 交给前端，让它切到监控页并
       展开+刷新这台设备，用户一进来就能看到当前数据。
       消费后清空，避免下次正常启动又被当成跳转。 */
    private String openDevName = null;
    private String openAccName = null;
    /* 【v0.33】只带 tab 不带设备名的跳转目标（如常驻通知「巡站监控运行中」）。
       原来 readOpenTarget 只认 dev/acc，tab=watch 被整个忽略 ——
       通知里明明写了「点此打开监控页」，落地却停在用户上次待的那个页签。 */
    private String openTab = null;

    /** 把「点通知要跳到的设备」注入网页。页面没就绪时静默跳过（下次 onPageFinished 再来）。 */
    private void pushOpenTarget() {
        if (webRef == null) return;
        /* 只有 tab 没有设备名时也要注入，别被 dev 为空卡掉 */
        if ((openDevName == null || openDevName.isEmpty())
                && (openTab == null || openTab.isEmpty())) return;
        try {
            String tab = openTab;
            if (tab != null && !tab.isEmpty()) {
                JSONObject t = new JSONObject();
                t.put("tab", tab);
                /* 用 JSONObject.quote 保证参数进 JS 字符串安全 */
                webRef.evaluateJavascript(
                        "window.onOpenTab && window.onOpenTab(" + t.toString() + ")", null);
            }
            if (openDevName != null && !openDevName.isEmpty()) {
                JSONObject o = new JSONObject();
                o.put("dev", openDevName);
                if (openAccName != null) o.put("acc", openAccName);
                /* 用 JSONObject.quote 保证中文设备名/账号名进 JS 字符串是安全的，
                   否则名字里带引号或反斜杠会把注入的脚本拼坏。 */
                webRef.evaluateJavascript(
                        "window.onOpenTarget && window.onOpenTarget(" + o.toString() + ")", null);
            }
        } catch (Throwable t) {
            Core.log("[跳转] 注入目标设备失败: " + t);
        } finally {
            openDevName = null;
            openAccName = null;
            openTab = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        /* app 已在运行时点通知：不会重走 onCreate，必须在这里接收。
           singleTop/singleTask 下系统把新 Intent 交给这个回调。 */
        setIntent(intent);
        readOpenTarget(intent);
        pushOpenTarget();
    }

    /** 从 Intent 里读出 tab/dev/acc（通知点击带过来的）。 */
    private void readOpenTarget(Intent it) {
        if (it == null) return;
        String dev = it.getStringExtra("dev");
        String acc = it.getStringExtra("acc");
        if (dev != null && !dev.isEmpty()) {
            openDevName = dev;
            openAccName = (acc != null && !acc.isEmpty()) ? acc : null;
        }
        /* 【v0.33】tab 单独记：常驻通知点进来只有 tab、没有 dev */
        String tab = it.getStringExtra("tab");
        if (tab != null && !tab.isEmpty()) openTab = tab;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从系统「所有文件访问」设置页返回时，授权状态可能变了，通知前端刷新
        if (webRef == null) return;
        boolean now = hasAllFilesAccess();
        if (now != hadAllFiles) {
            hadAllFiles = now;
            try {
                webRef.evaluateJavascript(
                        "window.onAllFilesChanged && window.onAllFilesChanged("
                                + now + ")", null);
            } catch (Exception ignored) {
            }
        }
        /* 同理：用户去系统设置里开完通知返回，「我的」页的通知状态标签
           要跟着变，否则还停在「未授权」，用户以为没生效。 */
        boolean nNow = Notifier.canNotify(this)
                && Notifier.channelOn(this, "patrol_alert");
        if (nNow != hadNotify) {
            hadNotify = nNow;
            try {
                webRef.evaluateJavascript(
                        "window.onNotifyChanged && window.onNotifyChanged("
                                + nNow + ")", null);
            } catch (Exception ignored) {
            }
        }
    }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                need.add(android.Manifest.permission.WRITE_EXTERNAL_STORAGE);
            }
            if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                need.add(android.Manifest.permission.READ_EXTERNAL_STORAGE);
            }
        }
        /* Android 13+ 必须运行时申请通知权限。
           没这一段，notify() 既不抛异常也不弹通知，
           用户只会看到「点了测试提醒，什么都没发生」。 */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                need.add(android.Manifest.permission.POST_NOTIFICATIONS);
            }
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 100);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != 100) return;
        // 通知权限被拒时如实告诉用户，别让「测试提醒」假装成功
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !Notifier.canNotify(this)) {
            toast("没有通知权限，设备异常时不会弹通知。可在系统设置里给本 app 打开通知。");
            Core.log("[通知] 用户未授予通知权限，提醒只记录在 app 内");
        }
    }

    // ---------------- 网页桥 ----------------

    private class Bridge {

        @JavascriptInterface
        public String call(String method, String argJson) {
            try {
                JSONObject arg = (argJson == null || argJson.isEmpty())
                        ? new JSONObject() : new JSONObject(argJson);
                return dispatch(method, arg).toString();
            } catch (Throwable t) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("ok", false);
                    o.put("error", String.valueOf(t.getMessage()));
                    return o.toString();
                } catch (Exception ignore) {
                    return "{\"ok\":false,\"error\":\"unknown\"}";
                }
            }
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void exportZip(final String zipName) {
            runOnUiThread(() -> doExport(zipName));
        }

        /**
         * 导出图片：paths 是一批 PNG 的绝对路径（优先对外目录的）。
         *
         * 【v0.10 修】v0.09 一直报「导出失败：Value [/storageVemulatedV0V...」，
         * 报错文案和 v0.08 一字不差——现在看清了，跟 FileProvider 毫无关系：
         * 前端 `Android.exportImages(JSON.stringify(paths))` 传的是**数组** `["p1","p2"]`，
         * 这里却用 `new JSONObject(...)` 去解析数组，org.json 直接抛
         * `JSONException: Value [...]`。异常在进入 doExportImages **之前**就抛了，
         * 所以 v0.09 改的 doExportImages 内部（cacheDir 复制）一行都没跑到。
         *
         * 教训：org.json 的 JSONArray 和 JSONObject 是两个类型，
         * 用错一个报的是「Value [...]」这种看不出所以然的错，
         * 很容易被误判成路径/权限问题。桥接方法统一在这里转一次，两边只认一种格式。
         */
        @JavascriptInterface
        public void exportImages(final String pathsJson) {
            runOnUiThread(() -> {
                try {
                    String s = pathsJson == null ? "" : pathsJson.trim();
                    if (s.isEmpty()) s = "[]";
                    JSONArray paths;
                    if (s.startsWith("[")) {
                        paths = new JSONArray(s);
                    } else {
                        // 容错：万一传进来的是 {"paths":[...]}，也照样能解
                        paths = new JSONObject(s).optJSONArray("paths");
                        if (paths == null) paths = new JSONArray();
                    }
                    doExportImages(paths);
                } catch (Exception e) {
                    Core.log("[导出] 参数解析失败：" + e);
                    toast("导出失败：" + e.getMessage());
                }
            });
        }
    }

    private JSONObject dispatch(String method, JSONObject a) throws Exception {
        switch (method) {
            case "health": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("version", Core.APP_VERSION);
                o.put("saveDir", saveDirText());
                o.put("saveHint", saveDirHint());
                o.put("workers", Core.WORKERS);
                o.put("staleMinutes", Core.STALE_MINUTES);
                /* 【v0.27】包里自带几个预置账号，下发给前端显示。
                   不带预置账号的版本这里就是 0，界面文案跟着变。 */
                o.put("presetCount", Core.presetAccountCount());
                o.put("allFiles", hasAllFilesAccess());
                /* 通知可用性：Android 13+ 没授权 / 通道被用户关掉都会导致
                   「点了没反应」。暴露给前端，在「我的」页如实显示。 */
                boolean canNotify = Notifier.canNotify(this);
                o.put("canNotify", canNotify);
                o.put("alertChannel", Notifier.channelOn(this, "patrol_alert"));
                o.put("stateChannel", Notifier.channelOn(this, "patrol_state"));
                return o;
            }
            case "askAllFiles": {
                // 点了就跳系统设置页，用户返回后前端会重新 health 刷新状态
                runOnUiThread(() -> openAllFilesSettings());
                JSONObject o = new JSONObject();
                o.put("ok", true);
                return o;
            }
            case "openNotifSettings": {
                /* 跳本 app 的通知设置页。
                   Android 13+ 用户在系统设置里把通知关掉后，
                   不提供入口的话他们根本不知道去哪儿打开。 */
                runOnUiThread(() -> {
                    try {
                        Intent it = new Intent();
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            it.setAction("android.settings.APP_NOTIFICATION_SETTINGS");
                            it.putExtra("android.provider.extra.APP_PACKAGE",
                                    getPackageName());
                        } else {
                            it.setAction("android.settings.APPLICATION_DETAILS_SETTINGS");
                            it.setData(Uri.fromFile(new File("/data/data/"
                                    + getPackageName())));
                        }
                        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(it);
                    } catch (Exception e) {
                        try {
                            Intent it = new Intent(
                                    "android.settings.APPLICATION_DETAILS_SETTINGS");
                            it.setData(Uri.fromFile(
                                    new File("/data/data/" + getPackageName())));
                            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(it);
                        } catch (Exception e2) {
                            toast("没找到系统设置页，请手动到设置里找到本 app 打开通知");
                        }
                    }
                });
                JSONObject o = new JSONObject();
                o.put("ok", true);
                return o;
            }
            case "batteryOpt": {
                /* 【v0.20】电池优化白名单。
                   国产 ROM（尤其小米/华为/OPPO）默认会「冻结」后台 app，
                   即使有前台服务也可能被杀。前台服务保证进程优先级，
                   白名单保证系统不去动它 —— 两者缺一，通知都会时灵时不灵。 */
                runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            android.os.PowerManager pm =
                                    (android.os.PowerManager) getSystemService(
                                            Context.POWER_SERVICE);
                            if (pm != null && pm.isIgnoringBatteryOptimizations(
                                    getPackageName())) {
                                Core.log("[监控] 已在电池优化白名单中");
                                toast("已经在白名单里，不用再设置");
                                return;
                            }
                            Intent it = new Intent(
                                    android.provider.Settings
                                            .ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                            it.setData(Uri.fromFile(
                                    new File("package:" + getPackageName())));
                            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(it);
                            return;
                        }
                        toast("本机系统不需要设置电池优化");
                    } catch (Exception e) {
                        try {
                            Intent it = new Intent(
                                    "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS");
                            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(it);
                        } catch (Exception e2) {
                            toast("本机系统不支持自动跳转，请手动在设置里把本 app 设为不受限制");
                        }
                    }
                });
                JSONObject ob = new JSONObject();
                ob.put("ok", true);
                return ob;
            }
            /* 【v0.25 移除】openDir / openDirWith / filePickTree 三个分支下线。
             *
             * 「用文件管理器打开这个目录」这条链路从 v0.22 试到 v0.24，
             * 三轮都没做成，原因不在代码而在目标能力本身：
             * Android 从来没有「用外部应用打开一个目录」的标准 Intent。
             * 各家文件管理器实现不同，有的根本不接目录 URI，
             * 轮着试 MIME 也只是把「打不开」换个形式交给用户。
             * 用户反馈原话：「这样吧 我不死磕这个按钮了」——
             * 那就把入口和实现一起摘干净，别留没人调的分支。
             *
             * 前端的 #dirbar 路径提示保留（/storage/emulated/0/巡站截图
             * 在文件管理器第一层就能看到），用户自己点进去更可控。
             * fileManagers() / looksLikeFileManager() / dirUri()
             * 这几个只为这条链路服务的私有方法也一并删除。 */
            case "viewShot": {
                /* 把一张截图读成 data: URI 交给 WebView 显示。
                 *
                 * 【为什么不直接给前端 <img src="/storage/...">】
                 * WebView 里的是 file:// 源，对外部存储的 PNG 经常加载不出来
                 * （WebView 进程读不到别的进程的外部存储文件），
                 * 表现就是「点了没反应」或者一片空白，很难查。
                 * 由原生读一遍转 base64，WebView 一定能显示。
                 * 单张 1~3MB，base64 约 1.3 倍，打开一张完全够用。 */
                String p = a.optString("path", "");
                JSONObject o = new JSONObject();
                if (p.isEmpty()) {
                    o.put("ok", false);
                    o.put("error", "路径为空");
                    return o;
                }
                try {
                    File f = new File(p);
                    if (!f.exists() || !f.isFile()) {
                        o.put("ok", false);
                        o.put("error", "文件不存在：" + p);
                        return o;
                    }
                    byte[] raw = readAll(f);
                    if (raw == null || raw.length == 0) {
                        o.put("ok", false);
                        o.put("error", "图片读不出来：" + p);
                        return o;
                    }
                    o.put("ok", true);
                    o.put("data", "data:image/png;base64," + Base64.encodeToString(
                            raw, Base64.NO_WRAP));
                } catch (Throwable t) {
                    try {
                        o.put("ok", false);
                        o.put("error", String.valueOf(t.getMessage()));
                    } catch (Exception ignore) {
                    }
                }
                return o;
            }
            case "settings": {
                Core.loadCfg();
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("workers", Core.WORKERS);
                o.put("saveDir", saveDirText());
                o.put("saveHint", saveDirHint());
                o.put("version", Core.APP_VERSION);
                o.put("histFiles", Hist.filesJson());
                return o;
            }
            case "setWorkers": {
                Core.saveWorkers(a.optInt("workers", 4));
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("workers", Core.WORKERS);
                return o;
            }
            /* 【v0.26】陈旧判定阈值（分钟）：数据多久没更新就判「陈旧」。
               持久化在 监控规则.json 的 stale_minutes，同时同步
               Core.STALE_MINUTES（巡站状态判定共用）。
               限幅 1~720：太小会大面积误报陈旧，太大失去意义。 */
            case "setStaleMin": {
                int m = a.optInt("minutes", 15);
                m = Math.max(1, Math.min(720, m));
                JSONObject rules = Watch.loadRules();
                rules.put("stale_minutes", m);
                Watch.saveRules(rules);
                Core.STALE_MINUTES = m;
                Core.log("[监控] 陈旧判定阈值 = " + m + " 分钟");
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("staleMinutes", m);
                return o;
            }
            case "accounts": {
                JSONArray arr = new JSONArray();
                for (Account x : Core.loadAccounts()) arr.put(accJson(x));
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("accounts", arr);
                return o;
            }
            case "accountSave": {
                String oldName = a.optString("old_name", "");
                String name = a.optString("name", "").trim();
                String acc = a.optString("account", "").trim();
                String pwd = a.optString("password", "").trim();
                if (name.isEmpty() || acc.isEmpty()) return fail("名称和账号不能为空");
                if (pwd.isEmpty()) return fail("密码不能为空");
                List<Account> rows = Core.loadAccounts();
                int hit = -1;
                for (int i = 0; i < rows.size(); i++) {
                    if ((!oldName.isEmpty() && rows.get(i).name.equals(oldName))
                            || (oldName.isEmpty() && rows.get(i).name.equals(name))) {
                        hit = i;
                        break;
                    }
                }
                Account x = new Account();
                x.name = name;
                x.account = acc;
                x.password = pwd;
                x.platformId = a.optString("platform_id", "W3rfV").trim();
                if (x.platformId.isEmpty()) x.platformId = "W3rfV";
                x.enabled = a.optBoolean("enabled", true);
                /* 【v0.20 关键修复】前端传的是 JSON 数组（station_kw: ["a","b"]），
                   不能用 optString 直接取 —— org.json 对 JSONArray 取不到字符串时
                   会把值原样 toString 返回，于是 "[]" 被原封不动写进 CSV，
                   用户表现为「新建账号过滤栏冒出 []，而且删不掉」。
                   这里自己分派：数组就 join，空值给空串。 */
                String kwRaw;
                if (a.opt("station_kw") instanceof JSONArray) {
                    JSONArray ja = a.optJSONArray("station_kw");
                    kwRaw = ja == null ? "" : joinArray(ja);
                } else {
                    kwRaw = a.optString("station_kw", "");
                }
                x.stationKw = Core.cleanStationKw(kwRaw);
                String act;
                if (hit < 0) {
                    rows.add(x);
                    act = "新增";
                } else {
                    rows.set(hit, x);
                    act = "修改";
                }
                Core.saveAccounts(rows);
                Core.log("[账号] 已" + act + ": " + name + "（" + acc + "）");
                return ok("已" + act, rows);
            }
            case "accountDel": {
                String name = a.optString("name", "");
                List<Account> rows = Core.loadAccounts();
                List<Account> left = new ArrayList<>();
                for (Account x : rows) if (!x.name.equals(name)) left.add(x);
                if (left.size() == rows.size()) return fail("账号不存在");
                Core.saveAccounts(left);
                Core.log("[账号] 已删除: " + name);
                return ok("已删除", left);
            }
            case "accountToggle": {
                String name = a.optString("name", "");
                List<Account> rows = Core.loadAccounts();
                for (Account x : rows) {
                    if (x.name.equals(name)) {
                        x.enabled = !x.enabled;
                        Core.saveAccounts(rows);
                        Core.log("[账号] " + name + " 已" + (x.enabled ? "启用" : "停用"));
                        return ok("已" + (x.enabled ? "启用" : "停用"), rows);
                    }
                }
                return fail("账号不存在");
            }
            /* ---------------- 账号表格原文编辑（v0.19） ---------------- */
            case "accountsRaw": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("text", Core.accountsRaw());
                o.put("path", Core.accountsPathHint());
                /* 手机里那份是不是旧版留下来的（含已从预置删掉的账号）。
                   界面上据此提醒用户可以「恢复出厂预置」。 */
                o.put("stale", Core.accountsLooksStale());
                return o;
            }
            case "accountsReset": {
                /* 恢复出厂预置：清掉手机里的旧表，重新铺 assets 那份。
                   解决「升级后旧账号还在」—— 覆盖安装不会动私有目录。 */
                List<Account> rows = Core.resetToPreset();
                return ok("已恢复出厂预置", rows);
            }
            case "accountsRawSave": {
                /* 校验不通过时 Core 一律不写文件，原表保持原样。
                   这里把具体原因原样带回，让用户知道哪一行有问题。 */
                String err = Core.saveAccountsRaw(a.optString("text", ""));
                if (!err.isEmpty()) {
                    Core.log("[账号] 表格保存被拒绝: " + err);
                    return fail(err);
                }
                /* 存完立刻回读一次确认真的落盘了 ——
                   写完就报成功、实际没写进去是最难查的一种「失效」。 */
                int n = Core.loadAccounts().size();
                JSONObject o = ok("已保存", Core.loadAccounts());
                o.put("count", n);
                return o;
            }
            /* 单账号登录自检：把「能不能登录」和「设备过滤」分开报。
               用户之前分不清这两种失败，只会笼统地说「登不上」。 */
            case "accountTest": {
                String name = a.optString("name", "");
                Account t = null;
                for (Account x : Core.loadAccounts()) {
                    if (x.name.equals(name)) { t = x; break; }
                }
                if (t == null) return fail("账号不存在");
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("name", name);
                try {
                    String tok = Core.ensureLogin(t);
                    o.put("login", true);
                    List<Core.Dev> all = Core.getDevicesQuiet(tok, null);
                    o.put("total", all.size());
                    /* 过滤前后对比：这一条最关键。
                       如果 total=12 而 filtered=0，那就是站点过滤写错了，
                       跟登录没有任何关系 —— 不用再怀疑账号密码。 */
                    String[] kws = t.keywords();
                    List<Core.Dev> f = Core.getDevicesQuiet(tok, t.hasFilter() ? kws : null);
                    o.put("filtered", f.size());
                    o.put("hasFilter", t.hasFilter());
                    o.put("kws", String.join("、", kws));
                    if (t.hasFilter() && f.isEmpty() && !all.isEmpty()) {
                        StringBuilder names = new StringBuilder();
                        for (int i = 0; i < all.size() && i < 6; i++) {
                            if (i > 0) names.append(" / ");
                            names.append(all.get(i).name);
                        }
                        o.put("hint", "登录正常，但站点过滤把 " + all.size()
                                + " 台全过滤掉了。设备名如：" + names
                                + "。关键词要按设备名里真实出现的字填，不要带 [ ] \" ' 等符号。");
                    } else if (t.hasFilter()) {
                        o.put("hint", "登录正常，过滤后剩 " + f.size() + " 台。");
                    } else {
                        o.put("hint", "登录正常，共 " + all.size() + " 台（未设站点过滤）。");
                    }
                } catch (Exception e) {
                    o.put("login", false);
                    o.put("hint", "登录失败：" + e.getMessage());
                }
                return o;
            }
            case "run": {
                if (Core.running) {
                    /* 【v0.31 修订】真的有任务在跑时，别只丢回一句「已有任务在运行」——
                       那看起来就像「点了开始却弹错误信息」。带上 running 和 run_id，
                       前端收到后会挂上本轮进度继续看，而不是停在原地。
                       （这个分支正是老 bug 的第二个表现：前端误判完成后轮询停了，
                       用户再点一次就撞到这里。） */
                    JSONObject o = new JSONObject();
                    o.put("ok", false);
                    o.put("msg", "已有任务在运行");
                    o.put("running", true);
                    o.put("run_id", Core.runSeq);
                    return o;
                }
                List<String> names = new ArrayList<>();
                JSONArray arr = a.optJSONArray("names");
                if (arr != null) for (int i = 0; i < arr.length(); i++) names.add(arr.getString(i));
                Core.startPatrol(names);
                JSONObject o = new JSONObject();
                o.put("ok", true);
                /* 本轮编号：startPatrol 里同步 +1 并同步重置状态，
                   所以这个值就是本轮，前端拿它比对 status 就能排除上一轮的残留。 */
                o.put("run_id", Core.runSeq);
                return o;
            }
            case "pause": {
                boolean nowPause = !Core.paused;
                Core.paused = nowPause;
                Core.log(nowPause ? "[控制] 已暂停（当前设备跑完后停住）" : "[控制] 继续");
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("paused", nowPause);
                return o;
            }
            case "status": {
                int since = a.optInt("since", 0);
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("running", Core.running);
                o.put("paused", Core.paused);
                JSONArray lg = new JSONArray();
                synchronized (Core.logs) {
                    for (Core.LogLine l : Core.logs) {
                        if (l.seq > since) {
                            JSONObject oo = new JSONObject();
                            oo.put("seq", l.seq);
                            oo.put("line", l.line);
                            lg.put(oo);
                        }
                    }
                    o.put("seq", Core.logSeq.get());
                }
                o.put("logs", lg);
                o.put("total", Core.totalCount);
                o.put("acc_done", Core.doneCount);
                o.put("stage", Core.stage);
                o.put("error", Core.error == null ? JSONObject.NULL : Core.error);
                o.put("online", Core.onlineCount);
                o.put("finished", Core.finished);
                /* 【v0.31 修订】本轮编号，前端用它认「这份状态是不是本轮的」 */
                o.put("run_id", Core.runSeq);
                o.put("zip", Core.zipName == null ? JSONObject.NULL : Core.zipName);
                return o;
            }
            case "result": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                JSONObject rs = new JSONObject();
                synchronized (Core.LOCK) {
                    for (Map.Entry<String, Core.AccountResult> e : Core.results.entrySet()) {
                        Core.AccountResult r = e.getValue();
                        JSONObject ro = new JSONObject();
                        ro.put("dir", r.dir == null ? JSONObject.NULL : r.dir);
                        ro.put("error", r.error == null ? JSONObject.NULL : r.error);
                        ro.put("skip", r.skip);
                        JSONArray rep = new JSONArray();
                        for (Core.ReportItem it : r.report) {
                            JSONObject io = new JSONObject();
                            io.put("device", it.device);
                            io.put("status", it.status);
                            io.put("tag", "error".equals(it.status) ? "✗失败" : Core.statusTag(it.status));
                            io.put("preview", it.preview);
                            io.put("path", it.path);
                            io.put("pub", it.pubPath == null ? JSONObject.NULL : it.pubPath);
                            rep.put(io);
                        }
                        ro.put("report", rep);
                        rs.put(e.getKey(), ro);
                    }
                }
                o.put("results", rs);
                o.put("zip", Core.zipName == null ? JSONObject.NULL : Core.zipName);
                o.put("online", Core.onlineCount);
                return o;
            }
            case "devices": {
                String name = a.optString("name", "");
                Account acc = null;
                for (Account x : Core.loadAccounts()) if (x.name.equals(name)) acc = x;
                if (acc == null) return fail("账号不存在");
                if (!acc.enabled) return fail("该账号已停用");
                if (acc.password.isEmpty()) return fail("该账号没有密码");
                try {
                    String tok = Core.ensureLogin(acc);
                    List<Core.Dev> devs = Core.getDevices(tok);
                    if (acc.hasFilter()) {
                        String[] kws = acc.keywords();
                        List<Core.Dev> kept = new ArrayList<>();
                        for (Core.Dev d : devs) {
                            for (String k : kws) {
                                if (d.name != null && d.name.contains(k)) {
                                    kept.add(d);
                                    break;
                                }
                            }
                        }
                        devs = kept;
                    }
                    JSONArray arr = new JSONArray();
                    for (Core.Dev d : devs) {
                        JSONObject o = new JSONObject();
                        o.put("no", d.no);
                        o.put("name", d.name);
                        arr.put(o);
                    }
                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    o.put("devices", arr);
                    return o;
                } catch (Exception e) {
                    return fail(String.valueOf(e.getMessage()));
                }
            }
            case "clean": {
                // 私有目录（zip 源）+ 对外目录（用户实际看到的）都要清
                List<String> removed = new ArrayList<>();
                for (String b : ZipUtil.listBatches()) {
                    Core.deleteTree(new File(Core.batchesDir(), b));
                    removed.add(b);
                }
                String cur = Core.batchDir == null ? "" : new File(Core.batchDir).getName();
                int pubN = ShotStore.cleanOldBatches(cur);
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("removed", removed.size());
                o.put("removedPub", pubN);
                return o;
            }

            // ---------------- 数据监控 ----------------
            case "watchOn": {
                Watch.setEnabled(true);
                /* 【v0.20】拉起前台服务，让 app 退到后台后巡检和系统通知继续跑。
                   之前只有进程内线程池，用户一切掉 app 就静默停摆。 */
                WatchService.start(this);
                return okSimple();
            }
            case "watchOff": {
                Watch.setEnabled(false);
                /* 【v0.20】关监控就把常驻通知一起收掉，
                   否则下拉栏会一直挂着一条「运行中」，用户会以为关不掉。 */
                WatchService.stop(this);
                return okSimple();
            }
            case "watchScan": {
                if (WatchGuard.scanning.get()) return fail("巡检进行中");
                Watch.scanAsync();
                return okSimple();
            }
            /* 【v0.30】刷新单台设备的实时数据（监控页点开站点后就地拉一次）。
               不跑整轮巡检，快进快出；返回更新后的那一行设备状态。 */
            case "watchDevRefresh": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("device", Watch.refreshDevice(a.optString("acc"), a.optString("no")));
                return o;
            }
            /* 【v0.32】复制文本到系统剪贴板（监控页长按站名）。
               WebView 里 navigator.clipboard 在 file:// 下基本是残废，
               复制必须走原生。空内容如实拒绝，别让用户以为复制上了。 */
            case "copyText": {
                String text = a.optString("text", "");
                if (text.isEmpty()) return fail("没有可复制的内容");
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) return fail("剪贴板不可用");
                cm.setPrimaryClip(ClipData.newPlainText(
                        a.optString("label", "文本"), text));
                return okSimple();
            }
            case "watchInterval": {
                Watch.setInterval(a.optInt("sec", 900));
                return okSimple();
            }
            /* 【v0.31】下发单个变量的值到设备（监控页「调整」按钮的落点）。
               可写性、下发编号的核对都在 Watch.setVar 里做，这里只转发。
               返回里带 accepted（平台已受理）而不是「写成功」——
               平台对不存在的变量 id 也回 success，不能骗用户说写进去了。 */
            case "watchSetVar": {
                return Watch.setVar(a.optString("acc"), a.optString("no"),
                        a.optLong("rel", 0), a.optString("var"), a.optString("value"));
            }
            case "watchScope": {
                Watch.scope.clear();
                JSONArray arr = a.optJSONArray("names");
                if (arr != null) for (int i = 0; i < arr.length(); i++) Watch.scope.add(arr.getString(i));
                return okSimple();
            }
            case "watchState": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("summary", Watch.summary());
                o.put("devices", Watch.statesJson());
                o.put("alerts", Watch.alertsJson());
                /* 【v0.18】有异常但没规则覆盖的账号。
                   前端要把它明说出来 —— 用户看到「离线 1 台」却没收到提醒时，
                   最容易得出的结论是「提醒功能坏了」，而不是「那个账号没配规则」。 */
                o.put("uncovered", Watch.uncoveredJson());
                return o;
            }
            case "alertsRead": {
                Watch.markAlertsRead();
                return okSimple();
            }
            case "alertsClear": {
                Watch.clearAlerts();
                return okSimple();
            }
            case "alertsPushTest": {
                /* 造一条测试提醒，验证提醒链路与通知是否通。
                   v0.08 之前这里无条件回 ok，前端就弹「已发出，请看下拉通知栏」，
                   但实际从没发过任何系统通知——用户点完什么都没发生。
                   现在如实返回能不能发，让前端说真话。 */
                boolean can = Notifier.canNotify(this);
                boolean chOn = Notifier.channelOn(this, "patrol_alert");
                Watch.pushAlert("测试", "测试设备", "-",
                        can && chOn ? "这是一条测试提醒，下拉通知栏应能看到"
                                : "这是一条测试提醒（通知未授权，仅记录在 app 内）",
                        "warn");
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("canNotify", can);
                o.put("channelOn", chOn);
                o.put("pushed", can && chOn);
                if (!can) o.put("reason", "系统未授予通知权限（Android 13+ 需在设置里手动打开）");
                else if (!chOn) o.put("reason", "「设备异常提醒」通知通道被关闭了");
                return o;
            }

            // ---------------- 异常提醒规则 ----------------
            case "rulesGet": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("rules", Watch.loadRules());
                return o;
            }
            case "rulesSave": {
                JSONObject rules = a.optJSONObject("rules");
                if (rules == null) return fail("规则为空");
                Watch.saveRules(rules);
                Core.log("[监控] 规则已保存");
                return okSimple();
            }
            case "rulesAdd": {
                JSONObject rules = Watch.loadRules();
                JSONArray rl = rules.optJSONArray("rules");
                if (rl == null) rl = new JSONArray();
                rl.put(a.optJSONObject("rule") == null ? new JSONObject() : a.getJSONObject("rule"));
                rules.put("rules", rl);
                Watch.saveRules(rules);
                return okSimple();
            }
            case "rulesDel": {
                JSONObject rules = Watch.loadRules();
                JSONArray rl = rules.optJSONArray("rules");
                JSONArray keep = new JSONArray();
                int idx = a.optInt("index", -1);
                for (int i = 0; i < rl.length(); i++) {
                    if (i != idx) keep.put(rl.getJSONObject(i));
                }
                rules.put("rules", keep);
                Watch.saveRules(rules);
                Core.log("[监控] 已删除第 " + (idx + 1) + " 条规则");
                return okSimple();
            }

            // ---------------- 历史数据 ----------------
            case "histGet": {
                String acc = a.optString("acc", "");
                String no = a.optString("no", "");
                int hours = a.optInt("hours", 168);
                String src = a.optString("src", "local");
                /* 「全部账号」= acc 空。
                   平台云端必须按具体设备查（一次拉几十台会把请求额度打爆），
                   所以汇总模式只在本地记录下开放。 */
                if ("cloud".equals(src) && (acc.isEmpty() || no.isEmpty())) {
                    return fail("平台云端需先选择具体设备");
                }
                JSONObject o = "cloud".equals(src)
                        ? cloudHistory(acc, no, hours)
                        : Hist.localHistory(acc, no, hours);
                o.put("ok", true);
                return o;
            }
            case "histSave": {
                Hist.saveNow();
                return okSimple();
            }
            case "histFiles": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("files", Hist.filesJson());
                return o;
            }
            /* 【v0.28】本地落盘里出现过哪些设备，供历史页直接点选，
               省掉「读取设备」那一步（不再走平台 devices 接口）。 */
            case "histDevs": {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("devs", Hist.devicesJson());
                return o;
            }
            /* 【v0.27】清理落盘的历史数据。前端传勾选的文件名清单，
               Hist.clean 里做前缀/后缀/路径穿越校验后才删。 */
            case "histClean": {
                return Hist.clean(a.optJSONArray("names"));
            }

            default:
                return fail("未知方法: " + method);
        }
    }

    private JSONObject okSimple() throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        return o;
    }

    /** 云端历史：按需拉某台设备的变量定义与历史值。 */
    private JSONObject cloudHistory(String accName, String no, int hours) {
        hours = Math.max(1, Math.min(720, hours));
        JSONObject out = new JSONObject();
        try {
            Account acc = null;
            for (Account x : Core.loadAccounts()) if (x.name.equals(accName)) acc = x;
            if (acc == null) return out.put("error", "账号不存在");
            String tok = Core.ensureLogin(acc);
            int maxVars = 6;
            JSONObject pts = new JSONObject();
            pts.put("dataPointType", "");
            pts.put("dataPointName", "");
            pts.put("dataPointIdList", new JSONArray());
            pts.put("slaveId", "");
            pts.put("cusdeviceNo", no);
            pts.put("getOperable", 0);
            pts.put("getTimestampDatas", 1);
            pts.put("getLocationDatas", 1);
            pts.put("getStringDatas", 0);
            pts.put("getBitDatas", 0);
            pts.put("pageNo", 1);
            pts.put("pageSize", 500);
            JSONArray plst = Core.apiPublic(Core.POINTS_URL, pts, tok)
                    .optJSONObject("data").optJSONArray("cusdeviceDataPointList");
            if (plst == null) plst = new JSONArray();

            long start = System.currentTimeMillis() - hours * 3600_000L;
            java.util.LinkedHashMap<String, List<double[]>> series = new java.util.LinkedHashMap<>();
            JSONArray vars = new JSONArray();
            int n = Math.min(maxVars, plst.length());
            for (int i = 0; i < n; i++) {
                JSONObject pt = plst.getJSONObject(i);
                String name = pt.optString("name");
                Object rel = pt.opt("dataPointRelId");
                if (rel == null) continue;
                // 历史库按 dataPointId 查询
                JSONObject hp = new JSONObject();
                hp.put("dataPoints", new JSONArray().put(new JSONObject()
                        .put("cusdeviceNo", no)
                        .put("dataPointId", pt.opt("dataPointId"))));
                hp.put("startTime", start);
                hp.put("endTime", System.currentTimeMillis());
                JSONObject r;
                try {
                    r = Core.apiPublic("https://history.usr.cn:7002/history/cusdevice/historyData", hp, tok);
                } catch (Exception e) {
                    continue;
                }
                JSONArray lst = r.optJSONObject("data") == null ? null
                        : r.optJSONObject("data").optJSONArray("list");
                if (lst == null) continue;
                List<double[]> pts2 = new ArrayList<>();
                for (int j = 0; j < lst.length(); j++) {
                    JSONObject o = lst.getJSONObject(j);
                    long t = o.optLong("time", 0);
                    Double v = Watch.parseNum(String.valueOf(o.opt("value")));
                    if (t <= 0 || v == null) continue;
                    pts2.add(new double[]{t, v});
                }
                if (pts2.size() < 2) continue;
                java.util.Collections.sort(pts2, (x, y) -> Double.compare(x[0], y[0]));
                series.put(name, pts2);
                JSONObject meta = new JSONObject();
                meta.put("name", name);
                meta.put("unit", pt.optString("unit", ""));
                vars.put(meta);
            }
            out.put("vars", vars);
            JSONObject ser = new JSONObject();
            for (Map.Entry<String, List<double[]>> e : series.entrySet()) {
                JSONArray pa = new JSONArray();
                for (double[] p : e.getValue()) pa.put(new JSONArray().put((long) p[0]).put(p[1]));
                ser.put(e.getKey(), pa);
            }
            out.put("series", ser);
            out.put("count", vars.length());
            out.put("source", "cloud");
            out.put("hours", hours);
        } catch (Exception e) {
            try {
                out.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private JSONObject accJson(Account a) throws Exception {
        JSONObject o = new JSONObject();
        o.put("name", a.name);
        o.put("account", a.account);
        o.put("password", a.password);
        o.put("platform_id", a.platformId);
        o.put("enabled", a.enabled);
        JSONArray kws = new JSONArray();
        for (String k : a.keywords()) kws.put(k);
        o.put("station_kw", kws);
        return o;
    }

    private JSONObject ok(String msg, List<Account> rows) throws Exception {
        JSONArray arr = new JSONArray();
        for (Account x : rows) arr.put(accJson(x));
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("msg", msg);
        o.put("accounts", arr);
        return o;
    }

    private JSONObject fail(String msg) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", false);
        o.put("msg", msg);
        return o;
    }

    /**
     * 把 JSON 数组拼成顿号分隔的字符串。【v0.20】
     * 空数组直接给空串 —— 这正是「[] 删不掉」的正解：
     * 什么都不填就是不过滤，而不是往表里写两个方括号。
     */
    private static String joinArray(JSONArray ja) {
        if (ja == null || ja.length() == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < ja.length(); i++) {
            String v = ja.optString(i, "").trim();
            if (v.isEmpty()) continue;
            if (sb.length() > 0) sb.append("、");
            sb.append(v);
        }
        return sb.toString();
    }

    private String saveDirText() {
        return ShotStore.displayPath();
    }

    /** 整个文件读成字节数组，给 viewShot 转 base64 用。 */
    private static byte[] readAll(File f) {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(
                    (int) Math.max(8192L, f.length()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    /** 人话版保存位置说明，界面上直接显示，省得用户看路径猜。 */
    private String saveDirHint() {
        return ShotStore.displayHint();
    }

    /** 是否已拿到「所有文件访问」授权（有则截图落根目录，没有则落「下载」目录）。 */
    private boolean hasAllFilesAccess() {
        return ShotStore.hasAllFiles();
    }

    /** 跳到系统「所有文件访问」设置页。 */
    private void openAllFilesSettings() {
        try {
            Intent it = new Intent();
            if (Build.VERSION.SDK_INT >= 30) {
                it.setAction("android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION");
                it.setData(Uri.parse("package:" + getPackageName()));
            } else {
                it.setAction("android.settings.APPLICATION_DETAILS_SETTINGS");
                it.setData(Uri.parse("package:" + getPackageName()));
            }
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
        } catch (Exception e) {
            try {
                Intent it2 = new Intent("android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION");
                it2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(it2);
            } catch (Exception e2) {
                Toast.makeText(this, "请到 设置→应用→有人云巡站→权限 手动开启",
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    // ---------------- 导出 ----------------

    /**
     * 导出图片：直接把 PNG 交给系统分享，不打包成 zip。
     * 用户要的是"把图发出去"，压缩包还得自己再解一次。
     *
     * 【v0.10 修正 v0.09 的错误归因】
     * v0.09 我把「导出失败：Value [/storageVemulatedV0V...」判成
     * FileProvider 的 canonical path 匹配失败，于是把文件先复制到
     * cacheDir 再分享——但真机报错一字不差，���明那个判断是错的。
     * 真根因是上一步的 `new JSONObject(arrayString)` 参数解析就抛了，
     * 压根没进到这个方法。详见 Bridge.exportImages 的注释。
     *
     * 下面这套分享流程本身是照 Android 7.0+ 的正确做法加固过的，
     * 保留（比 v0.08 那版稳），但它当初并不是修好这个 bug 的原因：
     *   1) 先复制到 cacheDir/export/ 再生成 Uri——绕开 emulated 存储上
     *      `<external-path>` 的 canonical 比对问题（这个隐患确实存在）
     *   2) chooser 自身也要 addFlags(FLAG_GRANT_READ_URI_PERMISSION)
     *   3) 补 ClipData，Android 7.0+ 靠它把读权限传给接收方，
     *      否则微信会提示「文件不存在」
     */
    private void doExportImages(JSONArray arr) {
        try {
            if (arr == null || arr.length() == 0) {
                toast("没有可导出的截图");
                return;
            }

            // 分享用副本放 cacheDir/export/，源文件（对外目录/私有目录）不动
            File shareDir = new File(getCacheDir(), "export");
            if (shareDir.exists()) Core.deleteTree(shareDir);
            if (!shareDir.mkdirs()) {
                toast("无法准备分享目录：" + shareDir.getAbsolutePath());
                return;
            }

            ArrayList<Uri> uris = new ArrayList<>();
            ArrayList<String> missing = new ArrayList<>();
            int seq = 0;
            for (int i = 0; i < arr.length(); i++) {
                String p = arr.optString(i, "");
                if (p.isEmpty()) continue;
                File src = new File(p);
                if (!src.exists()) { missing.add(src.getName()); continue; }
                try {
                    // 同名设备可能重复（不同账号下），加序号避免互相覆盖
                    File dst = new File(shareDir, String.format("%03d_%s", ++seq, src.getName()));
                    if (!copyFile(src, dst)) { missing.add(src.getName()); continue; }
                    uris.add(FileProvider.getUriForFile(
                            this, getPackageName() + ".fileprovider", dst));
                } catch (Throwable t) {
                    Core.log("[导出] 跳过 " + src.getName() + "：" + t);
                    missing.add(src.getName());
                }
            }

            if (uris.isEmpty()) {
                toast("截图文件都读不到了，请重新巡站");
                Core.log("[导出] 全部失败：" + missing);
                return;
            }

            Intent it = new Intent(Intent.ACTION_SEND_MULTIPLE);
            /* ★ MIME 必须是 image/*，不能是 image/png。
             *
             * 【v0.24 修】用户实测 9 张图分享到微信，微信直接弹
             * 「分享失败，多文件分享受支持图片格式」。
             * 根因就在这一行：微信对 ACTION_SEND_MULTIPLE 是按 type
             * **前缀**判「是不是图片」的，image/png 前缀是 image/，
             * 理论上没问题 —— 但微信的实现是拿 type 跟 "image/*"
             * 做全等比较（它内部按单图分享的分支去走，
             * type 不全等就落进「多文件只支持图片格式」那个提示）。
             * 改成 image/* 后微信才把它当多图分享处理。
             * 这是各家 IM 的通病：不要相信「子类型更精确所以更好」。 */
            it.setType("image/*");
            it.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            it.putExtra(Intent.EXTRA_SUBJECT, "有人云巡站截图 " + uris.size() + " 张");
            int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
            it.addFlags(flags);
            /* ★ ClipData 必须把**每一个** URI 都装进去。
             *
             * 【v0.24 修】原来只放了 uris.get(0)：
             *   it.setClipData(ClipData.newRawUri("巡站截图", uris.get(0)));
             * Android 7.0+ 靠 ClipData 把读授权传给接收方，
             * 只授权第 0 个 → 微信能读到第 1 张、读不到后面 8 张，
             * 表现为「分享失败」或只收到一张。
             * addItem 逐个补齐才是正确写法。 */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                ClipData cd = ClipData.newRawUri("巡站截图", uris.get(0));
                for (int i = 1; i < uris.size(); i++) {
                    cd.addItem(new ClipData.Item(uris.get(i)));
                }
                it.setClipData(cd);
            }
            /* chooser 标题里的数量要说清楚，让用户知道分批发 */
            Intent chooser = Intent.createChooser(it,
                    "导出图片（" + uris.size() + " 张）");
            chooser.addFlags(flags);
            /* 一些 IM 读的是 chooser 上的 ClipData，不是目标 intent 的 */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                ClipData cd = ClipData.newRawUri("巡站截图", uris.get(0));
                for (int i = 1; i < uris.size(); i++) {
                    cd.addItem(new ClipData.Item(uris.get(i)));
                }
                chooser.setClipData(cd);
            }
            startActivity(chooser);
            Core.log("[导出] 已发起分享 " + uris.size() + " 张，type=image/*");

            if (!missing.isEmpty()) {
                toast("已导出 " + uris.size() + " 张，" + missing.size() + " 张读不到已跳过");
            }
        } catch (Exception e) {
            Core.log("[导出] 失败：" + e);
            toast("导出失败：" + e.getMessage());
        }
    }

    /** 复制单个文件，失败返回 false（不抛，避免一次坏文件毁掉整批导出）。 */
    private boolean copyFile(File src, File dst) {
        FileInputStream in = null;
        FileOutputStream out = null;
        try {
            in = new FileInputStream(src);
            out = new FileOutputStream(dst);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) { }
            try { if (out != null) out.close(); } catch (Exception ignored) { }
        }
    }

    private void doExport(String zipName) {
        try {
            File outDir = getExternalFilesDir(null);
            File src = null;
            if (outDir != null) {
                src = new File(outDir, zipName);
            }
            if (src == null || !src.exists()) {
                toast("压缩包不存在：" + zipName);
                return;
            }
            Intent it = new Intent(Intent.ACTION_SEND);
            it.setType("application/zip");
            Uri uri;
            try {
                uri = androidx.core.content.FileProvider.getUriForFile(
                        MainActivity.this, getPackageName() + ".fileprovider", src);
            } catch (Throwable t) {
                uri = Uri.fromFile(src);
            }
            it.putExtra(Intent.EXTRA_STREAM, uri);
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(it, "导出照片"));
        } catch (Exception e) {
            toast("导出失败：" + e.getMessage());
        }
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    /* 【v0.23 修问题 1】返回键之前是：
     *     if (web.canGoBack()) web.goBack(); else super.onBackPressed();
     *
     * 那是浏览器网页的逻辑，但这是个单页 WebView ——
     * 页签切换全是前端改 G.tab 重新渲染 DOM，WebView 从头到尾只加载过一个
     * index.html，canGoBack() 永远是 false。
     * 于是「else」分支永远命中，用户在任何页面按返回都是直接 finish 回桌面，
     * 反馈是「在非第一页执行返回命令会直接回到手机桌面」。
     *
     * 正确做法：把返回键的判断权交给前端 ——
     * 1) 有弹窗开着 → 关弹窗；
     * 2) 不在第一个页签 → 退回上一个页签（页签历史栈）；
     * 3) 都在第一个页签了 → 才真正退出。
     * 前端 onNativeBack() 返回 'exit' 时才 finish。 */
    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        try {
            web.evaluateJavascript(
                    "(function(){try{return window.onNativeBack?window.onNativeBack():'exit'}"
                            + "catch(e){return 'exit'}})()",
                    value -> {
                        String v = value == null ? "" : value.replaceAll("^\"|\"$", "").trim();
                        if (!"exit".equals(v)) return;   /* 前端自己处理了 */
                        MainActivity.this.finish();
                    });
        } catch (Exception e) {
            super.onBackPressed();
        }
    }
}
