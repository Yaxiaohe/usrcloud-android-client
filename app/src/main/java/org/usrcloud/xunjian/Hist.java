package org.usrcloud.xunjian;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 历史数据（移植自电脑版 watch_engine.local_history / history）。
 *
 * 两个来源：
 *   local 读本地监控记录 CSV —— 监控每轮自动落盘，不花平台请求
 *   cloud 走有人云历史库接口 —— 按需拉取，能取到更早的数据
 */
public class Hist {

    public static final String REC_PREFIX = "监控记录_";
    public static final String MAN_PREFIX = "历史数据_";

    /* ==================================================================
     * 【v0.28】写入瘦身：值没变就不写，但要留心跳
     *
     * 原来的写法是「每轮巡检，每台设备的每个变量都写一行」——
     * 15 分钟一轮 × 96 轮/天，46 个站点 × 5 个变量，一天就是三万多行；
     * 而其中绝大多数行的值跟上一行一字不差（供暖季水温一天才波动几度）。
     * 一行 130 多字节里，80% 是每行重复携带的账号/设备名/变量名，
     * 于是文件以每天 3MB、每月 90MB 的速度涨。
     *
     * 现在改成：值跟上次一样、且没到心跳时间，就不写。
     * 判定规则在 Sample（零依赖，好单独跑测试）。
     *
     * 【为什么必须配心跳，以及为什么是 2 小时】
     * 只做「变化才写」有个隐蔽的坑：折线图要两个点才画得出线
     * （pack() 里 pa.length() < 2 直接跳过）。一个温度常年不变的站点，
     * 按变化才写就只有开机那一行，曲线直接从图上消失 —— 那就是「影响图表」。
     * 所以 Sample 里加了保底写入。间隔定 1 小时是拿真实数据实测出来的：
     * 15 分钟一轮时，30 分钟心跳让稳定期每两轮必写一次，整体只省 31.8%；
     * 1 小时心跳稳定期 24 行/天（原 96 行），省 75%。
     * 心跳只作用于「值一字未变」的行，值一变下一轮立刻写，不影响数值。
     * 硬约束（不短于 1 小时最大轮询、6 小时窗口留得出 2 个点）写在 Sample 里，
     * 改动会被 jhisttest 拦下。
     * ================================================================== */

    /* 上次写入的值和时间，key = 账号|设备编号|变量名。
       只活在内存里：进程重启后为空，重启第一轮会全量写一次当基线，
       之后重新进入瘦写模式。代价是每次重启多写一轮（约 30KB），可以接受。 */
    private static final Map<String, String> lastVal = new java.util.HashMap<>();
    private static final Map<String, Long> lastTs = new java.util.HashMap<>();

    private static File histDir() {
        File d = new File(Core.rootDir(), "历史数据");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static final SimpleDateFormat TS =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);

    /** 巡检结果落盘：一行一个 (时间,账号,设备名称,设备编号,变量,值)。 */
    public static synchronized void record(String acc, String devNo, String devName,
                                           List<String[]> rows) {
        try {
            String mon = new SimpleDateFormat("yyyy-MM", Locale.CHINA).format(new Date());
            File f = new File(histDir(), REC_PREFIX + mon + ".csv");
            boolean needHeader = !f.exists() || f.length() == 0;
            String ts = TS.format(new Date());
            long now = System.currentTimeMillis();

            StringBuilder sb = new StringBuilder();
            int skipped = 0;
            for (String[] r : rows) {
                if (r.length < 5) continue;
                String val = r[4] == null ? "" : r[4].trim();
                if (val.isEmpty() || val.equals("-")) continue;
                String varName = r[1] == null ? "" : r[1];
                String key = acc + "|" + devNo + "|" + varName;
                /* 【v0.28】值没变且没到心跳时间 → 跳过这一行 */
                if (!Sample.needWrite(lastVal, lastTs, key, val, now)) {
                    skipped++;
                    continue;
                }
                sb.append(ts).append(',')
                  .append(q(acc)).append(',')
                  .append(q(devName)).append(',')
                  .append(q(devNo)).append(',')
                  .append(q(varName)).append(',')
                  .append(q(val)).append("\r\n");
                /* 写进缓冲后才记账：写失败的话下一轮还会重试这一行 */
                Sample.mark(lastVal, lastTs, key, val, now);
            }
            /* 一行都不用写就别碰文件了 —— 连表头判断都省掉，
               稳定期这个文件可能几个小时都不会被打开一次。 */
            if (sb.length() == 0) return;

            OutputStreamWriter w = new OutputStreamWriter(
                    new FileOutputStream(f, true), "UTF-8");
            if (needHeader) {
                // 手动加 BOM，Excel 打开不乱码
                w.write("﻿");
                w.write("时间,账号,设备名称,设备编号,变量,值\r\n");
            }
            w.write(sb.toString());
            w.flush();
            w.close();
            if (skipped > 0) {
                Core.log("[历史] 本轮值未变跳过 " + skipped + " 行");
            }
        } catch (Exception e) {
            Core.log("[历史] 落盘失败: " + e.getMessage());
        }
    }

    private static String q(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"") || s.contains("\n")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }

    /** 手动把当前监控状态另存一份（区别于巡检自动落盘）。 */
    public static void saveNow() {
        List<Watch.DevState> list;
        synchronized (Watch.states) {
            list = new ArrayList<>(Watch.states.values());
        }
        if (list.isEmpty()) {
            Core.log("[历史] 当前没有监控数据可保存");
            return;
        }
        String mon = new SimpleDateFormat("yyyy-MM", Locale.CHINA).format(new Date());
        File f = new File(histDir(), MAN_PREFIX + mon + ".csv");
        int n = 0;
        try {
            OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(f, false), "UTF-8");
            w.write("﻿");
            w.write("时间,账号,设备名称,设备编号,变量,值\r\n");
            String ts = TS.format(new Date());
            for (Watch.DevState s : list) {
                for (String[] r : s.rows) {
                    if (r.length < 5) continue;
                    String val = r[4] == null ? "" : r[4].trim();
                    if (val.isEmpty() || val.equals("-")) continue;
                    w.write(ts + "," + q(s.acc) + "," + q(s.name) + "," + q(s.no)
                            + "," + q(r[1]) + "," + q(val) + "\r\n");
                    n++;
                }
            }
            w.flush();
            w.close();
            Core.log("[历史] 已保存 " + n + " 条到 " + f.getName());
        } catch (Exception e) {
            Core.log("[历史] 保存失败: " + e.getMessage());
        }
    }

    /**
     * 读本地记录。hours 上限 720（30 天），与电脑版一致。
     *
     * acc 为空 = 全部账号；devNo 为空 = 该账号下全部设备。
     * 跨设备汇总时同名变量会串（各站点的"供水水温"是不同设备的数据），
     * 所以变量名统一加「设备名·」前缀，保证一条线只对应一台设备。
     */
    public static JSONObject localHistory(String acc, String devNo, int hours) {
        hours = Math.max(1, Math.min(720, hours));
        boolean allAcc = acc == null || acc.trim().isEmpty();
        boolean allDev = devNo == null || devNo.trim().isEmpty();
        String startTs = TS.format(new Date(System.currentTimeMillis() - hours * 3600_000L));
        String startMon = startTs.substring(0, 7);

        Map<String, List<long[]>> series = new LinkedHashMap<>();
        Map<String, List<Double>> values = new LinkedHashMap<>();
        List<String> order = new ArrayList<>();

        File[] fs = histDir().listFiles();
        if (fs != null) {
            java.util.Arrays.sort(fs);
            for (File f : fs) {
                String fn = f.getName();
                if (!fn.endsWith(".csv")) continue;
                String mon;
                if (fn.startsWith(REC_PREFIX)) mon = fn.substring(REC_PREFIX.length(),
                        fn.length() - 4);
                else if (fn.startsWith(MAN_PREFIX)) mon = fn.substring(MAN_PREFIX.length(),
                        fn.length() - 4);
                else continue;
                if (mon.compareTo(startMon) < 0) continue;

                try {
                    BufferedReader r = new BufferedReader(
                            new InputStreamReaderUTF8(new FileInputStream(f)));
                    String header = r.readLine();
                    if (header == null) continue;
                    if (header.startsWith("﻿")) header = header.substring(1);
                    String[] hn = splitCsv(header);
                    int iT = idx(hn, "时间"), iA = idx(hn, "账号"),
                        iN = idx(hn, "设备名称"), iD = idx(hn, "设备编号"),
                        iV = idx(hn, "变量"), iX = idx(hn, "值");
                    if (iT < 0 || iA < 0 || iD < 0 || iV < 0 || iX < 0) continue;
                    String line;
                    while ((line = r.readLine()) != null) {
                        if (line.isEmpty()) continue;
                        String[] c = splitCsv(line);
                        if (c.length <= Math.max(iT, Math.max(iA, Math.max(iD,
                                Math.max(iV, iX))))) continue;
                        if (!allAcc && !c[iA].trim().equals(acc)) continue;
                        if (!allDev && !c[iD].trim().equals(devNo)) continue;
                        if (c[iT].compareTo(startTs) < 0) continue;
                        String val = c[iX].trim();
                        if (val.isEmpty() || val.equals("-")) continue;
                        Double d = Watch.parseNum(val);
                        if (d == null) continue;
                        long ts;
                        try {
                            ts = TS.parse(c[iT].trim()).getTime();
                        } catch (Exception e) {
                            continue;
                        }
                        String name = c[iV].trim();
                        /* 跨设备汇总时加设备名前缀，防止同名变量互相串线 */
                        if (allDev) {
                            String dn = iN >= 0 && iN < c.length ? c[iN].trim() : "";
                            if (dn.isEmpty()) dn = c[iD].trim();
                            name = dn + "·" + name;
                        }
                        if (!series.containsKey(name)) {
                            series.put(name, new ArrayList<>());
                            values.put(name, new ArrayList<>());
                            order.add(name);
                        }
                        series.get(name).add(new long[]{ts, 0L});
                        values.get(name).add(d);
                    }
                    r.close();
                } catch (Exception ignored) {
                }
            }
        }

        return pack(series, values, order, hours, "local");
    }

    /**
     * 【v0.33】温度类变量排前面，其余保持原有相对顺序。
     *
     * <p>判定只认变量名里的「温度」两个字，以及用户可能写的同义词
     * （Temp / ℃ / 度）—— 供暖场景里凡是带这些的，测的都是温度。
     * 刻意不按单位判定：水流量、压力的单位在数据里才看得到，
     * 而 pack 拿到的 order 只有名字；按名字判更稳、也不会误伤。
     *
     * <p>稳定分组：温度组内部不重排，用户熟悉的相邻关系保持不变。
     */
    static List<String> sortTempFirst(List<String> order) {
        List<String> tmp = new ArrayList<>();
        List<String> rest = new ArrayList<>();
        for (String n : order) {
            if (isTempVar(n)) tmp.add(n); else rest.add(n);
        }
        tmp.addAll(rest);
        return tmp;
    }

    /** 变量名里是否含温度相关字样。 */
    static boolean isTempVar(String name) {
        if (name == null) return false;
        String s = name.trim().toLowerCase(Locale.CHINA);
        return s.contains("温度") || s.contains("temp") || s.contains("℃")
                || s.contains("°c") || s.contains("度");
    }

    private static JSONObject pack(Map<String, List<long[]>> series,
                                   Map<String, List<Double>> values,
                                   List<String> order, int hours, String source) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("hours", hours);
            o.put("source", source);
            /* 【v0.33】温度类变量排前面。
             * 用户反馈「和温度相关的变量排序优先」——
             * order 原本是变量在记录里**首次出现**的时间顺序，
             * 于是一台 17 个变量的热泵机组，头几个位置被
             * 水流量、定时运行使能、启动信号这类占满，
             * 用户最关心的出/回水温度反而要往下翻，甚至落在
             * 「图表只列前 N 个」的截断范围之外。
             * 现在稳定分组：温度组在前，组内保持原有时间顺序，
             * 温度组内部不乱（不然用户熟悉的相邻关系就变了）。 */
            List<String> sorted = sortTempFirst(order);
            JSONArray vars = new JSONArray();
            JSONObject ser = new JSONObject();
            for (String name : sorted) {
                List<long[]> ts = series.get(name);
                List<Double> vs = values.get(name);
                JSONArray pa = new JSONArray();
                for (int i = 0; i < ts.size(); i++) {
                    // 同一时间戳去重（本地文件区间可能重叠）
                    if (i > 0 && ts.get(i)[0] == ts.get(i - 1)[0]) continue;
                    pa.put(new JSONArray().put(ts.get(i)[0]).put(vs.get(i)));
                }
                if (pa.length() < 2) continue;   // 只有一个点画不出折线
                JSONObject meta = new JSONObject();
                meta.put("name", name);
                meta.put("unit", unitOf(name, vs));
                vars.put(meta);
                ser.put(name, pa);
            }
            o.put("vars", vars);
            o.put("series", ser);
            o.put("count", vars.length());
        } catch (Exception e) {
            try {
                o.put("ok", false);
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o;
    }

    private static String unitOf(String name, List<Double> vs) {
        // 变量名可能被拼了「设备名·」前缀，只看后半段，避免设备名里的字干扰判断
        String n = name;
        int dot = name.lastIndexOf('·');
        if (dot >= 0 && dot < name.length() - 1) n = name.substring(dot + 1);
        if (n.contains("温")) return "℃";
        if (n.contains("压")) return "kpa";
        return "";
    }

    private static int idx(String[] arr, String name) {
        for (int i = 0; i < arr.length; i++) {
            if (arr[i].trim().equals(name)) return i;
        }
        return -1;
    }

    /** 支持引号的 CSV 行拆分。 */
    static String[] splitCsv(String line) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean q = false;
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (ch == '"') q = !q;
            else if (ch == ',' && !q) {
                out.add(cur.toString());
                cur.setLength(0);
            } else cur.append(ch);
        }
        out.add(cur.toString());
        return out.toArray(new String[0]);
    }

    /** 极简 UTF-8 Reader（BOM 已在上面手工处理，这里只做解码）。 */
    static class InputStreamReaderUTF8 extends java.io.InputStreamReader {
        InputStreamReaderUTF8(FileInputStream in) {
            super(in, java.nio.charset.Charset.forName("UTF-8"));
        }
    }

    /**
     * 本地落盘里出现过哪些设备（跨账号一次列全）。【v0.28】
     *
     * 【为什么要有这个】
     * 原来要看某台设备的曲线，得先「选账号 → 读取设备 → 选设备」三步，
     * 而「读取设备」是走平台 devices 接口拉全量设备——不发请求还列不出来。
     * 可本地 CSV 里本就记着账号/设备名/设备编号，直接从文件里提就行：
     *   - 不发平台请求，不耗额度
     *   - 列出来的保证有数据（不会出现点进去一张空图）
     *   - 能顺带报出每台最后一次记录的时间，用户一眼看出哪台是活的
     * 于是看曲线从三步压到两步：点「选择设备」→ 点设备。
     *
     * @return [{acc, name, no, last(最后记录时间), n(记录条数)}]，按 last 倒序
     */
    public static JSONArray devicesJson() {
        JSONArray arr = new JSONArray();
        Map<String, JSONObject> map = new LinkedHashMap<>();
        File[] fs = histDir().listFiles();
        if (fs == null) return arr;
        java.util.Arrays.sort(fs);
        for (File f : fs) {
            String fn = f.getName();
            if (!fn.endsWith(".csv")) continue;
            if (!fn.startsWith(REC_PREFIX) && !fn.startsWith(MAN_PREFIX)) continue;
            try {
                BufferedReader r = new BufferedReader(
                        new InputStreamReaderUTF8(new FileInputStream(f)));
                String header = r.readLine();
                if (header == null) {
                    r.close();
                    continue;
                }
                if (header.startsWith("﻿")) header = header.substring(1);
                String[] hn = splitCsv(header);
                int iT = idx(hn, "时间"), iA = idx(hn, "账号"),
                    iN = idx(hn, "设备名称"), iD = idx(hn, "设备编号"),
                    iX = idx(hn, "值");
                if (iT < 0 || iA < 0 || iD < 0 || iX < 0) {
                    r.close();
                    continue;
                }
                /* 行里最长的下标决定最少要几列；iN 可能是 -1（老文件没这列） */
                int need = Math.max(iT, Math.max(iA, Math.max(iD, Math.max(iX, iN))));
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.isEmpty()) continue;
                    String[] c = splitCsv(line);
                    if (c.length <= need) continue;
                    String acc = c[iA].trim(), no = c[iD].trim(), ts = c[iT].trim();
                    if (acc.isEmpty() || no.isEmpty()) continue;
                    String key = acc + "|" + no;
                    JSONObject o = map.get(key);
                    if (o == null) {
                        o = new JSONObject();
                        o.put("acc", acc);
                        o.put("no", no);
                        o.put("name", iN >= 0 ? c[iN].trim() : "");
                        o.put("last", ts);
                        o.put("n", 1);
                        map.put(key, o);
                    } else {
                        o.put("n", o.optInt("n", 0) + 1);
                        /* 时间戳是 yyyy-MM-dd HH:mm:ss，直接比字符串就是比先后 */
                        if (ts.compareTo(o.optString("last", "")) > 0) {
                            o.put("last", ts);
                            if (iN >= 0 && !c[iN].trim().isEmpty()) o.put("name", c[iN].trim());
                        }
                    }
                }
                r.close();
            } catch (Exception ignored) {
                // 单个文件读坏不影响其他文件
            }
        }
        List<JSONObject> list = new ArrayList<>(map.values());
        java.util.Collections.sort(list, new java.util.Comparator<JSONObject>() {
            public int compare(JSONObject a, JSONObject b) {
                return b.optString("last", "").compareTo(a.optString("last", ""));
            }
        });
        for (JSONObject o : list) arr.put(o);
        return arr;
    }

    /** 本地有哪些历史文件（设置页展示用）。 */
    public static JSONArray filesJson() {
        JSONArray arr = new JSONArray();
        File[] fs = histDir().listFiles();
        if (fs == null) return arr;
        java.util.Arrays.sort(fs);
        for (File f : fs) {
            try {
                JSONObject o = new JSONObject();
                o.put("name", f.getName());
                o.put("size", f.length());
                String mon = f.getName().startsWith(REC_PREFIX)
                        ? f.getName().substring(REC_PREFIX.length(), f.getName().length() - 4)
                        : "";
                o.put("month", mon);
                o.put("auto", f.getName().startsWith(REC_PREFIX));
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr;
    }

    /**
     * 按文件名清单删除历史文件。【v0.27】
     *
     * 【为什么按名单删，而不是「保留最近 N 个月」】
     * 落盘是按月一文件，膨胀速度和站点数、轮询间隔相关，
     * 用户看着每个文件多大再决定删哪个，比一个抽象的保留策略直观；
     * 而且手动保存的历史数据_*.csv 可能是用户特意留的底账，更不能替人做主。
     *
     * 【安全】文件名必须以两个已知前缀之一开头、.csv 结尾，
     * 且不含路径分隔符和 .. —— 名单来自前端，不能信。
     * 只删 histDir 直下的文件，不递归。
     */
    public static JSONObject clean(JSONArray names) {
        JSONObject o = new JSONObject();
        int deleted = 0;
        long freed = 0;
        try {
            File dir = histDir();
            for (int i = 0; i < names.length(); i++) {
                String name = names.optString(i, "");
                if (name.isEmpty()) continue;
                boolean okPrefix = name.startsWith(REC_PREFIX) || name.startsWith(MAN_PREFIX);
                if (!okPrefix || !name.endsWith(".csv")) continue;
                if (name.contains("/") || name.contains("\\") || name.contains("..")) continue;
                File f = new File(dir, name);
                /* canonical 校验双保险：拼出来的路径必须还在 histDir 直下 */
                if (!f.getParentFile().getCanonicalPath().equals(dir.getCanonicalPath())) {
                    continue;
                }
                long len = f.length();
                if (f.delete()) {
                    deleted++;
                    freed += len;
                    Core.log("[历史] 已清理 " + name);
                }
            }
            o.put("ok", true);
            o.put("deleted", deleted);
            o.put("freed", freed);
        } catch (Exception e) {
            try {
                o.put("ok", false);
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o;
    }
}
