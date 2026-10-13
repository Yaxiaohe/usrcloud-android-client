# 有人云巡站（Android）

[有人云](https://www.usr.cn) 平台的第三方 Android 客户端：批量巡检设备、
自动截图归档、离线/数据陈旧告警、历史数据折线图。纯原生 Java + WebView，
没有内置 Python，APK 约 1.4 MB。

> 本仓库是**干净版本**：`assets/accounts.csv` 只有表头，不含任何账号、密码、
> 登录缓存或巡检数据，也不含任何公司标识。装好后在「账号」页自己添加账号。

## 一、功能

- **巡站**：按账号批量拉取设备最新值，Android Canvas 直接画卡片图，4 路并发，约 0.3 s/台
- **状态判定**：`online` 数据新鲜 / `stale` 有值但过旧 / `offline` 无数据 / `blank` 采集异常
- **监控**：前台服务保活，按规则比对并推通知，离线/恢复都提醒，重复告警去重
- **历史**：自动采样落盘（值变了才写，稳定期 1 小时一次心跳），可查 6/24 小时折线
- **导出**：跑完自动打包 zip，走系统分享面板发出去
- **账号**：账号表可界面编辑，也可直接改原始 CSV

## 二、编译

前置：JDK 17、Android SDK（compileSdk 34）、Gradle 8.x。

```bash
# 告知 SDK 位置（该文件不入库）
echo "sdk.dir=/path/to/Android/sdk" > local.properties

# 构建
build.bat assembleRelease          # Windows
```

产物：`app/build/outputs/apk/release/app-release.apk`

### 签名

仓库**不含签名密钥**。没有密钥时 `build.gradle` 自动回落到 debug 签名，
保证 clone 下来就能打出可安装的包。要发布自己的版本，请自建密钥：

```bash
keytool -genkeypair -v -keystore keystore/usrcloud.jks -keyalg RSA -keysize 2048 \
        -validity 10950 -alias usrcloud -storepass <密码> -keypass <密码>
```

密码不要写进仓库，可用环境变量传入：

```bash
set USRCLOUD_STORE_PWD=xxx
set USRCLOUD_KEY_PWD=xxx
```

## 三、数据存哪

| 数据 | 位置 |
| --- | --- |
| 账号表 | `/data/data/org.usrcloud.xunjian/files/accounts.csv` |
| 巡站截图 | `.../files/巡站截图/<批次>/<账号名>/*.png` |
| 导出 zip | `/storage/emulated/0/Android/data/org.usrcloud.xunjian/files/` |
| 历史数据 | `.../files/历史数据_YYYY-MM.csv` |
| 登录缓存 | `.../files/登录缓存/` |

截图写在应用私有目录，所以 Android 11+ 不需要「所有文件访问权限」；
导出走系统分享面板，可另存到「文件」或发给自己。

## 四、注意

- 锁竖屏
- 巡站时尽量别切走太久，系统可能回收后台进程
- 包名是 `org.usrcloud.xunjian`，与旧包不同，**无法覆盖安装**旧版本

## 五、许可

MIT。第三方客户端，与有人云平台官方无关。
