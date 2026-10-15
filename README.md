# 有人云巡站（Android）

[有人云](https://www.usr.cn) 平台的第三方 Android 客户端：批量巡检设备、
自动截图归档、离线/数据陈旧告警、历史数据折线图。纯原生 Java + WebView，
没有内置 Python，APK 约 1.5 MB。

当前版本 **v0.32**（与 `versionName` / 界面「关于」页显示一致）。

> 本仓库是**干净版本**：`assets/accounts.csv` 只有表头，不含任何账号、密码、
> 登录缓存或巡检数据，也不含任何公司标识。装好后在「账号」页自己添加账号。

## 一、功能

- **巡站**：按账号批量拉取设备最新值，Android Canvas 直接画卡片图，4 路并发，约 0.3 s/台
- **状态判定**：`online` 数据新鲜 / `stale` 有值但过旧 / `offline` 无数据 / `blank` 采集异常
- **监控**：前台服务保活，按规则比对并推通知，离线/恢复都提醒，重复告警去重
- **历史**：自动采样落盘（值变了才写，稳定期 1 小时一次心跳），可查 6/24 小时折线
- **导出**：跑完自动打包 zip，走系统分享面板发出去
- **账号**：账号表可界面编辑，也可直接改原始 CSV

### v0.32 新增

- **长按站名直接复制**：监控页设备列表里长按站名约半秒，完整站名进系统剪贴板。
  复制的是完整原文；复制完设备行不会跟着展开（长按抬起的那次点击会被吞掉）；
  短按仍是展开/收起；手指滑动会取消长按，不会边滚边复制。
- **「⟳ 刷新这台」挪到右上角**：展开站点后，按钮从变量表下方挪到展开区顶部右侧，
  和数据时间同一排，变量多的站点不用滚到底才能找到。
- **单变量刷新**：变量表每行当前值后面多了个蓝色 ⟳，只刷这一个变量——
  只就地更新该行的值和数据时间，其它行不动、整卡不重绘、滚动位置不跳；
  结果写回内存快照，翻页回来不跳回旧值；平台这次数据里没有该变量时会如实说明。

### 同版本修订

- **2026-10-15（版本号仍为 0.32）**：修「设置巡检间隔后界面不刷新」。
  原来设完直接调 `renderWatch()`，渲染的是内存里的旧快照，
  分段控件高亮和「启动后每 X 自动巡检一次」的文案都停在旧值，
  要切到别的页再切回来才更新；改为先 `pollWatch(true)` 重拉状态再重绘。

## 二、编译

前置：JDK 17、Android SDK（compileSdk 34）。Gradle 不用装，仓库自带 Wrapper（8.7）。

```bash
# 告知 SDK 位置（该文件不入库）
echo "sdk.dir=/path/to/Android/sdk" > local.properties      # macOS / Linux
echo sdk.dir=C:\\path\\to\\Android\\sdk  > local.properties # Windows

# 构建
./gradlew assembleRelease          # macOS / Linux
build.bat assembleRelease          # Windows（自动探测 JDK 与 SDK）
```

首次运行 Wrapper 会下载 Gradle 8.7（约 120 MB），之后走缓存。
`build.bat` 依次从 `JAVA_HOME` / `ANDROID_SDK_ROOT`、`TC` 环境变量、
常见安装位置、`local.properties` 里探测工具链，找不到会明确报错而不是静默失败。

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

### 版本号怎么改

三处必须同步，改一处会不一致：

| 位置 | 字段 |
| --- | --- |
| `app/build.gradle` | `versionCode` / `versionName` |
| `app/src/main/assets/index.html` | `<span class="ver" id="hver">` |

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
- 包名是 `org.usrcloud.xunjian`，与其他包不同，**无法覆盖安装**别的包
- 「单台刷新」「单变量刷新」都只影响该站点，不会改变整体「上次巡检」时间戳
- 平台对同一用户有线频（官方口径 100 次/10 秒），正常手动操作远达不到

## 五、许可

MIT。第三方客户端，与有人云平台官方无关。
