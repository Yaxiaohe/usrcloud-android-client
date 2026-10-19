package org.usrcloud.xunjian;

import java.util.List;

/**
 * 【v0.35】变量置顶清单 —— 「我的 → 变量排序」里那份表。
 *
 * <p>要解决的问题：同一台机组上，「出水温度」和「进水温度」两张卡片的位置
 * **会自己换**。根子在平台返回的变量顺序不保证稳定（谁先建谁在前），
 * 改一次变量、换一次平台版本就可能换序；而 v0.34 是「同档内保持平台原顺序」
 * —— 平台一换序，截图就跟着换。用户看的是进出水温差，两张卡来回跳很难受。
 *
 * <p>做法：给用户一份置顶清单（像微信置顶联系人）—— 一行一个关键词，
 * **行序就是优先级**，命中的变量排到最前面；没命中的再走 {@link ShotOrder} 里
 * 那套默认分档（出水/供水 → 进水/回水 → 其它水温 → 其它温度 → 其余）。
 *
 * <p>为什么用关键词而不是「变量名」：平台上的变量名常带后缀、还可能被改
 * （供水温度T1 → 供水温度T2）。包含匹配改后缀照样命中，一行关键词还能
 * 一次管住多台设备的同类变量。
 *
 * <p>【v0.36】解析/写回/校验这些通用逻辑搬去了 {@link PinList} ——
 * 站名置顶（{@link DevOrder}）用的是同一套东西，各写一份早晚不一致。
 * 这里只剩「变量」这一层的常量与转发，对外 API 没变。
 */
public final class VarOrder {

    /** CSV 表头。带表头是为了用户打开文件就知道这一列是什么。 */
    public static final String HEADER = "关键词";

    /** 最多允许多少条置顶关键词（与站名清单同口径）。 */
    public static final int MAX_ITEMS = PinList.MAX_ITEMS;

    private VarOrder() {
    }

    /** 把 CSV 原文解析成关键词列表（行序 = 优先级）。 */
    public static List<String> parse(String text) {
        return PinList.parse(text, HEADER);
    }

    /** 把关键词列表写成 CSV 原文（含表头、含 BOM，和 accounts.csv 一致）。 */
    public static String toText(List<String> items) {
        return PinList.toText(items, HEADER);
    }

    /**
     * 校验原文能不能存。
     *
     * @return 空串 = 通过；否则是给用户看的原因
     */
    public static String validate(String text) {
        return PinList.validate(text, HEADER, "关键词");
    }

    /** 一条关键词里不该有的东西。返回提示，没问题返回空串。 */
    public static String warn(String kw) {
        return PinList.warn(kw);
    }

    /**
     * 变量名命中的第一条关键词的下标，没命中返回 -1。
     *
     * <p>取**最靠前**的那条：一行关键词命中就够，用户排在最上面的优先。
     */
    public static int indexOf(List<String> items, String name) {
        return PinList.indexOf(items, name);
    }
}
