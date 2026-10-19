package org.usrcloud.xunjian;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 截图渲染：用 Canvas 复刻桌面版 render_mobile_cards_pil 的版式。
 * 1170px 宽（390 逻辑 × 3 倍），配色、间距、字号与电脑端保持一致，
 * 这样同一台设备在手机和电脑上生成的图可以直接对比。
 */
public class Renderer {

    private static final int S = 3;
    private static final int W = 390 * S;

    // 与 Python 版一致的配色
    private static final int C_BG = 0xFFF2F4F8;
    private static final int C_WHITE = 0xFFFFFFFF;
    private static final int C_LINE = 0xFFECECEC;
    private static final int C_TAB_ON = 0xFF1F4BB8;
    private static final int C_TAB_OFF = 0xFFEEF1F6;
    private static final int C_TXT = 0xFF1A1A1A;
    private static final int C_SUB = 0xFF8A97AD;
    private static final int C_T333 = 0xFF333333;
    private static final int C_T444 = 0xFF444444;
    private static final int C_T666 = 0xFF666666;
    private static final int C_MUTED = 0xFF9AA4B2;
    private static final int C_CHEV = 0xFFB9C2D0;
    private static final int C_OKBG = 0xFFE9F8EF;
    private static final int C_OKFG = 0xFF0F7B3D;
    private static final int C_WNBG = 0xFFFDF4E3;
    private static final int C_WNFG = 0xFF9A6A12;
    private static final int C_BADGE_OK = 0xFFE3F7EC;
    private static final int C_BADGE_NO = 0xFFFDF3E0;
    private static final int C_BADGE_NG = 0xFF8A6D3B;

    private static final Pattern NUM_UNIT = Pattern.compile("^(-?\\d+(?:\\.\\d+)?)\\s*(.*)$");

    /**
     * Paint 必须是线程本地的，不能用 static 共享。
     *
     * 巡站默认 4 个 worker 并发渲染，每个线程都要 setColor/setTextSize。
     * 共享同一个 Paint 时会出现竞态：线程 A 刚设好白色准备画卡片，
     * 线程 B 抢先改成灰色，A 画出来就是灰卡片 —— 表现为"某一张卡片颜色不对"，
     * 而且每次位置都不一样。这个 bug 只在并发时才显形，单张手测很难发现。
     */
    private static final ThreadLocal<Paint> PAINT = new ThreadLocal<Paint>() {
        @Override
        protected Paint initialValue() {
            return new Paint(Paint.ANTI_ALIAS_FLAG);
        }
    };

    private static Paint paint() {
        return PAINT.get();
    }

    private static void text(Canvas c, String s, float x, float y, int size,
                             int color, boolean bold) {
        Paint pt = paint();
        pt.setStyle(Paint.Style.FILL);      // 不依赖 rr() 留下的 Style
        pt.setColor(color);
        pt.setTextSize(size * S);
        pt.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        pt.setTextAlign(Paint.Align.LEFT);
        c.drawText(s, x, y, pt);
    }

    private static void textC(Canvas c, String s, float cx, float cy, int size,
                              int color, boolean bold) {
        Paint pt = paint();
        pt.setStyle(Paint.Style.FILL);
        pt.setColor(color);
        pt.setTextSize(size * S);
        pt.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        pt.setTextAlign(Paint.Align.CENTER);
        c.drawText(s, cx, cy, pt);
        pt.setTextAlign(Paint.Align.LEFT);
    }

    private static float measure(String s, int size, boolean bold) {
        Paint pt = paint();
        pt.setTextSize(size * S);
        pt.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        return pt.measureText(s);
    }

    private static void rr(Canvas c, float l, float t, float r, float b,
                           float rad, int color) {
        Paint pt = paint();
        pt.setStyle(Paint.Style.FILL);
        pt.setColor(color);
        c.drawRoundRect(new RectF(l, t, r, b), rad, rad, pt);
    }

    private static String ellipsis(Canvas c, String s, int size, boolean bold, float maxW) {
        if (s == null) s = "";
        if (measure(s, size, bold) <= maxW) return s;
        StringBuilder sb = new StringBuilder(s);
        while (sb.length() > 0 && measure(sb + "…", size, bold) > maxW) {
            sb.setLength(sb.length() - 1);
        }
        return sb + "…";
    }

    public static void render(String devName, String devNo, DevData data,
                              String outPath, String status) throws Exception {
        // ---- 数据准备 ----
        /* 【v0.34】水温相关的变量排最前，其余保持平台原顺序（稳定分组）。
         * 关键顺序：**先排再截断**。平台返回的顺序是「谁先建的谁在前」，
         * 一台 17 变量的机组前十个位置常被水流量 / 定时使能 / 启动信号占满，
         * 用户最关心的供回水温度会落在 MAX_CARDS 的截断之外 —— 截图里干脆没有。
         * 排序规则和截断都在 ShotOrder 里（零依赖纯函数，jshotordertest 逐条验算）。
         * 【v0.35】再叠一层用户置顶清单：`我的 → 变量排序` 里配的关键词排最前，
         * 没配就全走默认档，行为与 v0.34 一致。 */
        List<String[]> cards = new ArrayList<>();
        for (String[] row : ShotOrder.arrange(data.rows, Core.MAX_CARDS, Core.varOrderPinned())) {
            String name = row[1], tm = row[3], cur = row[4];
            String val, unit;
            Matcher m = NUM_UNIT.matcher(cur == null ? "" : cur);
            if (m.matches()) {
                val = m.group(1);
                unit = m.group(2);
            } else {
                val = (cur == null || cur.isEmpty()) ? "--" : cur;
                unit = "";
            }
            cards.add(new String[]{name, val, unit,
                    (tm != null && !tm.equals("-") && !tm.isEmpty())
                            ? tm.replace("-", "/") : "--"});
        }

        String badgeTxt;
        boolean badgeOn;
        if ("online".equals(status)) {
            badgeTxt = "● 在线";
            badgeOn = true;
        } else if ("stale".equals(status) || "offline".equals(status)) {
            badgeTxt = "● 离线";
            badgeOn = false;
        } else {
            badgeTxt = "● 采集异常";
            badgeOn = false;
        }
        double age = data.ageMinutes();
        boolean noteOn;
        String note;
        if ("online".equals(status)) {
            String newest = "--";
            for (String[] r : data.rows) {
                if (r.length > 3 && r[3] != null && !r[3].trim().isEmpty()
                        && !r[3].trim().equals("-") && r[3].compareTo(newest) > 0) {
                    newest = r[3].trim();
                }
            }
            noteOn = true;
            note = "数据时间 " + newest + "（" + DevData.fmtAge(age) + "）";
        } else if ("stale".equals(status) || "offline".equals(status)) {
            noteOn = false;
            note = "非实时数据 · 最后上报 " + DevData.fmtAge(age);
        } else {
            noteOn = false;
            note = "未能读取到变量数据";
        }

        // ---- 尺寸（px = 逻辑 × 3），与 Python 版公式一致 ----
        float navH = 52 * S;
        float tabsH = (6 + 9 + 9 + 12) * S + 15 * S;
        float metaH = (12 + 12) * S + 23 * S * 3;
        float noteH = (9 + 9) * S + 12 * S + 6 * S;
        int rowsFixed = (Core.MAX_CARDS + 1) / 2;
        float cardH = (13 + 11) * S + 17 * S + 8 * S + 33 * S + 6 * S + 15 * S;
        float gridH = 10 * S + rowsFixed * cardH + (rowsFixed - 1) * 10 * S + 16 * S;
        int H = (int) (navH + tabsH + 10 * S + metaH + 10 * S + noteH + gridH);

        Bitmap bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint pt = paint();
        pt.setStyle(Paint.Style.FILL);
        pt.setColor(C_BG);
        c.drawRect(0, 0, W, H, pt);

        float y = 0;

        // ---- 1. 顶部导航条 ----
        pt.setColor(C_WHITE);
        c.drawRect(0, y, W, y + navH, pt);
        pt.setColor(C_LINE);
        c.drawRect(0, y + navH, W, y + navH + 1, pt);
        Paint fp = paint();
        fp.setColor(0xFF222222);
        fp.setTextSize(22 * S);
        c.drawText("‹", 14 * S, y + navH / 2 + 8 * S, fp);

        float bw = measure(badgeTxt, 11, true) + 18 * S;
        float bx = W - 14 * S - bw;
        rr(c, bx, y + (navH - 22 * S) / 2, bx + bw, y + (navH + 22 * S) / 2,
                11 * S, badgeOn ? C_BADGE_OK : C_BADGE_NO);
        text(c, badgeTxt, bx + 9 * S, y + navH / 2 + 4 * S, 11,
                badgeOn ? C_OKFG : C_BADGE_NG, true);
        float titleMax = bx - 8 * S - (14 * S + 24 * S);
        text(c, ellipsis(c, devName, 17, true, titleMax), 50 * S,
                y + navH / 2 + 6 * S, 17, C_TXT, true);
        y += navH;

        // ---- 2. 四个页签 ----
        pt.setColor(C_WHITE);
        c.drawRect(0, y, W, y + tabsH, pt);
        float tx = 10 * S;
        float tw = (W - 20 * S - 3 * 8 * S) / 4;
        String[] labels = {"实时概况", "设备组态", "报警记录", "定位轨迹"};
        for (int i = 0; i < 4; i++) {
            float x0 = tx + i * (tw + 8 * S);
            rr(c, x0, y + 6 * S, x0 + tw, y + 6 * S + 33 * S, 6 * S,
                    i == 0 ? C_TAB_ON : C_TAB_OFF);
            textC(c, labels[i], x0 + tw / 2, y + 6 * S + 22 * S, 15,
                    i == 0 ? Color.WHITE : C_T333, i == 0);
        }
        y += tabsH;

        // ---- 3. 设备信息卡 ----
        float my = y + 10 * S;
        rr(c, 12 * S, my, W - 12 * S, my + metaH, 10 * S, C_WHITE);
        float nameMax = W - 60 * S - measure(devNo, 11, false);
        text(c, ellipsis(c, devName, 13, true, nameMax), 26 * S,
                my + 12 * S + 12 * S, 13, C_TXT, true);
        text(c, devNo, W - 14 * S - measure(devNo, 11, false),
                my + 12 * S + 12 * S, 11, C_SUB, false);
        String[] metaLines = {
                "所属组织：" + data.org + "　设备模板：" + data.tpl,
                "网关：" + data.gw + "　设备地址：" + data.addr};
        for (int li = 0; li < 2; li++) {
            text(c, ellipsis(c, metaLines[li], 12, false, W - 52 * S), 26 * S,
                    my + 12 * S + 23 * S * (li + 1) + 12 * S, 12, C_T666, false);
        }
        y = my + metaH;

        // ---- 4. 数据时间提示条 ----
        float ny = y + 10 * S;
        rr(c, 12 * S, ny, W - 12 * S, ny + noteH, 8 * S, noteOn ? C_OKBG : C_WNBG);
        text(c, ellipsis(c, note, 12, false, W - 52 * S), 26 * S,
                ny + noteH / 2 + 4 * S, 12, noteOn ? C_OKFG : C_WNFG, false);
        y = ny + noteH;

        // ---- 5. 变量卡片（两列）----
        float gy = y + 10 * S;
        float cw = (W - 24 * S - 10 * S) / 2;
        for (int ci = 0; ci < cards.size(); ci++) {
            int r = ci / 2, col = ci % 2;
            float cx = 12 * S + col * (cw + 10 * S);
            float cy = gy + r * (cardH + 10 * S);
            String[] cd = cards.get(ci);
            rr(c, cx, cy, cx + cw, cy + cardH, 10 * S, C_WHITE);
            text(c, ellipsis(c, cd[0], 13, false, cw - 40 * S), cx + 12 * S,
                    cy + 13 * S + 10 * S, 13, C_T333, false);
            text(c, "›", cx + cw - 16 * S, cy + 13 * S + 10 * S, 15, C_CHEV, false);
            float vy = cy + 13 * S + 17 * S + 8 * S + 24 * S;
            text(c, cd[1], cx + 12 * S, vy, 24, C_TXT, true);
            if (!cd[2].isEmpty()) {
                float uw = measure(cd[1], 24, true);
                text(c, cd[2], cx + 12 * S + uw + 2 * S, vy, 13, C_T444, true);
            }
            text(c, cd[3], cx + 12 * S, cy + cardH - 11 * S - 2 * S, 11, C_MUTED, false);
        }

        FileOutputStream fos = new FileOutputStream(new File(outPath));
        bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
        fos.flush();
        fos.close();
        bmp.recycle();
    }
}
