package org.usrcloud.xunjian;

import java.util.ArrayList;
import java.util.List;

/** 设备实时数据：结构与桌面版 run_usrcloud.py 的 fetch_device_data_api 返回值一致。 */
public class DevData {
    /** 每行：[变量ID, 变量名称, 类型, 更新时间, 当前值, 操作] */
    public final List<String[]> rows = new ArrayList<>();
    public String org = "--";
    public String tpl = "--";
    public String gw = "--";
    public String addr = "--";
    public String platformOnline = "";

    /** 有数值且单位匹配温度/压力，才算「真的有数据」——与桌面版正则保持一致。 */
    private static boolean hasRealValue(String cur) {
        if (cur == null) return false;
        return cur.matches(".*\\d+(\\.\\d+)?\\s*(℃|kpa|bar).*");
    }

    private static long parseTime(String tm) {
        if (tm == null || tm.equals("-") || tm.isEmpty()) return -1;
        try {
            java.text.SimpleDateFormat f =
                    new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.CHINA);
            return f.parse(tm).getTime();
        } catch (Exception e) {
            return -1;
        }
    }

    /**
     * 判定在线状态。
     * 关键：平台只保留最后一次上报值，设备断线后旧值不会清空，
     * 所以不能只看「有没有数值」，必须看数据时间是否新鲜。
     */
    public String judgeStatus() {
        if (rows.isEmpty()) return "blank";
        boolean hasVal = false;
        long newest = -1;
        for (String[] r : rows) {
            if (r.length < 5) continue;
            String tm = r[3] == null ? "" : r[3].trim();
            String cur = r[4] == null ? "" : r[4].trim();
            if (hasRealValue(cur)) hasVal = true;
            long t = parseTime(tm);
            if (t > newest) newest = t;
        }
        if (!hasVal || newest < 0) return "offline";
        double ageMin = (System.currentTimeMillis() - newest) / 60000.0;
        return ageMin <= Core.STALE_MINUTES ? "online" : "stale";
    }

    /** 最新数据距今多少分钟；无有效时间返回 -1。 */
    public double ageMinutes() {
        long newest = -1;
        for (String[] r : rows) {
            if (r.length >= 4) {
                long t = parseTime(r[3] == null ? "" : r[3].trim());
                if (t > newest) newest = t;
            }
        }
        if (newest < 0) return -1;
        return (System.currentTimeMillis() - newest) / 60000.0;
    }

    public static String fmtAge(double minutes) {
        if (minutes < 0) return "无数据时间";
        if (minutes < 0.5) return "刚刚";
        if (minutes < 60) return String.format(java.util.Locale.CHINA, "%.0f 分钟前", minutes);
        if (minutes < 60 * 24)
            return String.format(java.util.Locale.CHINA, "%.1f 小时前", minutes / 60);
        return String.format(java.util.Locale.CHINA, "%.1f 天前", minutes / 60 / 24);
    }
}
