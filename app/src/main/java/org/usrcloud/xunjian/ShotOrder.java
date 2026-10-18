package org.usrcloud.xunjian;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * 【v0.34】截图里变量的排布顺序：**水温相关排最前**。
 *
 * <p>为什么单独抽一个零依赖类：这个顺序直接决定截图上那 10 张卡片画的是谁，
 * 而且它还会**决定谁被截掉** —— Renderer 只画前 {@code Core.MAX_CARDS} 个变量。
 * 平台返回的变量顺序是「谁先建的谁在前」，于是一台 17 变量的热泵机组，
 * 前十个位置常被水流量、定时运行使能、启动信号占满，用户最关心的
 * 供水/回水温度反而落在截断之外 —— 截图发出去压根没有温度。
 *
 * <p>抽成纯函数（不碰 Android、不碰 org.json）后，{@code jshotordertest}
 * 可以直接跑真代码把每一档边界钉死，不用装到手机上肉眼比对。
 *
 * <p>排序规则（稳定分组，同档内保持平台原顺序 —— 用户熟悉的相邻关系不变）：
 * <ol>
 *   <li>rank 0：**水温** —— 变量名里既有「水」又有温度字样
 *       （水温 / 供水温度T1 / 回水温度T2 / 水箱温度 / 循环水温度）。</li>
 *   <li>rank 1：**其它温度** —— 室内温度、室外温度T4、湿度这类，
 *       判定口径与历史页 {@link Hist#isTempVar} 完全一致（同一个实现）。</li>
 *   <li>rank 2：其余（压力、水流量、使能、信号……）保持原顺序。</li>
 * </ol>
 *
 * <p>为什么按名字判而不按单位判：单位要解析每行第 5 列的字符串，
 * 空值、异常格式都得兜；名字是用户自己起的、也是用户认的，
 * 而且平台那批变量的顺序问题本来就出在名字上。
 */
public final class ShotOrder {

    /** 水温（供水/回水/水箱/循环水……）。 */
    public static final int RANK_WATER = 0;
    /** 其它温度（室内/室外/湿度等）。 */
    public static final int RANK_TEMP = 1;
    /** 其余变量。 */
    public static final int RANK_OTHER = 2;

    private ShotOrder() {
    }

    /**
     * 变量名里是否含温度相关字样。
     *
     * <p>和历史页同一个口径：「温度 / temp / ℃ / °c / 度」。
     * 这里刻意保留「度」这个宽口径 —— 供暖场景里带「度」的基本都是测温度，
     * 而历史页早已按这个口径排序，两处必须一致，否则同一台设备
     * 在历史页和截图上看到的先后顺序会打架。
     */
    public static boolean isTempVar(String name) {
        if (name == null) return false;
        String s = name.trim().toLowerCase(Locale.CHINA);
        return s.contains("温度") || s.contains("temp") || s.contains("℃")
                || s.contains("°c") || s.contains("度");
    }

    /**
     * 是否水温类（用户这次要排最前的那一类）。
     *
     * <p>判据：**带「水」且带温度字样**。
     * 「水流量」只有水没有温 → 不算；「室内温度」只有温没有水 → 不算；
     * 「供水温度T1」「回水温度」「水温」「水箱温度」「循环水温」→ 都算。
     *
     * <p>英文变量名（water temp / WaterTemperature）一并认。
     */
    public static boolean isWaterTemp(String name) {
        if (name == null) return false;
        String s = name.trim().toLowerCase(Locale.CHINA);
        boolean water = s.contains("水") || s.contains("water");
        boolean temp = s.contains("温") || s.contains("temp") || s.contains("℃");
        return water && temp;
    }

    /** 分档：0 水温 / 1 其它温度 / 2 其余。 */
    public static int rank(String name) {
        if (isWaterTemp(name)) return RANK_WATER;
        if (isTempVar(name)) return RANK_TEMP;
        return RANK_OTHER;
    }

    /**
     * 按 [水温 → 其它温度 → 其余] 重排，并只留前 {@code max} 个。
     *
     * <p>两个细节：
     * <ul>
     *   <li>**先排序再截断**（不是先截断再排序）—— 否则排在最前的那批
     *       早就被截掉了，等于没改；</li>
     *   <li>长度不足 5 列的空壳行直接扔掉：原来这种行会让 Renderer
     *       少画一张卡片（跳过后不再补位），空出来的位置白瞎。</li>
     * </ul>
     *
     * <p>用 {@link Collections#sort} 而不是自己写快排：它对相等元素是稳定的，
     * 同档内自然保持平台原顺序。
     *
     * @param rows 每行 [变量ID, 变量名称, 类型, 更新时间, 当前值, 操作]
     * @param max  最多返回几行（{@code <= 0} 视为不截断）
     */
    public static List<String[]> arrange(List<String[]> rows, int max) {
        List<String[]> src = new ArrayList<>();
        if (rows != null) {
            for (String[] r : rows) {
                if (r != null && r.length >= 5) src.add(r);
            }
        }
        Collections.sort(src, new Comparator<String[]>() {
            @Override
            public int compare(String[] a, String[] b) {
                return Integer.compare(rank(a[1]), rank(b[1]));
            }
        });
        if (max > 0 && src.size() > max) {
            return new ArrayList<>(src.subList(0, max));
        }
        return src;
    }
}
