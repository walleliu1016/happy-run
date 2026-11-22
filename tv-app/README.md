# 律动跑酷 TV 版（happy-run-tv）

把「律动跑酷」装进电视的 APK：**WebView 壳**（内置浏览器内核）加载线上游戏，
遥控器 D-pad 操作菜单，手机扫码连摄像头做体感。游戏更新改网页即生效，**APK 永远不用重装**。

> 为什么是 WebView 壳而不是原生重写：游戏本体是 Web 游戏（Three.js + WebRTC + WebAudio），
> TV 端职责只有「大屏渲染 + 遥控输入 + 出声」。原生重写 = 同一游戏维护两份代码，
> 而且 Miracast 等投屏协议无论原生与否都拿不到系统权限，原生无协议收益。

## 安装到电视（以索尼 BRAVIA 为例）

**方式一：U 盘（最简单）**
1. 从 [Releases · tv-apk](https://github.com/walleliu1016/happy-run/releases/tag/tv-apk) 下载 `app-release.apk`，拷进 U 盘
2. U 盘插电视 → 电视「文件管理器 / Media Player」里找到 APK → 安装
3. 若提示禁止安装：`设置 → 应用 → 安全和限制（安全）→ 未知来源` 打开（允许该安装器）
4. 装完在电视桌面「应用」里找到「律动跑酷」（有横幅卡片）

**方式二：ADB（免 U 盘，同一 WiFi）**
```bash
# 电视：设置 → 关于 → 连按 7 次「版本号」开启开发者 → 开发者选项里开「网络调试/ADB」
adb connect 电视IP:5555
adb install app-release.apk
```

## 遥控器操作

| 按键 | 菜单 / 结算屏 | 游戏对局中 |
|---|---|---|
| 方向键 | 移动焦点（金色大光环） | ↑跳 ↓蹲 ←→换道/侧移 |
| OK / 确认 | 触发焦点按钮 | 跳 |
| 返回 | 上一层（主页再按 = 退出） | 退出对局回菜单 |

玩法定位：电视出画面和声音，**手机扫码当体感手柄**（游戏里「📱 手机识别」模式），
或直接用遥控器方向键当按键玩（备用交互）。

## 构建

**CI（推荐）**：推送/改动 `tv-app/**` 自动出包并挂到 Release（tag `tv-apk`）。

**本地**：需要 JDK 17 + Android SDK（API 34）+ Gradle 8.9：
```bash
# 先准备签名密钥（仅本机，不入库）：
mkdir -p ~/.android && keytool -genkeypair -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=HappyRun TV, O=HappyRun, C=CN"

cd tv-app && gradle :app:assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

## 签名说明

- 默认用 `~/.android/debug.keystore`（CI 首次自动缓存生成，后续出包签名一致，电视可直接覆盖升级）。
- 想换正式签名：生成自己的 keystore 放到 `~/.android/debug.keystore`（或改 `app/build.gradle.kts`
  的 signingConfigs 指向），私钥**不要进仓库**；需要 CI 稳定正式签名时，把 base64 后的 keystore
  配成仓库 Secret `ANDROID_KEYSTORE_BASE64`，再在 workflow 里解码使用。
- APK 不含任何密钥/凭证；游戏地址是公开 URL。

## 更新游戏

游戏改完网页部署即生效，APK 不用动。仅当**游戏地址（含 sharecode）变化**时才需要改
`app/src/main/java/com/happyrun/tv/MainActivity.kt` 里的 `gameUrl` 并重出包。

## 结构

```
tv-app/
├── app/src/main/java/com/happyrun/tv/MainActivity.kt  # WebView 壳全部逻辑（~200 行）
├── app/src/main/AndroidManifest.xml                   # leanback 桌面 + 常规桌面
├── app/src/main/res/                                  # 横幅 / 图标（各密度 PNG）
└── build.gradle.kts 等                                # 零第三方依赖，纯 android SDK
```
