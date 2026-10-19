package org.usrcloud.xunjian;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 【v0.36】置顶清单的通用文本层：解析 / 写回 / 校验 / 包含匹配。
 *
 * <p>为什么抽出来：v0.35 的「变量置顶」和 v0.36 的「站名置顶」是同一套东西 ——
 * 一行一个关键词、行序即优先级、按包含匹配名字。差别只有表头文字和存的文件名。
 * 两处各写一份的话，早晚会出现「变量那张表能带注释、站名这张不能」这种莫名其妙的不一致，
 * 而且改一处忘一处。
 *
 * <p>这里刻意不碰文件、不碰 Android：文件读写留在 {@code Core}，
 * 这样 {@code jvarordertest} / {@code jdevordertest} 能直接 javac 跑真代码验算。
 */
public final class PinList {

    /** 最多允许多少条。
     *  截图只画 10 张卡片、设备列表也就几十上百台，60 条留足余地又不至于失控。 */
    public static final int MAX_ITEMS = 60;

    /** 一条关键词最长多少字（超过基本是误粘贴了一整行）。 */
    public static final int MAX_LEN = 20;

    private PinList() {
    }

    // ------------------------------------------------------------------ 解析

    /**
     * 把 CSV 原文解析成关键词列表（行序 = 优先级）。
     *
     * <p>容错口径：
     * <ul>
     *   <li>跳过空行、{@code #} 开头的注释行；</li>
     *   <li>首行如果是表头（{@code header}）就跳过 —— 从 Excel 导出带表头的也能用；</li>
     *   <li>只取第一列，后面写备注不影响（{@code 出水,出水侧} 等价于 {@code 出水}）；</li>
     *   <li>重复关键词只留第一次出现的位置（行序就是优先级，重复没有意义）；</li>
     *   <li>最多保留 {@link #MAX_ITEMS} 条，多余的按顺序丢掉。</li>
     * </ul>
     */
    public static List<String> parse(String text, String header) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        String t = text.replace("\r\n", "\n").replace('\r', '\n');
        if (t.startsWith("\ufeff")) t = t.substring(1);

        boolean first = true;
        for (String line : t.split("\n")) {
            String raw = line.trim();
            if (raw.isEmpty() || raw.startsWith("#")) continue;
            String kw = firstCell(raw);
            boolean wasFirst = first;
            first = false;
            if (kw.isEmpty()) continue;
            if (wasFirst && kw.equals(header)) continue;      // 表头
            if (out.size() >= MAX_ITEMS) break;
            if (!containsIgnoreCase(out, kw)) out.add(kw);
        }
        return out;
    }

    /** 取 CSV 行第一列（去引号、去首尾空白）。 */
    static String firstCell(String line) {
        String s = line;
        if (s.startsWith("\"")) {
            StringBuilder sb = new StringBuilder();
            for (int i = 1; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '"') {
                    if (i + 1 < s.length() && s.charAt(i + 1) == '"') { sb.append('"'); i++; }
                    else break;
                } else sb.append(c);
            }
            return sb.toString().trim();
        }
        int c = s.indexOf(',');
        if (c >= 0) s = s.substring(0, c);
        return s.trim();
    }

    private static boolean containsIgnoreCase(List<String> list, String kw) {
        for (String x : list) if (x.equalsIgnoreCase(kw)) return true;
        return false;
    }

    /** 把关键词列表写成 CSV 原文（含表头、含 BOM，和 accounts.csv 一致）。 */
    public static String toText(List<String> items, String header) {
        StringBuilder sb = new StringBuilder();
        sb.append('\ufeff').append(header).append("\r\n");
        if (items != null) {
            int n = 0;
            for (String k : items) {
                if (k == null) continue;
                String v = k.trim();
                if (v.isEmpty()) continue;
                if (n >= MAX_ITEMS) break;
                sb.append(escape(v)).append("\r\n");
                n++;
            }
        }
        return sb.toString();
    }

    /**
     * 校验原文能不能存。
     *
     * @return 空串 = 通过；否则是给用户看的原因
     */
    public static String validate(String text, String header, String what) {
        if (text == null || text.trim().isEmpty()) return "内容为空";
        List<String> items = parse(text, header);
        if (items.isEmpty()) {
            return "没有解析出任何" + what + "（只写了表头和注释？）";
        }
        /* 【v0.36】逐条走一遍 warn：列表编辑器里能拦住的（太长、带逗号），
         * 原文编辑器也得拦住，否则同一个东西两个入口两种口径 ——
         * 用户会以为「原文框能存，那就是合法的」，存进去一条永远匹配不上的关键词。 */
        for (int i = 0; i < items.size(); i++) {
            String w = warn(items.get(i));
            if (!w.isEmpty()) return "第 " + (i + 1) + " 条：" + w;
        }
        int rows = 0;
        String t = text.replace("\r\n", "\n").replace('\r', '\n');
        for (String line : t.split("\n")) {
            String raw = line.trim();
            if (raw.isEmpty() || raw.startsWith("#")) continue;
            if (firstCell(raw).equals(header)) continue;
            rows++;
        }
        if (rows > MAX_ITEMS) {
            return what + "最多 " + MAX_ITEMS + " 条，当前 " + rows + " 条";
        }
        return "";
    }

    /** 一条关键词里不该有的东西。返回提示，没问题返回空串。 */
    public static String warn(String kw) {
        if (kw == null) return "";
        String v = kw.trim();
        if (v.isEmpty()) return "关键词不能为空";
        if (v.contains(",")) return "关键词里不要带逗号（会被拆成两列）";
        if (v.length() > MAX_LEN) {
            return "关键词太长（" + v.length() + " 字），建议不超过 " + MAX_LEN + " 字";
        }
        return "";
    }

    private static String escape(String s) {
        if (s.contains(",") || s.contains("\"") || s.contains("\n")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }

    // ------------------------------------------------------------------ 匹配

    /**
     * 名字命中的第一条关键词的下标，没命中返回 -1。
     *
     * <p>取**最靠前**的那条：一行关键词命中就够，用户排在最上面的优先。
     * 大小写不敏感（平台上有写 Temp 的）。
     */
    public static int indexOf(List<String> items, String name) {
        if (items == null || items.isEmpty() || name == null) return -1;
        String s = name.trim().toLowerCase(Locale.CHINA);
        if (s.isEmpty()) return -1;
        for (int i = 0; i < items.size(); i++) {
            String k = items.get(i);
            if (k == null) continue;
            String kk = k.trim().toLowerCase(Locale.CHINA);
            if (kk.isEmpty()) continue;
            if (s.contains(kk)) return i;
        }
        return -1;
    }
}
