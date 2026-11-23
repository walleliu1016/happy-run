# 交付总览 · 线上 PK 关卡上线 + 部署吐旧版根治（2026-11-23）

## 做了什么

本轮完成「线上 PK 关卡」玩法全链路，并根治了线上吐旧版 HTML 的部署事故。

## 线上 PK 关卡（不是排行榜比分，是对战玩法）

- 海报墙第 7 张「PK 对战」卡 → 填昵称 → 匹配 → VS 卡 3 秒倒计时 → 同谱面同时开跑
- 对战条实时显示对手分数/进度（1 秒轮询互报），完赛出胜负卡（胜/负/平/弃权）
- 「再来一局」= 重新匹配；匹配 6 秒没真人 → 自动配「XXX的影子」（优先用最近真人成绩曲线合成）
- 零后端实现：纯 Node 内存态对战 API（pk-api.mjs），匹配/互报/双向幂等结算

## 部署事故根因与修复（本次「点进去变老版本、PK 和设置消失」的原因）

- 根因：平台 deploy 只传源码、**不传 dist/ 构建产物**；此前我把 start 脚本改成
  `node server.mjs` 后，沙盒里托管的是陈旧/缺失的 dist → 线上吐 17KB 旧版 HTML
- 修复：对战 API 抽成 `pk-api.mjs` 单一实现，挂进 vite dev 中间件（vite.config.ts
  configureServer），删掉 start 脚本让 deploy 归位 vite dev 模式（历史 100% 成功的形态）
- 线上实测：29KB 新版 HTML（screen-pk/设置/关卡墙全在）+ PK API 全通 + HTML
  `cache-control: no-cache`+etag（WebView 每次协商最新，不会再锁旧版）

## 期间影响

两次失败的部署尝试期间，分享链接曾短暂打不开；现已恢复并验证。

## 关键决策

- vite dev 作为唯一线上形态：源码即时编译永远最新，且平台探测稳定；server.mjs 仅留本地
  生产模式测试用（文件头已注明勿配为 start）
- PK API 共用一份（pk-api.mjs），vite 中间件与 server.mjs 同 import，不双写

## 交付物

- 线上链接（不变）：https://wbapp-yzfyjhdipy6i6cwc3v0zk2.app.workbuddy.host/?sharecode=T42CWLJYMM
- APK 1.1 无需重装：加载的就是线上 URL，打开即新版；若仍见旧界面，杀掉 APP 重进即可
- GitHub：44c47ca 已推 main
