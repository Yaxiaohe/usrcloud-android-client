package org.usrcloud.xunjian;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 在线更新：检查版本 → 下载安装包 → 校验 → 交给系统安装器。
 *
 * <p>更新源是项目主页的 Releases：公开仓库，不登录、没有清单文件，
 * 版本号就是发布时的 tag，安装包就是那条发布里的 .apk。
 *
 * <p>三条硬约束（改之前先看清楚）：
 * <ol>
 *   <li><b>不许同步拉网</b>。Android.call 是 @JavascriptInterface 同步调用，
 *       在桥里发 HTTP 会把页面冻住。检查和下载都是「Start 起线程 + Poll 轮询」两段式，
 *       前端每 600ms 问一次，和单台重拍 reshootStart/reshootPoll 一个套路。</li>
 *   <li><b>必须带浏览器 UA</b>。默认 UA 会被一些网关直接挡成 403，
 *       登录接口能过、读文件却过不去，很难查。</li>
 *   <li><b>下载完必须核对摘要</b>。摘要对不上就删包，绝不交给安装器。</li>
 * </ol>
 *
 * <p>查哪个仓库只写在 assets/update.conf 里（打包时注入），
 * 不写进代码、不显示在界面、不写进日志。没配的包连按钮都不显示。
 */
public final class Update {

    private Update() {
    }

    /* 项目主页在海外，5 秒连不上就放弃会误判成「没网」：
       检查给 20 秒，下载给 60 秒。 */
    private static final int T_CHECK = 20000;
    private static final int T_DL = 60000;
    private static final String UA = "Mozilla/5.0 (Linux; Android 13) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    private static final String API = "https://api.github.com/repos/";

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();

    private static volatile JSONObject checkTask = null;
    private static volatile JSONObject dlTask = null;
    private static volatile int dlProgress = -1;
    private static volatile File apkFile = null;

    /** 这次查到的发布：下载必须沿用同一条，不能半路换地址。 */
    private static final class Probe {
        String url = "";
        String name = "";
        String sha256 = "";
        String version = "";
        String notes = "";
        long size = 0;
        int timeout = T_CHECK;
    }

    private static volatile Probe active = null;

    /** 能直接给用户看的一句话，不是技术异常。 */
    private static final class SoftError extends Exception {
        SoftError(String m) {
            super(m);
        }
    }

    private static JSONObject jput(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignored) {
        }
        return o;
    }

    private static Map<String, String> conf(Context ctx) {
        try {
            InputStream in = ctx.getAssets().open("update.conf");
            return UpdateCheck.parseConf(new String(readAll(in), "UTF-8"));
        } catch (Exception e) {
            return new java.util.HashMap<>();
        }
    }

    /** 包里没配更新源时，前端把这个入口藏起来。 */
    public static boolean enabled(Context ctx) {
        return UpdateCheck.configured(conf(ctx));
    }

    /**
     * 安装包都放在 App 自己的外部私有目录 updates/ 下：
     * /sdcard/Android/data/&lt;包名&gt;/files/updates/
     * 这个目录不用申请存储权限，卸载 App 时系统会一并带走。
     */
    private static File updateDir(Context ctx) {
        return new File(ctx.getExternalFilesDir(null), "updates");
    }

    /**
     * 清掉攒下来的旧安装包。只删 shouldCleanApk 认出来的普通文件，
     * keep 是本次还要用的那个；不整目录删，也不删目录本身。
     * 清理是顺手做的事，失败不许影响检查/下载主流程，所以异常一律吞掉。
     */
    public static int cleanOldApks(Context ctx, String keep) {
        try {
            File[] fs = updateDir(ctx).listFiles();
            if (fs == null) return 0;
            int n = 0;
            for (File one : fs) {
                if (!one.isFile()) continue;
                if (!UpdateCheck.shouldCleanApk(one.getName(), keep)) continue;
                if (one.delete()) n++;
            }
            return n;
        } catch (Throwable e) {
            return 0;
        }
    }

    /** 启动和检查更新时的清理口径：只留最近下载的那一个，其余全清。 */
    private static String newestKeep(Context ctx) {
        try {
            File[] fs = updateDir(ctx).listFiles();
            String[] names = new String[fs == null ? 0 : fs.length];
            long[] times = new long[names.length];
            for (int i = 0; i < names.length; i++) {
                names[i] = fs[i].getName();
                times[i] = fs[i].lastModified();
            }
            return UpdateCheck.newestApk(names, times);
        } catch (Throwable e) {
            return "";
        }
    }

    /** App 启动时在后台清一次；主线程不做文件 IO。 */
    public static void cleanOnStart(final Context ctx) {
        final Context app = ctx.getApplicationContext();
        POOL.execute(() -> cleanOldApks(app, newestKeep(app)));
    }

    /* 每天第一次进 App 自动查一次更新。
       只记「上次是哪天查的」。用一个私有目录里的小文本文件，不碰系统的偏好设置存储。 */
    private static final String DAILY_FILE = "update_daily.txt";

    /**
     * 今天还没查过就起一次检查，返回 true 表示真的起了。
     * 没配更新源的包直接跳过，不发网络请求。
     * 日期写不进去时宁可今天不查，也不变成每次进 App 都查。
     */
    public static boolean autoCheckDaily(Context ctx) {
        final Context app = ctx.getApplicationContext();
        if (!enabled(app)) return false;
        String today = UpdateCheck.today();
        if (!UpdateCheck.shouldAutoCheck(readDaily(app), today)) return false;
        if (!writeDaily(app, today)) return false;
        return checkStart(app) == null;
    }

    private static String readDaily(Context app) {
        try {
            File f = new File(app.getFilesDir(), DAILY_FILE);
            if (!f.isFile()) return "";
            return new String(readAll(new FileInputStream(f)), "UTF-8").trim();
        } catch (Throwable e) {
            return "";
        }
    }

    private static boolean writeDaily(Context app, String day) {
        try {
            File f = new File(app.getFilesDir(), DAILY_FILE);
            FileOutputStream fo = new FileOutputStream(f, false);
            try {
                fo.write(day.getBytes("UTF-8"));
            } finally {
                fo.close();
            }
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 当前装的版本名，用来和发布页的 tag 比。 */
    private static String curName(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        in.close();
        return bo.toByteArray();
    }

    private static HttpURLConnection open(String url, String method, String token, int timeout)
            throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        c.setRequestMethod(method);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", token);
        return c;
    }

    private static String http(String url, String method, String body, String token, int timeout)
            throws Exception {
        HttpURLConnection c = open(url, method, token, timeout);
        try {
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                java.io.OutputStream os = c.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.close();
            }
            int code = c.getResponseCode();
            InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
            String s = in == null ? "" : new String(readAll(in), "UTF-8");
            if (code < 200 || code >= 300) {
                throw new Exception("HTTP " + code + " " + s.substring(0, Math.min(60, s.length())));
            }
            return s;
        } finally {
            c.disconnect();
        }
    }

    /**
     * 读项目主页上最新的一条发布：版本号取 tag，安装包取那条里的 .apk。
     * 只读第一个带 .apk 的附件，发布时不要挂多个安装包。
     */
    private static Probe probe(Map<String, String> cf, int timeout) throws Exception {
        String repo = cf.get("repo");
        if (!UpdateCheck.safeRepo(repo)) throw new SoftError("这个版本没配好更新地址");

        String body;
        try {
            body = http(API + repo.trim() + "/releases/latest", "GET", null, null, timeout);
        } catch (Exception e) {
            String m = String.valueOf(e.getMessage());
            if (m.contains("HTTP 404")) throw new SoftError("项目主页上还没有发布版本");
            throw e;
        }
        JSONObject j = new JSONObject(body);
        String tag = j.optString("tag_name", "");
        if (tag.isEmpty()) throw new SoftError("发布页上没读到版本号");

        JSONObject pick = null;
        org.json.JSONArray as = j.optJSONArray("assets");
        for (int i = 0; as != null && i < as.length(); i++) {
            JSONObject a = as.optJSONObject(i);
            if (a == null) continue;
            String nm = a.optString("name", "");
            if (!UpdateCheck.safeName(nm)) continue;
            pick = a;
            break;
        }
        if (pick == null) throw new SoftError("这个版本还没挂安装包");

        Probe p = new Probe();
        p.timeout = timeout;
        p.url = pick.optString("browser_download_url", "");
        p.name = pick.optString("name", "");
        p.sha256 = UpdateCheck.digestHex(pick.optString("digest", ""));
        p.size = pick.optLong("size", 0);
        p.version = UpdateCheck.stripTag(tag);
        p.notes = UpdateCheck.plainNotes(j.optString("body", ""));
        if (!UpdateCheck.aUrl(p.url)) throw new SoftError("安装包地址不可用");
        return p;
    }

    private static boolean timeoutLike(Throwable e) {
        Throwable t = e;
        while (t != null) {
            String s = String.valueOf(t.getMessage()).toLowerCase();
            if (t instanceof java.net.SocketTimeoutException || s.contains("timed out")
                    || s.contains("timeout") || s.contains("failed to connect")) return true;
            t = t.getCause();
        }
        return false;
    }

    /** 起后台检查。返回 null = 已开始；非 null = 没开始的原因。 */
    public static String checkStart(final Context ctx) {
        if (checkTask != null && checkTask.optBoolean("running")) return "正在检查，请稍等";
        checkTask = jput(new JSONObject(), "running", true);
        final Context app = ctx.getApplicationContext();
        POOL.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                /* 每次检查顺手清一次旧安装包：只留最近下载的那个。 */
                cleanOldApks(app, newestKeep(app));
                Map<String, String> cf = conf(app);
                if (!UpdateCheck.configured(cf)) throw new SoftError("这个版本没有在线更新");

                Probe p = probe(cf, T_CHECK);
                boolean newer = UpdateCheck.versionNewer(curName(app), p.version);

                active = p;
                jput(out, "ok", true);
                jput(out, "newer", newer);
                jput(out, "version", p.version);
                jput(out, "size", p.size);
                jput(out, "name", p.name);
                /* 发布说明按纯文本给弹窗；太长在 UpdateCheck 里已经截过。 */
                jput(out, "notes", p.notes);
            } catch (Throwable e) {
                jput(out, "ok", false);
                jput(out, "hint", (e instanceof SoftError)
                        ? String.valueOf(e.getMessage()) : UpdateCheck.failureHint(timeoutLike(e)));
            }
            jput(out, "running", false);
            checkTask = out;
        });
        return null;
    }

    public static JSONObject checkPoll() {
        JSONObject o = checkTask;
        if (o != null) return o;
        return jput(jput(new JSONObject(), "ok", false), "running", false);
    }

    /** 起后台下载。返回 null = 已开始；非 null = 没开始的原因。 */
    public static String downloadStart(final Context ctx) {
        if (dlTask != null && dlTask.optBoolean("running")) return "正在下载，请稍等";
        final Probe p = active;
        if (p == null || !UpdateCheck.safeName(p.name)) return "请先检查更新";
        dlTask = jput(new JSONObject(), "running", true);
        dlProgress = -1;
        apkFile = null;
        final Context app = ctx.getApplicationContext();
        POOL.execute(() -> {
            JSONObject out = new JSONObject();
            File f = null;
            try {
                File dir = updateDir(app);
                if (!dir.exists() && !dir.mkdirs()) throw new SoftError("建不了下载目录");
                /* 下载新版前把攒下的旧包清掉，只留本次要下的这一个。 */
                cleanOldApks(app, p.name);
                f = new File(dir, p.name);
                if (f.exists() && !f.delete()) throw new SoftError("旧安装包清不掉");

                HttpURLConnection c = open(p.url, "GET", null, T_DL);
                try {
                    int code = c.getResponseCode();
                    if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
                    long total = c.getContentLength();
                    InputStream in = c.getInputStream();
                    FileOutputStream fo = new FileOutputStream(f);
                    try {
                        byte[] buf = new byte[16384];
                        int n;
                        long done = 0;
                        while ((n = in.read(buf)) > 0) {
                            fo.write(buf, 0, n);
                            done += n;
                            dlProgress = total > 0 ? (int) (done * 100 / total) : -1;
                        }
                    } finally {
                        fo.close();
                        in.close();
                    }
                } finally {
                    c.disconnect();
                }

                /* 摘要给了就核对摘要；没给就退一步核对大小。两条都过不去就删包。 */
                if (!p.sha256.isEmpty()) {
                    String got = UpdateCheck.sha256Hex(readAll(new FileInputStream(f)));
                    if (!p.sha256.equalsIgnoreCase(got)) {
                        f.delete();
                        throw new SoftError("安装包校验不通过，已删除");
                    }
                } else if (p.size > 0 && f.length() != p.size) {
                    f.delete();
                    throw new SoftError("安装包大小不符，已删除");
                }
                apkFile = f;
                dlProgress = 100;
                jput(out, "ok", true);
            } catch (Throwable e) {
                if (f != null && f.exists()) f.delete();
                jput(out, "ok", false);
                jput(out, "error", (e instanceof SoftError)
                        ? String.valueOf(e.getMessage()) : "下载失败，检查网络后重试");
            }
            jput(out, "running", false);
            dlTask = out;
        });
        return null;
    }

    public static JSONObject downloadPoll() {
        JSONObject o = dlTask;
        JSONObject r = o == null ? new JSONObject() : o;
        return jput(r, "progress", dlProgress);
    }

    /** 校验通过的安装包交给系统安装器。 */
    public static JSONObject install(Context ctx) {
        JSONObject o = new JSONObject();
        File f = apkFile;
        if (f == null || !f.exists()) {
            return jput(jput(o, "ok", false), "msg", "安装包还没下载好");
        }
        try {
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(it);
            return jput(o, "ok", true);
        } catch (Exception e) {
            return jput(jput(o, "ok", false), "msg", "打不开安装器：" + e.getMessage());
        }
    }
}
