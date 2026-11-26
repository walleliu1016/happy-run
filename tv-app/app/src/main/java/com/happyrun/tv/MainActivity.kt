package com.happyrun.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast

/**
 * 律动跑酷 TV 壳：WebView 加载线上游戏。
 *
 * 设计边界：游戏本体是 Web 游戏（Three.js + WebRTC + WebAudio），TV 端只负责
 * 「大屏渲染 + 遥控器输入 + 出声」，因此不做原生重写——游戏更新改网页即生效，
 * APK 永远不用重装。两条路子（浏览器 / APK）跑的是同一份代码。
 *
 * 原生增强（相对裸壳）：
 *  - 常亮 + 全屏沉浸（电视息屏/状态栏不打扰）
 *  - 音频免手势自动播放（WebView 默认拦截，这里放开）
 *  - 遥控器返回键：单按 = 网页内返回/退出对局（window.__tvBack），双按 = 退出应用
 *  - TV 形态识别（UiModeManager）：电视设备给网页加 &tv=1，网页跳体检 + 遥控提示 + 菜单等比放大
 *  - 断网兜底错误页（一键重载）
 *  - D-pad / OK 键显式转发给 DOM（焦点链路兜底），由网页 tvnav 做焦点导航
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var lastBackAt = 0L
    private var lastKeyAt = 0L // 长按 repeat 限速，避免 50ms/发把网页焦点计算压垮

    // 线上游戏地址。游戏更新自动生效，无需重装 APK。
    // TV 设备附加 &tv=1：网页据此进入大屏形态（跳体检 / 遥控提示条 / 菜单等比放大）。
    // &v= 版本戳：升级安装后 URL 变化，旧 WebView 缓存自然失效（缓存键不同）；
    // 服务端对 HTML 发 no-cache 头，之后每次启动都协商到最新版，大资源仍走缓存。
    private val gameUrl: String
        get() = "https://wbapp-yzfyjhdipy6i6cwc3v0zk2.app.workbuddy.host/?sharecode=T42CWLJYMM&v=1.5" +
            if (isTv()) "&tv=1" else ""

    private fun isTv(): Boolean {
        val uiModeManager = getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
        return uiModeManager.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 常亮：健身游戏不能中途息屏
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUi()

        web = WebView(this)
        setContentView(FrameLayout(this).apply { addView(web) })

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // TV 上无触摸：放开自动播放
            cacheMode = WebSettings.LOAD_DEFAULT
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        // 排障用：Chrome inspect:// 可连上看控制台（发布版可关）
        WebView.setWebContentsDebuggingEnabled(true)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean = false // 站内导航都留在壳里

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 遥控「开箱即用」：页面加载完立刻把视图焦点给 WebView，
                // 不用用户先点一下屏幕方向键才有反应
                view?.requestFocus()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame == true) {
                    view?.loadDataWithBaseURL(null, errorHtml(), "text/html", "utf-8", null)
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?,
            ) {
                // API 21/22 走旧回调
                view?.loadDataWithBaseURL(null, errorHtml(), "text/html", "utf-8", null)
            }
        }
        // 键控焦点保活：不设的话部分盒子上 WebView 拿不到 view 焦点，
        // 方向键被 Activity 焦点链路吃掉，只剩 OK（合成点击）能用
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        web.requestFocus()
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
                Log.d(TAG, m?.message() ?: "")
                return true
            }
        }
        web.loadUrl(gameUrl)
    }

    /** 遥控器按键：返回键交给网页钩子；D-pad/OK 显式下发给 DOM（网页 tvnav 处理） */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            web.evaluateJavascript("window.__tvBack ? window.__tvBack() : 0") { handled ->
                if (handled == "1") return@evaluateJavascript // 网页内已处理（退对局/回上屏）
                val now = System.currentTimeMillis()
                if (now - lastBackAt < 1500) {
                    finish()
                } else {
                    lastBackAt = now
                    Toast.makeText(this, "再按一次返回退出", Toast.LENGTH_SHORT).show()
                }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /**
     * 遥控按键 = 单一确定性管道：D-pad/OK 的 ACTION_DOWN 直接注入 JS（window.__tvKey），
     * 不再「先试 WebView 再兜底」——WebView.dispatchKeyEvent 返回 true 不代表
     * DOM 收到（焦点被系统吃掉时它照样吞键），双路转发不确定性太强。
     *
     * P16 灵敏度/卡顿修复：
     *  ① ACTION_UP 不再注入：网页侧只有 keydown 消费者，UP 那次跨桥纯属浪费，每键调用减半；
     *  ② 长按 repeat 限速 90ms：系统 repeat 约 50ms 一发，会把网页几何计算压垮（另在
     *     tvnav.ts 也做了一层节流，浏览器直连路径同样生效）。首次按下不受限，零延迟。
     * 已知取舍：文本框内方向键不再移动光标（TV 上文本输入靠 IME，影响可忽略）。
     */
    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        if (event == null) return super.dispatchKeyEvent(event)
        val name = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
            KeyEvent.KEYCODE_SPACE -> " "
            else -> null
        }
        if (name == null) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) {
            val now = System.currentTimeMillis()
            val isRepeat = event.repeatCount > 0
            if (!isRepeat || now - lastKeyAt >= 90L) {
                lastKeyAt = now
                web.evaluateJavascript(
                    "window.__tvKey&&window.__tvKey('$name',false,$isRepeat)"
                ) {}
            }
        }
        return true
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.requestFocus() // 从屏保/别的应用回来遥控立刻可用
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** 断网兜底页：一键重载回游戏 */
    private fun errorHtml(): String = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin:0; height:100vh; display:flex; flex-direction:column; align-items:center;
         justify-content:center; gap:18px; background:#0b1020; color:#eee;
         font-family:sans-serif; text-align:center; }
  h2 { font-size:34px; margin:0; }
  p { font-size:20px; opacity:.75; margin:0; }
  button { font-size:22px; padding:14px 34px; border-radius:16px; border:0;
           background:#ffb020; color:#222; }
</style>
<h2>网络连接失败</h2>
<p>电视没能打开游戏，请检查 WiFi 后重试</p>
<button onclick="location.href='$gameUrl'">重新加载</button>"""

    private companion object {
        const val TAG = "HappyRunTV"
    }
}
