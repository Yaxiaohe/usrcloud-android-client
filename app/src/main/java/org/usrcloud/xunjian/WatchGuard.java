package org.usrcloud.xunjian;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 监控扫描的并发守卫。【v0.29 抽出】
 *
 * <p>为什么单独成一个零依赖类：
 * <ul>
 *   <li>手动「立即巡检」(Watch.scanAsync) 和周期巡检(调度器) 都会跑 Watch.scan()，
 *       必须用同一个原子锁保证同一时刻只有一个扫描在跑 ——
 *       否则两份 scan() 并发、状态互相覆盖，且在旧代码里还会把 scanning 卡死成 true，
 *       导致「监控中却再也不更新」。</li>
 *   <li>Watch 本体依赖 Android SDK（Context 等），纯 JVM 编译不起来，
 *       抽成零依赖类后，jwatchtest2 能直接跑真代码验证守卫语义，
 *       而不是另写一份「复刻」。</li>
 * </ul>
 *
 * <p>用法（调用方必须配 finally 释放锁）：
 * <pre>
 *   if (!WatchGuard.tryBeginScan()) return;   // 抢不到说明有别的扫描在跑
 *   try { ... scan work ... }
 *   finally { WatchGuard.scanning.set(false); }
 * </pre>
 */
public final class WatchGuard {

    /** 是否正在扫描（手动或周期任一在跑都为 true）。 */
    public static final AtomicBoolean scanning = new AtomicBoolean(false);

    private WatchGuard() {}

    /** 原子抢锁：同一时刻只允许一个扫描在跑。返回 true 表示抢到。 */
    public static boolean tryBeginScan() {
        return scanning.compareAndSet(false, true);
    }
}
