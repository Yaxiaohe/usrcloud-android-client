package org.usrcloud.xunjian;

import java.util.Map;

/**
 * 历史数据采样判定：这一行到底该不该落盘。【v0.28】
 *
 * 【为什么单独成类，不写在 Hist 里】
 * Hist 通过 Core 依赖 Android（rootDir 要 Context），
 * 连带 Renderer / Watch 一整串，在纯 JVM 上编译不起来，
 * 这段逻辑就只能靠「复刻一份」来测（jwatchtest 就是这么干的，
 * 改了源码测试还不报错，等于没测）。
 * 抽出来以后不依赖任何 Android 类，jhisttest 直接跑真代码。
 *
 * 【规则】
 *   值变了                             → 写
 *   值没变，但距上次写入已过心跳间隔   → 也写（保住折线图的最少点数）
 *   其余                               → 不写
 *
 * 【心跳为什么是 1 小时】
 * 拿真实落盘数据（7632 行）实测过：相邻两行值不同的概率只有 18%，
 * 也就是说 82% 的行是纯重复（实测脚本 _simhist.py）。
 * 心跳越短省得越少：15 分钟一轮时，30 分钟心跳让稳定期每两轮必写一次，
 * 全量实测只省 31.8%；1 小时心跳稳定期 24 行/天（原 96 行），省 75%。
 * 再往上加到 2 小时会更省（87.5%），但 6 小时窗口只剩 3 个点，
 * 看起来太糙，用户拍板取 1 小时：6 小时窗口 6 个点，24 小时 24 个点。
 *
 * 【心跳不会让数值失真】
 * 心跳只作用在「值跟上次一字不差」的行上。值只要变了，下一轮立刻写，
 * 跟心跳没关系；所以心跳长短影响的是稳定期的点有多密，不影响数值。
 *
 * 【两条硬约束，谁改谁测试挂】
 *   1. 必须 >= App 最大轮询间隔（1 小时）—— 心跳要是比巡检间隔还短，
 *      等于每一轮都触发心跳，优化直接失效。
 *      （正好取等于：1 小时轮询那档确实省不下来，但那一档本身
 *        一天才 24 轮，已经是 15 分钟档的四分之一，可以接受。）
 *   2. 必须 <= 3 小时 —— 图表最短范围是 6 小时，
 *      3 小时是「6 小时窗口里还剩 2 个点」的极限，再长曲线就画不出来
 *      （pack() 里 pa.length() < 2 会整条跳过）。
 */
public final class Sample {

    /** 值一直没变时的保底写入间隔。改这个值前先看上面的两条硬约束。 */
    public static final long HEARTBEAT_MS = 60 * 60 * 1000L;

    /** App 可选的最大轮询间隔。心跳必须比它长，否则优化失效。 */
    public static final long MAX_POLL_MS = 60 * 60 * 1000L;

    /** 图表最短查询窗口。心跳必须留得出至少两个点。 */
    public static final long MIN_WINDOW_MS = 6 * 60 * 60 * 1000L;

    private Sample() {
    }

    /**
     * @param vals  各变量上次写入的值（key = 账号|设备编号|变量名）
     * @param times 各变量上次写入的时刻
     * @param now   本轮巡检时刻
     */
    public static boolean needWrite(Map<String, String> vals, Map<String, Long> times,
                                    String key, String val, long now) {
        String prev = vals.get(key);
        if (prev == null || !prev.equals(val)) return true;
        Long t = times.get(key);
        return t == null || (now - t) >= HEARTBEAT_MS;
    }

    /** 记一笔：只有真正写入后才调用，写失败的行下一轮还会重试。 */
    public static void mark(Map<String, String> vals, Map<String, Long> times,
                            String key, String val, long now) {
        vals.put(key, val);
        times.put(key, now);
    }
}
