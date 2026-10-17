package org.usrcloud.xunjian;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 监控前台服务。【v0.20 新增】
 *
 * <p>【为什么必须有这个 —— 用户反馈「通知问题没得到解决」的真因】
 *
 * <p>原来定时巡检跑在一个进程内的 {@code ScheduledExecutorService} 上
 * （Watch.setEnabled 里 scheduleWithFixedDelay）。
 * 这东西的生命周期等于 app 进程：<b>用户把 app 划掉或系统回收内存，
 * 巡检就停了，系统通知自然一条都不会再弹。</b>
 *
 * <p>更麻烦的是它给出的假象：只要 app 还开着，站内提醒列表
 * （Watch.alerts）会正常累积，界面上能看到一条条提醒，
 * 唯独下拉通知栏是空的。用户看到的就是「提醒有、通知没有」，
 * 反复检查权限、检查规则、检查渠道都没用 —— 因为问题根本不在通知那一层。
 *
 * <p>Android 的标准解法是前台服务：给一个常驻通知换掉进程被杀的优先级，
 * 让调度器在 app 没打开时照样能跑。
 *
 * <p>【为什么必须诚实告知用户】前台服务会在下拉栏留一条常驻通知，
 * 这是 Android 的强制要求，不能悄悄干。所以：
 * <ul>
 *   <li>渠道 importance 用 MIN —— 不响、不震动、不弹横幅，尽量不打扰</li>
 *   <li>文案写清楚「保持监控运行中，可以下拉关闭」，
 *       避免用户以为是异常提醒又点进来</li>
 * </ul>
 *
 * <p>targetSdk 33 起，后台启动前台服务受限。
 * 这里只从 MainActivity（前台）里启动，符合系统约束。
 */
public class WatchService extends Service {

    private static final String TAG = "watchsvc";
    private static final String CH_RUN = "patrol_run";
    private static final int ID_RUN = 9001;
    /* 【v0.33 修订五】常驻通知跳转专用的 requestCode 与 action。
       为什么必须单独一套：PendingIntent 的相等性判定（Intent.filterEquals）
       只看 requestCode + action + data + type + component，**不看 extras**。
       Notifier 那边提醒通知的 id 是 seq 自增（初值 1000，首条就是 1001），
       且同样指向 MainActivity、不设 action —— 和这边原来的 requestCode 1001
       在系统眼里就是**同一条 PendingIntent**。两边又都用了 FLAG_UPDATE_CURRENT
       （谁后建就用谁的 extras 覆盖），于是规则一命中，常驻通知的点击目标
       就被改写成「最后一个命中的站点」，用户点「运行中」直接跳去那台设备。
       所以这里 requestCode 用 9002（远离 seq 区间），再给独有 action+data
       双保险：就算 requestCode 将来真的撞上，签名不同也不会被并成一条。 */
    private static final int REQ_RUN = 9002;
    private static final String ACTION_OPEN_WATCH = "org.usrcloud.xunjian.action.OPEN_WATCH";

    public static void start(Context ctx) {
        try {
            Intent it = new Intent(ctx, WatchService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(it);
            } else {
                ctx.startService(it);
            }
        } catch (Throwable t) {
            /* 起不来不能连带影响监控本身，降级成纯进程内调度 */
            Log.w(TAG, "前台服务启动失败，退回进程内调度: " + t);
            Core.log("[监控] 前台服务启动失败，app 退到后台后巡检会停止: " + t);
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, WatchService.class));
        } catch (Throwable ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 必须在 5 秒内调 startForeground，否则系统会 ANR 并杀掉服务
        try {
            startForeground(ID_RUN, buildRun());
        } catch (Throwable t) {
            Log.w(TAG, "startForeground 失败: " + t);
            stopSelf();
            return START_NOT_STICKY;
        }

        /* 关键：真正的巡检调度仍然是 Watch.SCHED，
           服务只负责「让进程活着」。这里把监控开关打开，
           调度器就在这个被保活的进程里持续跑。 */
        try {
            Watch.setEnabled(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForeground(ID_RUN, buildRun());
            }
        } catch (Throwable t) {
            Log.w(TAG, "开启监控失败: " + t);
        }

        // START_STICKY：进程被系统杀掉后系统会重建服务，监控能自动恢复
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "监控服务已停止");
        super.onDestroy();
    }

    /** 常驻通知：走独立渠道，MIN 优先级，安静不打扰。 */
    private Notification buildRun() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.NotificationManager nm =
                        (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null && nm.getNotificationChannel(CH_RUN) == null) {
                    android.app.NotificationChannel c =
                            new android.app.NotificationChannel(
                                    CH_RUN, "监控运行中",
                                    android.app.NotificationManager.IMPORTANCE_MIN);
                    c.setDescription("保持后台定时巡检运行，设备异常时才能弹通知");
                    c.setShowBadge(false);
                    c.enableVibration(false);
                    c.setSound(null, null);
                    nm.createNotificationChannel(c);
                }
            }

            Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? new Notification.Builder(this, CH_RUN)
                    : new Notification.Builder(this);
            b.setSmallIcon(R.drawable.ic_stat_warn);
            b.setContentTitle("巡站监控运行中");
            b.setContentText("保持后台定时巡检，设备异常时才会弹通知");
            b.setStyle(new Notification.BigTextStyle().bigText(
                    "保持后台定时巡检，设备异常时才会弹通知。"
                    + "不需要监控时，在「监控」页关掉开关即可。"));
            /* 【v0.33 修复】点这条常驻通知要能跳进 app。
               原来没设 setContentIntent，前台服务通知的默认点击行为是
               「什么都不发生」—— 用户点它毫无反应，还以为是 app 挂了。
               这里显式挂一个 PendingIntent，直接落到监控页。 */
            b.setContentIntent(openApp());
            b.setContentTitle("巡站监控运行中 · 点此打开");
            b.setOngoing(true);      // 常驻，用户划不掉
            b.setShowWhen(false);
            b.setPriority(Notification.PRIORITY_MIN);
            b.setWhen(System.currentTimeMillis());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
            }
            return b.build();
        } catch (Throwable t) {
            Log.w(TAG, "构造常驻通知失败: " + t);
            Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? new Notification.Builder(this, CH_RUN)
                    : new Notification.Builder(this);
            b.setSmallIcon(R.drawable.ic_stat_warn)
                    .setContentTitle("巡站监控运行中");
            /* 兜底分支同样要能点开，别只在正常路径挂跳转 */
            b.setContentIntent(openApp());
            return b.build();
        }
    }

    /**
     * 常驻通知的点击跳转：打开 app 并直接落到监控页。
     *
     * <p>【v0.33 修订五】这条 Intent 的签名必须和提醒通知（Notifier.openApp）
     * 完全分开。详见 REQ_RUN 处的注释：extras 不参与 PendingIntent 判等，
     * 光靠 requestCode 分离不够彻底，action+data 也要各自独有。
     *
     * <p>requestCode 用一个固定常量（不是 hashCode）——同一条通知会被反复
     * setForeground 重建，如果 requestCode 跟着内容变，系统会认为是不同的
     * PendingIntent，用户点到的可能是旧 Intent（带过期的 extras）。
     *
     * <p>注意这条 Intent **只带 tab**，永远不放 dev/acc：
     * 常驻通知的语义就是「回到监控页」，跳具体设备是提醒通知的活。
     */
    private android.app.PendingIntent openApp() {
        try {
            Intent it = new Intent();
            it.setClassName(getPackageName(), MainActivity.class.getName());
            it.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            it.putExtra("tab", "watch");
            /* 独有签名：与 Notifier 的提醒 Intent 分开（见 REQ_RUN 注释）。
               组件是指定的，action/data 不参与解析，只用于 PendingIntent 判重。 */
            it.setAction(ACTION_OPEN_WATCH);
            it.setData(android.net.Uri.parse("xunjian://watch"));
            int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
            }
            return android.app.PendingIntent.getActivity(this, REQ_RUN, it, flags);
        } catch (Throwable t) {
            Log.w(TAG, "构造常驻通知跳转失败: " + t);
            return null;
        }
    }
}
