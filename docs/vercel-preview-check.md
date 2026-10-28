# Vercel 预览部署：只读核验结果和访问保护方案

> 只读核验，**没有修改任何 Vercel 设置**，没有删除部署，也没有创建分享链接。
> 核验时间：2026-10-28；核验时分支最新提交 `6fbbc22`。

## 1. 核验结果

| 项目 | 结果 | 来源 |
|---|---|---|
| Vercel 项目 | `xiaomi-jizhang`（`prj_Ik0ig4yTqhqkVI6dq2Az51CVpWKL`），团队 `xiangmi0523-4826` | Vercel API（只读） |
| 正式部署 | 最新的生产部署仍是 `main` `3200d30`；生产域名 `xiaomi-jizhang.vercel.app`、`xiaomi-jizhang-app.vercel.app` | Vercel API |
| 功能分支的部署 | `feat/h3-frontend` 每推送一次就自动生成一个**预览部署**（target 为空，不是生产），到核验时共 12 个，全部是 READY 状态 | Vercel API |
| 分支固定别名 | `xiaomi-jizhang-git-feat-h3-frontend-xiangmi0523-4826.vercel.app`，**始终指向这个分支的最新构建** | 最新预览部署的 alias |
| 访问保护 | `ssoProtection`（Vercel 登录保护）：**关闭**；`passwordProtection`（密码保护）：**关闭**；`trustedIps`（IP 白名单）：**关闭** | 项目设置 |
| 环境变量 | 没有（0 个） | Vercel API（只列名字，没有解密） |
| 后端配置 | Supabase 地址 `https://vpgqzdkpoidudibsquhx.supabase.co` 和公开密钥（publishable key）**写死在 `www/js/cloud.js` 里**，不区分环境 | 仓库代码 |
| 有没有 `vercel.json` | 没有（默认设置：每个分支每次推送都自动部署） | 仓库 |

**没能直接验证的：** 在本会话里从公网匿名打开预览链接，被会话的网络白名单挡住了。Vercel 自带的抓取工具会在部署上创建临时分享链接，相当于新建一个访问凭据，未经批准**没有使用**。「任何拿到链接的人都能打开」这个结论，依据是项目设置里三种保护都关闭；**在真机或电脑浏览器的无痕窗口里打开分支别名，可以直接确认**（见第 4 节第 1 步）。

## 2. 结论：预览站仍可能连接生产 Supabase

- 预览站部署的就是功能分支的 `www/`，配置写死，所以**任何预览站打开后，连的都是生产 Supabase**。
- 访问保护全部关闭，**拿到链接的任何人都能打开**。分支别名是固定的、可以猜到格式的地址。
- 如果有人在预览站用**真实账号**登录：
  - 生产库还没执行 `restore_epoch.sql`，读不到 `xm_meta`，新代码会按「服务器没装协议」照常同步。也就是说，**未发布的新代码会读写生产账本**（普通的记账、修改、删除都会写进生产库）。
  - 「导入备份」会被拒绝（提示云端还没升级），不会调用恢复 RPC。
  - 「从快照恢复本机」只在这个浏览器里进行，不碰云端；但之后「恢复云同步」会读生产库。
- 生产库靠行级安全（RLS）隔离账号：别人只能看到和改动**自己**的账本，看不到别人的。所以风险是「用未发布的代码改自己的真实账本」，而不是数据泄露。
- 原生 App 不受影响：App 里的网页打包在 IPA 里，不从 Vercel 加载。

## 3. 访问保护方案（待批准，本次没有执行）

| 方案 | 做法 | 效果 | 影响和代价 |
|---|---|---|---|
| **P1（推荐先做）开启 Vercel 登录保护（Standard Protection）** | Vercel 控制台 → 项目 → Settings → Deployment Protection → Vercel Authentication 选「Standard Protection」；或者 API 把 `ssoProtection` 设为 `{ deploymentType: "preview" }` | 所有预览部署和分支别名都要先登录 Vercel 账号（并且是团队成员）才能打开 | **不影响生产域名** `xiaomi-jizhang.vercel.app` / `xiaomi-jizhang-app.vercel.app`（它们仍是公开的网页版）。Hobby 方案就能用，可以随时关掉。改的是项目设置，所以需要批准 |
| P2 功能分支不自动部署 | 仓库加 `vercel.json`：`{"git":{"deploymentEnabled":{"main":true,"*":false}}}`，或在控制台设置「Ignored Build Step」 | 以后功能分支推送不再生成预览 | `vercel.json` 是代码改动：放在功能分支上会马上对这个分支生效；合并后对所有分支生效。已经存在的预览部署还在，仍然需要 P1 或 P3 |
| P3 删除已有的预览部署 | 控制台或 API 逐个删除 `feat/h3-frontend` 的部署 | 旧链接失效 | 不可恢复，需要批准；之后的新推送仍然会生成新的预览，除非同时做 P2 |
| P4 预览站连测试用的 Supabase | 把 Supabase 配置改成按域名或环境区分，预览站连一个独立的测试项目 | 预览站碰不到生产数据 | 代码改动 + 新建 Supabase 项目 + 维护测试数据；工作量最大，本阶段不建议 |
| P5 密码保护 / IP 白名单 | Deployment Protection 里的 Password Protection / Trusted IPs | 同 P1 | 需要付费方案（Pro 附加功能或 Enterprise） |

**推荐：** 先做 **P1**（一项设置、可以撤回、不影响生产网页版）。如果不需要预览站，再加 **P2**。P3、P4 等需要时再定。

## 4. 批准后的执行和验证步骤（供参考）

1. **执行前：** 在电脑浏览器的无痕窗口打开分支别名 `https://xiaomi-jizhang-git-feat-h3-frontend-xiangmi0523-4826.vercel.app`，确认现在能直接打开（证实第 1 节的结论）。**不要登录。**
2. 开启 P1。
3. **执行后：**
   - 同一个无痕窗口刷新：应该跳转到 Vercel 登录页；
   - 打开生产域名 `https://xiaomi-jizhang.vercel.app`：应该仍然能直接打开网页版；
   - 截图留证。
4. **回滚：** 把 Vercel Authentication 改回 Disabled。

## 5. 推送本文档本身的影响

本次只提交文档。但推送到 `feat/h3-frontend` 时，Vercel 仍会**按现有设置**再生成一个预览部署（Vercel 不认 `[skip ci]`）。这个预览的网页代码和 `313bf7b` 完全相同，风险和第 2 节一样，直到执行保护方案为止。
