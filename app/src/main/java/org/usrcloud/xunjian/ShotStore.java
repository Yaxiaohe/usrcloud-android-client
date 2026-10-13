package org.usrcloud.xunjian;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 截图对外发布。
 *
 * 背景：Android 11+ 想写 /storage/emulated/0/ 根目录必须开「所有文件访问」，
 * 是个要跳系统设置手动开的开关，用户经常开不了或忘了开，退回私有目录就等于白做。
 * 所以这里做两条路：
 *   1) 已授权  → 直接写 /storage/emulated/0/巡站截图/          （用户要求的根目录层级）
 *   2) 未授权  → 走 MediaStore 写 /storage/emulated/0/Download/巡站截图/
 *                这条不需要任何权限，文件管理器里「下载」目录直接能点进去
 * 两条路都在用户能自己找到的位置，区别只是层级深浅。
 */
public class ShotStore {

    /** 对外目录名（根目录与 Download 下同名） */
    public static final String DIR_NAME = "巡站截图";

    /** 是否已拿到「所有文件访问」 */
    public static boolean hasAllFiles() {
        try {
            return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 供界面展示的路径。优先根目录，其次 Download，最后私有目录。
     */
    public static String displayPath() {
        if (hasAllFiles()) {
            try {
                File sd = Environment.getExternalStorageDirectory();
                if (sd != null) return new File(sd, DIR_NAME).getAbsolutePath();
            } catch (Exception ignored) {
            }
        }
        File dl = downloadRoot();
        if (dl != null) return new File(dl, DIR_NAME).getAbsolutePath();
        return new File(Core.rootDir(), DIR_NAME).getAbsolutePath();
    }

    /** 人话版说明，界面上直接显示，省得用户看路径猜。 */
    public static String displayHint() {
        if (hasAllFiles()) return "手机根目录，文件管理器第一层就能看到";
        File dl = downloadRoot();
        if (dl != null) return "手机「下载」目录下，文件管理器里点「下载」即可";
        return "应用私有目录，需开启「所有文件访问」才能在文件管理器看到";
    }

    private static File downloadRoot() {
        try {
            File d = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS);
            if (d != null && (d.exists() || d.mkdirs())) return d;
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 对外根目录（根目录或 Download 下那个）。取不到返回 null。 */
    private static File publishRoot() {
        if (hasAllFiles()) {
            try {
                File sd = Environment.getExternalStorageDirectory();
                if (sd != null) return new File(sd, DIR_NAME);
            } catch (Exception ignored) {
            }
        }
        File dl = downloadRoot();
        return dl == null ? null : new File(dl, DIR_NAME);
    }

    /**
     * 清理对外目录里的往期批次。
     * 之前「清理往期」只删私有目录，用户在文件管理器里看到的对外副本一份没少，
     * 点了跟没点一样。这里把对外目录也一起清掉。
     *
     * @param keep 当前批次目录名，本次的不删
     * @return 删除的批次数
     */
    public static int cleanOldBatches(String keep) {
        File root = publishRoot();
        if (root == null || !root.isDirectory()) return 0;
        File[] fs = root.listFiles();
        if (fs == null) return 0;
        int n = 0;
        java.util.Arrays.sort(fs);
        for (File f : fs) {
            if (!f.isDirectory()) continue;
            if (!f.getName().matches("^\\d{8}_\\d{6}_截图$")) continue;
            if (keep != null && keep.equals(f.getName())) continue;
            Core.deleteTree(f);
            if (!f.exists()) n++;
        }
        return n;
    }

    /**
     * 把私有目录里的截图复制到对外位置。
     * 私有目录是 zip 导出、清理往期、历史统计的源，对外目录只是给用户看的副本。
     *
     * @param relPath 对外目录里的相对路径，形如 20261003_101500_截图/线路甲/设备名.png
     * @param src     源文件（私有目录）
     * @return 实际写入的路径；失败返回 null（不影响巡站本身）
     */
    public static String publish(String relPath, File src) {
        if (src == null || !src.exists()) return null;
        if (hasAllFiles()) {
            File sd = Environment.getExternalStorageDirectory();
            if (sd == null) return null;
            return copyTo(src, resolve(new File(sd, DIR_NAME), relPath));
        }
        File dl = downloadRoot();
        if (dl == null) return null;
        return copyTo(src, resolve(new File(dl, DIR_NAME), relPath));
    }

    /** 对外目录里某个相对路径对应的实际 File，父目录不存在就建。 */
    private static File resolve(File base, String relPath) {
        File f = new File(base, relPath);
        File p = f.getParentFile();
        if (p != null && !p.exists()) p.mkdirs();
        return f;
    }

    /** 普通文件复制 */
    private static String copyTo(File src, File dst) {
        FileInputStream in = null;
        OutputStream out = null;
        try {
            in = new FileInputStream(src);
            out = new java.io.FileOutputStream(dst);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            return dst.getAbsolutePath();
        } catch (Exception e) {
            Log.w("patrol", "发布截图失败: " + e);
            return null;
        } finally {
            close(in);
            close(out);
        }
    }

    /**
     * MediaStore 发布（Android 10+ 专用）。
     * 未授权「所有文件访问」时，写 Download/巡站截图/ 不需要任何权限，
     * 是唯一能让用户在自己文件管理器里看到截图的办法。
     *
     * @return 对外 Uri 字符串；失败返回 null
     */
    public static String publishViaMediaStore(String relPath, File src) {
        if (src == null || !src.exists()) return null;
        if (Build.VERSION.SDK_INT < 29) return null;   // 低版本走 publish() 的 File 路径
        Context ctx = Core.appCtx();
        if (ctx == null) return null;
        try {
            String rel = relPath.replace('\\', '/');
            int slash = rel.lastIndexOf('/');
            String parent = slash > 0 ? rel.substring(0, slash) : "";
            String fname = slash > 0 ? rel.substring(slash + 1) : rel;
            ContentResolver cr = ctx.getContentResolver();
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, fname);
            cv.put(MediaStore.Downloads.MIME_TYPE, "image/png");
            // RELATIVE_PATH 会被系统拼成 /storage/emulated/0/Download/巡站截图/<批次>/<账号>/
            cv.put(MediaStore.Downloads.RELATIVE_PATH,
                    parent.isEmpty() ? DIR_NAME : DIR_NAME + "/" + parent);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) return null;
            OutputStream out = cr.openOutputStream(uri);
            if (out == null) return null;
            InputStream in = new FileInputStream(src);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
            } finally {
                close(in);
                close(out);
            }
            return uri.toString();
        } catch (Exception e) {
            Log.w("patrol", "MediaStore 发布失败: " + e);
            return null;
        }
    }

    /** 统一入口：有授权走 File，没有走 MediaStore。 */
    public static String publishAuto(String relPath, File src) {
        if (hasAllFiles()) return publish(relPath, src);
        String r = publishViaMediaStore(relPath, src);
        if (r != null) return r;
        return publish(relPath, src);   // MediaStore 失败再兜一次 File
    }

    private static void close(java.io.Closeable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
            }
        }
    }
}
