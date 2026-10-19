package org.usrcloud.xunjian;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 【v0.36】站名置顶清单 —— 「我的 → 置顶站名」里那份表。
 *
 * <p>要解决的问题：46 个站点、上百台机组，用户真正天天盯的就那么几台
 * （出问题的那台、正在调试的那台）。按字母序排在中间，每次都要往下翻。
 *
 * <p>做法和变量置顶同构（同一套 {@link PinList}）：一行一个关键词，行序即优先级，
 * 命中的设备排到最前面，其余保持**原来的顺序**（监控页原本按账号+设备名、
 * 历史页原本按最后记录时间倒序、截图列表原本按文件名）。
 * 只把命中项提到前面，不重排没命中的 —— 用户熟悉的相对位置不会被打乱。
 *
 * <p>为什么用关键词而不是设备编号：平台的设备编号（D001…）会随重建变，
 * 设备名稳定得多；而且一行「某线路」就能一次管住这条线上所有站。
 *
 * <p>生效的四处：监控页设备列表、历史页选设备、截图列表/勾选弹窗、
 * 巡站页的「N 台·点行看截图」结果表和「选择站点」弹窗。
 * 只改**展示顺序**：巡站执行的先后仍是平台返回的顺序（并发跑，本来也不保证），
 * 所以置顶不会改变图号，只是让你一进页面就能看见关心的那几台。
 */
public final class DevOrder {

    /** CSV 表头。 */
    public static final String HEADER = "站名关键词";

    /** 最多允许多少条（与变量清单同口径）。 */
    public static final int MAX_ITEMS = PinList.MAX_ITEMS;

    private DevOrder() {
    }

    public static List<String> parse(String text) {
        return PinList.parse(text, HEADER);
    }

    public static String toText(List<String> items) {
        return PinList.toText(items, HEADER);
    }

    public static String validate(String text) {
        return PinList.validate(text, HEADER, "站名关键词");
    }

    public static String warn(String kw) {
        return PinList.warn(kw);
    }

    /** 设备名命中的第一条关键词的下标，没命中返回 -1。 */
    public static int indexOf(List<String> items, String name) {
        return PinList.indexOf(items, name);
    }

    /** 取对象的名字（监控页取 DevState.name、历史页取设备名）。 */
    public interface NameOf<T> {
        String name(T item);
    }

    /**
     * 按置顶清单对**任意对象列表**做稳定排序：命中项按清单行序提到前面，
     * 其余保持调用方给的原有顺序（调用方先按自己的规则排好再进来）。
     *
     * <p>为什么收一个 {@link NameOf} 而不是只吃字符串列表：设备名会重名
     * （两个账号下都有「1号机」），靠名字回查下标会把两台机串到同一个位置。
     * 直接排对象就不会有这个问题。
     *
     * <p>稳定性来自比较器的写法：两边都没命中返回 0，
     * {@link Collections#sort} 是稳定排序，原序自然保留。
     *
     * @return 新列表，不改入参
     */
    public static <T> List<T> sortItems(List<T> items, NameOf<T> nameOf, List<String> pinned) {
        List<T> src = new ArrayList<>();
        if (items != null) for (T it : items) src.add(it);
        if (pinned == null || pinned.isEmpty()) return src;
        final List<String> pin = pinned;
        final NameOf<T> f = nameOf;
        Collections.sort(src, new Comparator<T>() {
            @Override
            public int compare(T a, T b) {
                int ka = indexOf(pin, f.name(a));
                int kb = indexOf(pin, f.name(b));
                if (ka < 0 && kb < 0) return 0;          // 都没命中 → 保持原序
                if (ka < 0) return 1;                     // 没命中的排后面
                if (kb < 0) return -1;
                return ka < kb ? -1 : (ka == kb ? 0 : 1);
            }
        });
        return src;
    }

    /**
     * 按置顶清单做**稳定**排序：命中的按清单行序在前，没命中的保持原顺序。
     *
     * <p>为什么单独写一个而不是复用 {@link ShotOrder}：那边是「变量名的分档」，
     * 这边只有一条规则（置顶或没有），把两者混在一起会让变量的水温规则
     * 莫名其妙作用到设备名上（比如设备名叫「供水泵房」就会被当成水温变量）。
     *
     * @param names  待排的设备名
     * @param pinned 置顶关键词；null / 空 = 原样返回
     * @return 新列表，不改入参
     */
    public static List<String> sort(List<String> names, List<String> pinned) {
        return sortItems(names, new NameOf<String>() {
            @Override
            public String name(String item) {
                return item;
            }
        }, pinned);
    }
}
