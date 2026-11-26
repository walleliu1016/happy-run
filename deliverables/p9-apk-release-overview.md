# TV APK · GitHub Release 下载交付（p9，版本化修正版）

## 下载地址（Release 跟版本走，一版一个 Release）

| 项目 | 地址 |
|---|---|
| **最新版直链**（自动指向最新版本） | https://github.com/walleliu1016/happy-run/releases/latest/download/app-release.apk |
| **v1.2 版本直链**（当前版本，地址带版本号） | https://github.com/walleliu1016/happy-run/releases/download/v1.2/app-release.apk |
| Releases 页（所有版本列表，按版本挑） | https://github.com/walleliu1016/happy-run/releases |
| 安装/遥控操作说明 | 仓库 `tv-app/README.md` |

当前版本：**v1.2**（versionCode 3），约 785 KB，安装到电视后加载线上游戏，游戏更新不用重装。

## Release 流程（跟版本走）

1. **游戏网页改动** → 部署 workbuddy 即生效，APK 不用动。
2. **TV 壳改动**（`tv-app/**`）→ git push 后 CI 自动出包：
   - 构建 workflow：`.github/workflows/tv-apk.yml`（Gradle 8.9 + JDK 17，签名密钥 CI 缓存，历次出包签名一致可覆盖升级）；
   - 出包后挂到 **Release，tag = `v<版本号>`**（本次 `v1.2`），标题带版本号、置顶 latest——
     下载地址跟版本走：`.../releases/download/v1.2/...`，下个版本就是 `.../download/v1.3/...`。
3. 升级电视版：从 Release 下新 `app-release.apk` 覆盖安装——签名一致，直接升级不丢数据。

> 旧的滚动 tag `tv-apk`（地址永远不变那种）已废弃删除，CI 里带幂等清理步骤，
> 永远不会再出现一个「万年不变地址」的 Release。

## 本版（v1.2）内容

- TV 遥控按键全兼容：老键名 `'Left'/'Up'...`、纯 keyCode（37-40/13/23/32/66/4）、新键名 `Arrow*` 三路都认——老盒子方向键复活。
- WebView `requestFocus` 保活 + DPAD/OK 用 `dispatchKeyEvent` 显式转发，焦点不再被系统吃掉。
- 游戏 URL 缓存戳升到 `&v=1.2`，电视端自动拉新版。

## 安装（两种方式，详见 tv-app/README.md）

- **U 盘**：下载 APK → 拷 U 盘 → 电视「文件管理器」安装（需开「未知来源」）。
- **ADB**（同一 WiFi）：`adb connect 电视IP:5555 && adb install app-release.apk`。

## 事实边界

- 本机无 Android SDK，APK 由 **GitHub Actions CI** 构建（全部构建记录全绿），本地不出包。
- APK 是 WebView 壳：游戏本体在网页，改游戏不需要重新下载 APK。
- versionName 与游戏 URL 缓存戳 `&v=` 对齐（现 1.2），发新版时同步 bump。
