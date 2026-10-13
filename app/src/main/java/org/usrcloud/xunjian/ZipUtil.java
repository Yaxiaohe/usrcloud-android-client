package org.usrcloud.xunjian;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** 打包与批次清理。 */
public class ZipUtil {

    public static void zip(File srcDir, File zipFile) throws Exception {
        ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zipFile));
        try {
            zipDir(zos, srcDir, srcDir.getName());
        } finally {
            zos.close();
        }
    }

    private static void zipDir(ZipOutputStream zos, File dir, String root) throws Exception {
        File[] fs = dir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            if (f.isDirectory()) {
                zipDir(zos, f, root + "/" + f.getName());
            } else {
                // 中文名交给 Java 的 UTF-8 默认行为，Windows 资源管理器同样能解
                zos.putNextEntry(new ZipEntry(root + "/" + f.getName()));
                InputStream in = new FileInputStream(f);
                copy(in, zos);
                in.close();
                zos.closeEntry();
            }
        }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    /** 列出往期批次目录名（不含本次），按时间倒序。 */
    public static List<String> listBatches() {
        List<String> out = new ArrayList<>();
        File[] fs = Core.batchesDir().listFiles();
        if (fs == null) return out;
        String cur = Core.batchDir == null ? ""
                : new File(Core.batchDir).getName();
        List<String> names = new ArrayList<>();
        for (File f : fs) {
            if (!f.isDirectory()) continue;
            if (!f.getName().matches("^\\d{8}_\\d{6}_截图$")) continue;
            if (f.getName().equals(cur)) continue;
            names.add(f.getName());
        }
        java.util.Collections.sort(names, new CollectionsReverse());
        out.addAll(names);
        return out;
    }

    private static class CollectionsReverse implements java.util.Comparator<String> {
        @Override
        public int compare(String a, String b) {
            return b.compareTo(a);
        }
    }
}
