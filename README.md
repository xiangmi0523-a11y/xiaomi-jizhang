# 晓米记账

一个只属于自己的本地记账 App（iPhone）。数据只保存在手机里，没有账号、不联网。

- 网页界面在 `www/`，由 iOS 原生外壳（WKWebView）加载
- 推送到 `main` 分支后，GitHub Actions 会自动在 macOS 上编译出未签名的 `XiaomiJizhang.ipa`，并发布到 Releases
- 在手机上下载 IPA → 导入「全能签」→ 签名安装

下载最新版：`https://github.com/<用户名>/<仓库名>/releases/latest/download/XiaomiJizhang.ipa`

## 本地预览网页
```
cd www && python3 -m http.server 8000
```
