package org.usrcloud.xunjian;

import java.io.File;

/**
 * 【v0.36 修订五】清掉「对外目录里已经有同一批」的私有批次。
 *
 * <p>背景：v0.36 修订四之前，每轮巡站会往应用私有目录
 * （{@code /data/user/0/…/files/巡站截图/}）写一份工作副本，只在对外目录留一份给用户看。
 * 修订四之后新跑的轮次不再留副本，但**升级前留下的老批次还在** ——
 * 用户在文件管理器里翻到那个目录，看到的就是「怎么还有文件」。
 *
 * <p>清理规则只有一条，宁可少删：
 * **对外目录里有同名批次，且那里面真的有文件**，才删私有那份。
 * 对外是空的、或者根本没有同名批次 → 私有那份可能是唯一的图，一律不动。
 *
 * <p>为什么单独成类：这段会删文件，得能用真目录验算（{@code jcleantest}），
 * 放在依赖 Android 的类里就没法脱离手机跑。
 */
public final class BatchClean {

    private BatchClean() {
    }

    /**
     * @param privRoot 私有批次根目录（{@code …/files/巡站截图}）
     * @param pubRoot  对外批次根目录（{@code /storage/emulated/0/巡站截图} 或下载目录下同名）
     * @return 删掉的私有批次数
     */
    public static int cleanMirrored(File privRoot, File pubRoot) {
        if (privRoot == null || pubRoot == null) return 0;
        if (!privRoot.isDirectory() || !pubRoot.isDirectory()) return 0;
        File[] fs = privRoot.listFiles();
        if (fs == null) return 0;
        int n = 0;
        for (File d : fs) {
            if (!d.isDirectory()) continue;
            if (!d.getName().matches("^\\d{8}_\\d{6}_截图$")) continue;
            File twin = new File(pubRoot, d.getName());
            if (!twin.isDirectory()) continue;          // 对外没有 → 这份可能是唯一一份
            if (countFiles(twin) == 0) continue;        // 对外是空壳 → 不能删
            deleteTree(d);
            if (!d.exists()) n++;
        }
        return n;
    }

    /** 递归删目录。自己写一份，不借 Core 的 —— 借了就又绑回 Android，没法单独验算。 */
    static void deleteTree(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) deleteTree(x);
        f.delete();
    }

    /** 递归数文件（不算目录）。 */
    static int countFiles(File dir) {
        if (dir == null) return 0;
        File[] fs = dir.listFiles();
        if (fs == null) return 0;
        int n = 0;
        for (File f : fs) n += f.isDirectory() ? countFiles(f) : 1;
        return n;
    }
}
