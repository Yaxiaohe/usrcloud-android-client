package org.usrcloud.xunjian;

import java.io.File;

/**
 * 【v0.36 修订四】只删空目录，自底向上。
 *
 * <p>为什么要单独拎出来：这段逻辑会**删用户的文件**，不能只靠「看着没问题」。
 * 放在 Core 里就带上了 Android 依赖，脱离手机没法验算；
 * 拎到这个类里只依赖 java.io，就能用真临时目录跑 {@code jprunetest} 验边界。
 *
 * <p>安全边界只有一条：**只删空目录**。
 * {@link File#delete()} 对非空目录返回 false，所以有文件的一律动不了 ——
 * 这不是靠 if 判断自觉遵守，是文件系统的硬约束。
 */
public final class FilePrune {

    private FilePrune() {
    }

    /**
     * 自底向上删掉 {@code root} 下面（含自己）的空目录。
     *
     * @param root 起点；null / 不是目录 / 不存在 → 什么也不做
     * @return 实际删掉的目录数
     */
    public static int pruneEmptyDirs(File root) {
        if (root == null || !root.isDirectory()) return 0;
        int n = 0;
        File[] fs = root.listFiles();
        if (fs != null) {
            for (File f : fs) {
                if (f.isDirectory()) n += pruneEmptyDirs(f);
            }
        }
        // 先递归子目录，再试自己 —— 反过来会漏掉「子目录清空后父目录也空了」的情况
        fs = root.listFiles();
        if (fs != null && fs.length == 0 && root.delete()) n++;
        return n;
    }
}
