package org.usrcloud.xunjian;

import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 在线更新的「判据」：零 Android 依赖，能在纯 JVM 上单独跑。
 *
 * 【为什么单独成类】和 Sample.java 一个道理 —— 版本比较、文件识名这些结论
 * 必须能脱离手机验算边界，不能靠肉眼看界面。
 */
public final class UpdateCheck {

    private UpdateCheck() {
    }

    /** 解析 update.conf：一行 key=value，# 开头是注释。 */
    public static Map<String, String> parseConf(String text) {
        Map<String, String> m = new HashMap<>();
        if (text == null) return m;
        for (String line : text.split("\\r?\\n")) {
            String s = line.trim();
            if (s.isEmpty() || s.startsWith("#")) continue;
            int i = s.indexOf('=');
            if (i <= 0) continue;
            m.put(s.substring(0, i).trim(), s.substring(i + 1).trim());
        }
        return m;
    }

    /**
     * 配了「查哪个仓库」才算这个包支持在线更新。
     * 没配的包（比如自己编译的）连按钮都不显示，也不发任何网络请求。
     */
    public static boolean configured(Map<String, String> c) {
        if (c == null) return false;
        String v = c.get("src");
        if (v == null || !"github".equals(v.trim())) return false;
        return safeRepo(c.get("repo"));
    }

    /** 仓库名写成 owner/repo，字符都要是安全字符，免得把地址拼歪。 */
    public static boolean safeRepo(String s) {
        if (s == null) return false;
        String v = s.trim();
        if (v.contains("..")) return false;
        return v.matches("[A-Za-z0-9_.-]{1,40}/[A-Za-z0-9_.-]{1,80}");
    }

    /** 只认 http/https。 */
    public static boolean aUrl(String s) {
        return s != null && (s.startsWith("http://") || s.startsWith("https://"));
    }

    /** 去掉版本号前面的 v：「v0.40.02」→「0.40.02」。界面显示和比较都用它。 */
    public static String stripTag(String tag) {
        if (tag == null) return "";
        String v = tag.trim();
        if (!v.isEmpty() && (v.charAt(0) == 'v' || v.charAt(0) == 'V')) v = v.substring(1);
        return v;
    }

    /**
     * 版本名拆成数字段：「v0.40.02」→ [0, 40, 2]。
     * 碰到非数字非点的字符（-beta 之类）就停，后面不再参与比较。
     */
    public static int[] versionParts(String name) {
        String v = stripTag(name);
        java.util.ArrayList<Integer> out = new java.util.ArrayList<>();
        int cur = 0;
        boolean has = false;
        for (int i = 0; i < v.length(); i++) {
            char ch = v.charAt(i);
            if (ch >= '0' && ch <= '9') {
                if (cur < 1000000) cur = cur * 10 + (ch - '0');
                has = true;
            } else if (ch == '.') {
                out.add(has ? cur : 0);
                cur = 0;
                has = false;
            } else {
                break;
            }
        }
        if (has) out.add(cur);
        int[] r = new int[out.size()];
        for (int i = 0; i < r.length; i++) r[i] = out.get(i);
        return r;
    }

    /**
     * 远端的版本名比本机新才返回 true。
     * 缺的段按 0 补：「0.40.02」与「v0.40」比，后者不算新 —— 那是同一次发布的两种写法。
     * 远端解析不出数字时一律不提示，宁可不更也不误报。
     */
    public static boolean versionNewer(String cur, String remote) {
        int[] a = versionParts(cur);
        int[] b = versionParts(remote);
        if (b.length == 0) return false;
        int n = Math.max(a.length, b.length);
        for (int i = 0; i < n; i++) {
            int x = i < a.length ? a[i] : 0;
            int y = i < b.length ? b[i] : 0;
            if (y > x) return true;
            if (y < x) return false;
        }
        return false;
    }

    /**
     * 失败提示。只说现象和怎么办，不出现任何地址、账号或内部编号。
     * 三种情况分开说，因为处理办法不一样：
     * <ul>
     *   <li>0 连不上：多半是被挡了，换网络（换 WiFi / 换流量）最有效；</li>
     *   <li>1 超时：网慢或线路抽风，过一会儿再点；</li>
     *   <li>2 被拒绝：对方嫌访问太频繁，等几小时自然恢复。</li>
     * </ul>
     */
    public static String failureHint(int kind) {
        if (kind == 1) {
            return "连接项目主页超时。换个网络再试，或者过一会儿再点。";
        }
        if (kind == 2) {
            return "项目主页暂时不让访问。过几个小时再试；也可以到项目主页的 Releases 里手动下载。";
        }
        return "连不上项目主页。换成流量或别的 WiFi 再试；也可以到项目主页的 Releases 里手动下载。";
    }

    /** 安装包名白名单：不许路径穿越，也不许塞别的文件。 */
    public static boolean safeName(String s) {
        if (s == null || s.isEmpty() || s.length() > 120) return false;
        if (!s.toLowerCase().endsWith(".apk")) return false;
        if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.contains("..")) return false;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
                    || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-'
                    || (ch >= 0x4e00 && ch <= 0x9fa5)) continue;
            return false;
        }
        return true;
    }

    /**
     * 旧安装包清理白名单：只要 .apk 后缀就认，不绑死某个文件名前缀 ——
     * 不同版本的文件名不一样，而这个目录是 App 私有的，里面只会有本 App 下载的包。
     * keep 是本次还要用的那个，不能删。
     */
    public static boolean shouldCleanApk(String name, String keep) {
        if (name == null || name.equals(keep)) return false;
        if (!name.toLowerCase().endsWith(".apk")) return false;
        if (name.length() > 120) return false;
        if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.contains("..")) return false;
        return true;
    }

    /**
     * 启动/检查更新时要留下哪一个：最近下载的那个。
     * 这样「刚下载好还没点安装，中途 App 被重启」不会把包清掉。
     * 只看白名单里的名字；时间相同按名字字典序取大的，结果确定、可验算。
     */
    public static String newestApk(String[] names, long[] times) {
        if (names == null) return "";
        String best = "";
        long bestT = Long.MIN_VALUE;
        for (int i = 0; i < names.length; i++) {
            String n = names[i];
            if (!shouldCleanApk(n, "")) continue;
            long t = (times == null || i >= times.length) ? 0L : times[i];
            if (t > bestT || (t == bestT && n.compareTo(best) > 0)) {
                bestT = t;
                best = n;
            }
        }
        return best;
    }

    /** 本地自然日，格式固定 yyyy-MM-dd。纯 JVM 上也能跑，方便验算。 */
    public static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date());
    }

    /**
     * 今天该不该自动查一次更新。
     * 只有「从来没查过」或「上次是今天以前」才查；同一天再进多少次都不查。
     * 日期拿不到或格式不对时宁可不查，也不退化成每次进 App 都查。
     */
    public static boolean shouldAutoCheck(String last, String today) {
        if (today == null || !today.matches("\\d{4}-\\d{2}-\\d{2}")) return false;
        return last == null || !last.equals(today);
    }

    /** 项目主页给的是「sha256:64位十六进制」；认不出就返回空，由调用方退一步看大小。 */
    public static String digestHex(String digest) {
        if (digest == null) return "";
        String s = digest.trim();
        int i = s.indexOf(':');
        if (i <= 0) return "";
        if (!"sha256".equalsIgnoreCase(s.substring(0, i).trim())) return "";
        String hex = s.substring(i + 1).trim().toLowerCase();
        if (hex.length() != 64) return "";
        for (int k = 0; k < hex.length(); k++) {
            char ch = hex.charAt(k);
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return "";
        }
        return hex;
    }

    public static String sha256Hex(byte[] b) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        byte[] v = d.digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : v) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    /**
     * 发布说明按纯文本给用户看：去掉代码块（里面多是校验值）、标题记号、
     * 加粗与反引号，列表换成圆点；太长就截断。
     */
    public static String plainNotes(String md) {
        if (md == null) return "";
        String s = md.replace("\r\n", "\n").replace("\r", "\n");
        s = s.replaceAll("(?s)```.*?```", "");
        s = s.replaceAll("(?m)^[ \t]*#{1,6}[ \t]*", "");
        s = s.replace("**", "").replace("`", "");
        s = s.replaceAll("(?m)^[ \t]*[-*+][ \t]+", "· ");
        s = s.replaceAll("\n{3,}", "\n\n");
        s = s.trim();
        if (s.length() > 600) s = s.substring(0, 600) + "…";
        return s;
    }
}
