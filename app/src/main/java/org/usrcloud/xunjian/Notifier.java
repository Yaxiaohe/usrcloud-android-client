package org.usrcloud.xunjian;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 系统通知。
 *
 * 【为什么单独一个类】v0.08 之前「测试提醒」按钮只做了两件事：
 * 往内存 alerts 列表里塞一条记录 + Core.log 一行字，然后前端弹个
 * toast 说「已发出，请看下拉通知栏」—— 但全工程没有任何一处
 * NotificationManager 调用，下拉通知栏当然是空的。
 * 这不是"通知不生效"，是通知压根没实现。
 *
 * 现在按 Android 8.0+ 的正确做法实现：
 *   1) 必须先建 NotificationChannel，否则 notify() 静默失败
 *   2) 小图标必须是单色 alpha 图（res/drawable/ic_stat_*.png，
 *      mknotif.py 生成），给彩色图会被渲成一坨白方块
 *   3) Android 13+ 还要 POST_NOTIFICATIONS 运行时权限，
 *      没授权 notify() 也不报错、就是不显示——所以 MainActivity 启动时申请
 *   4) setSmallIcon 之外的 Channel importance 要给高，不然静默通道直接吞掉
 */
public class Notifier {

    private static final String TAG = "notify";
    private static final String CH_ALERT = "patrol_alert";     // 异常提醒
    private static final String CH_STATE = "patrol_state";     // 状态变化

    /** 提醒 id 递增值，避免 id 复用导致系统认为是同一条不刷新 */
    private static volatile int seq = 1000;

    /** 建渠道。Android 8.0+ 必需，且要在 notify 之前。 */
    public static void init(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = nm(ctx);
            if (nm == null) return;

            NotificationChannel ca = new NotificationChannel(
                    CH_ALERT, "设备异常提醒",
                    NotificationManager.IMPORTANCE_HIGH);
            ca.setDescription("站点设备离线、数据停更、采集异常时提醒");
            ca.enableVibration(true);
            ca.setShowBadge(true);
            // 锁屏也显示（运维场景需要随手看一眼就明白是哪台设备）
            ca.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ca);

            NotificationChannel cs = new NotificationChannel(
                    CH_STATE, "监控状态",
                    NotificationManager.IMPORTANCE_LOW);
            cs.setDescription("监控开关、扫描完成等一般性状态");
            cs.setShowBadge(false);
            nm.createNotificationChannel(cs);
        } catch (Throwable t) {
            Log.w(TAG, "建通知渠道失败: " + t);
        }
    }

    /**
     * 是否已拿到通知权限。
     * Android 13+ 不授权时 notify() 不抛异常也不显示，是最难查的一种"失效"。
     */
    public static boolean canNotify(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED;
            }
            NotificationManager nm = nm(ctx);
            return nm != null && nm.areNotificationsEnabled();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 通道是否被用户单独关掉了（授权了但通道关了，通知同样不显示）。 */
    public static boolean channelOn(Context ctx, String ch) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
            NotificationManager nm = nm(ctx);
            if (nm == null) return false;
            return nm.getNotificationChannel(ch) == null
                    || nm.getNotificationChannel(ch).getImportance()
                    != NotificationManager.IMPORTANCE_NONE;
        } catch (Throwable t) {
            return true;
        }
    }

    /**
     * 发一条异常提醒。
     *
     * @param level warn / critical / ok
     */
    public static void alert(Context ctx, String acc, String dev, String msg, String level) {
        String title = (dev == null || dev.isEmpty()) ? "巡站提醒" : dev;
        if (acc != null && !acc.isEmpty() && !acc.equals("-")) {
            title = acc + " · " + title;
        }
        /* 【v0.30】把 acc/dev 一起带下去：点通知要能直接跳到这台设备，
           只看监控页还不够 —— 页面上几十台设备，还是要用户自己找。 */
        notify(ctx, CH_ALERT, idOf(level), title, msg, level, acc, dev);
    }

    /** 发一条一般状态通知（监控启动、扫描完成等）。 */
    public static void state(Context ctx, String title, String msg) {
        notify(ctx, CH_STATE, ++seq, title, msg, "info", null, null);
    }

    private static int idOf(String level) {
        // id 每条递增：系统按 id 判断是不是同一条通知，id 不变会只更新不重弹
        return ++seq;
    }

    private static void notify(Context ctx, String ch, int id, String title,
                               String msg, String level, String acc, String dev) {
        try {
            NotificationManager nm = nm(ctx);
            if (nm == null) return;
            if (!canNotify(ctx)) {
                // 没权限就别白跑一趟，log 出来便于用户反馈时定位
                Core.log("[通知] 未获通知权限，已跳过：" + title);
                return;
            }
            if (!channelOn(ctx, ch)) {
                Core.log("[通知] 通道已关闭，跳过：" + ch);
                return;
            }

            Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? new Notification.Builder(ctx, ch)
                    : new Notification.Builder(ctx);

            b.setSmallIcon(iconOf(level));
            b.setContentTitle(title == null ? "巡站提醒" : title);
            b.setContentText(msg == null ? "" : msg);
            b.setStyle(new Notification.BigTextStyle()
                    .bigText(msg == null ? "" : msg));
            b.setWhen(System.currentTimeMillis());
            b.setAutoCancel(true);          // 点掉不再留
            b.setShowWhen(true);
            b.setCategory(Notification.CATEGORY_STATUS);

            // 点击通知回到 app 的「监控」页，并直接定位到这台设备看实时数据
            b.setContentIntent(openApp(ctx, id, acc, dev));
            b.addAction(0, "查看", openApp(ctx, id, acc, dev));

            nm.notify(id, b.build());
            Core.log("[通知] 已发送：" + title + " — " + msg);
        } catch (Throwable t) {
            Log.w(TAG, "发通知失败: " + t);
            Core.log("[通知] 发送异常：" + t);
        }
    }

    private static PendingIntent openApp(Context ctx, int id, String acc, String dev) {
        try {
            Intent it = new Intent();
            it.setClassName(ctx.getPackageName(), MainActivity.class.getName());
            it.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            // 带上 tab=watch，点通知直接落到监控页
            it.putExtra("tab", "watch");
            /* 【v0.30】再带上设备名与账号：MainActivity 收到后把参数转给网页，
               前端自动切到监控页 → 展开并刷新这台设备 → 直接看到当前数据。
               不带的话只能落到监控页顶部，用户还得在几十台里自己找。 */
            if (dev != null && !dev.isEmpty()) it.putExtra("dev", dev);
            if (acc != null && !acc.isEmpty() && !acc.equals("-")) it.putExtra("acc", acc);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            return PendingIntent.getActivity(ctx, id, it, flags);
        } catch (Throwable t) {
            return null;
        }
    }

    private static int iconOf(String level) {
        if ("critical".equals(level) || "crit".equals(level)) {
            return R.drawable.ic_stat_crit;
        }
        if ("ok".equals(level)) return R.drawable.ic_stat_ok;
        if ("warn".equals(level)) return R.drawable.ic_stat_warn;
        return R.drawable.ic_stat_alert;
    }

    private static NotificationManager nm(Context ctx) {
        try {
            return (NotificationManager)
                    ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        } catch (Throwable t) {
            return null;
        }
    }
}
