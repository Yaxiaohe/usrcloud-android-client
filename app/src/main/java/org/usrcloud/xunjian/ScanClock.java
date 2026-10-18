package org.usrcloud.xunjian;

/**
 * 巡检节拍的两个**纯函数**。【v0.33 修订八】
 *
 * <p>为什么单独抽出来：这两个数直接决定「多久该跑下一轮」「回来要不要补跑」，
 * 而用户报的现象（「15 分钟周期怎么会出现 20 分钟前」）本质就是在这里对不上。
 * 放进 Watch 里就得连 Android 一起编译，没法单独验算；抽成零依赖的静态方法后，
 * {@code jscanclocktest} 可以直接跑真代码，把每个边界都钉死。
 *
 * <p>两个函数的语义（写死在这里，测试逐条对）：
 * <ul>
 *   <li>{@link #nextDelaySec}：下一拍距离**本轮结束**还有多少秒。
 *       目标是让「本轮开始 → 下轮开始」= 用户设的间隔，所以要把本轮耗时扣掉；
 *       扣成负数时至少歇 {@link #MIN_GAP_SEC} 秒，不连着打平台。</li>
 *   <li>{@link #isOverdue}：距上一轮**结束**是否已满一个间隔。
 *       这是「回前台补跑」的判据，口径与 fixedDelay 一致（结束 + 间隔），
 *       比精确节拍晚一个本轮耗时 —— 它是兜底，不是准点器。</li>
 * </ul>
 */
public final class ScanClock {

    /** 两轮之间至少歇 30 秒：本轮跑超了也不连着打平台。 */
    public static final long MIN_GAP_SEC = 30;

    private ScanClock() {
    }

    /**
     * 下一拍延迟（秒）。
     *
     * @param intervalSec 用户设的轮询间隔（秒），调用方已保证 >= 60
     * @param scanDurSec  本轮巡检实际耗时（秒），负数按 0 处理
     * @return max(30, intervalSec - scanDurSec)
     */
    public static long nextDelaySec(int intervalSec, long scanDurSec) {
        long dur = scanDurSec < 0 ? 0 : scanDurSec;
        long delay = intervalSec - dur;
        return delay < MIN_GAP_SEC ? MIN_GAP_SEC : delay;
    }

    /**
     * 距上一轮结束是否已满一个轮询间隔（该补跑了）。
     *
     * <p>边界：**恰好等于**间隔也算超期（{@code >=}）—— 周期到了就该跑，
     * 不能因为差一毫秒再等一整轮。
     *
     * @param lastScanEndMs 上一轮结束的墙上时间（毫秒）；<=0 表示没有记录
     * @param nowMs         当前墙上时间（毫秒）
     * @param intervalSec   轮询间隔（秒）
     * @return 没有记录时返回 true；否则 (now - last) >= interval * 1000
     */
    public static boolean isOverdue(long lastScanEndMs, long nowMs, int intervalSec) {
        if (lastScanEndMs <= 0) return true;
        return nowMs - lastScanEndMs >= intervalSec * 1000L;
    }
}
