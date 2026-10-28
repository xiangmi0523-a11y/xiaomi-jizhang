# 晓米记账 · 自动化回归测试

只用于开发和 CI：不会被打进 IPA（打包只带 `www/`），也不会部署到 Vercel（项目根目录是 `www/`）。

## 怎么跑

```bash
npm install                              # 只装开发依赖 @playwright/test 1.56.0
npx playwright install --with-deps chromium
npm test                                 # = npx playwright test
```

GitHub Actions：`.github/workflows/tests.yml`，任何分支推送、PR 都会自动跑；不打包、不发布、不部署、不需要密钥。

## 原理

- `tests/support/server.js`：零依赖的静态服务器，原样提供 `www/`，地址 `http://127.0.0.1:4173`（用 127.0.0.1 而不是 localhost，不会注册 Service Worker）。
- `tests/support/fixtures.js`：`openApp()` 打开一台「设备」（独立浏览器 context = 独立 localStorage），可以固定时间、预置账本、模拟原生壳、强制登录门。每台设备自带护栏：
  - 除本地服务器和假 Supabase 外的任何请求都会被拦截；**只要出现一次发往 `*.supabase.co` 的请求，测试直接失败**。
  - 页面 JS 报错（pageerror / console.error）让测试失败。
- `tests/support/mock-supabase.js`：测试进程内存里的假 Supabase（注册 / 登录 / 刷新令牌 / PostgREST 查询、upsert、标记删除），模拟 RLS（只能读写自己的行）和 `updated_at` 触发器。每个测试一份全新的，跑完就没了。
- 时区固定 `Asia/Shanghai`，手机尺寸 390×844。

## 测试清单

| 文件 | 内容 |
|---|---|
| `01-boot` | 启动无报错、模块齐全、默认账本结构、首次保存、四个页面切换、登录门、原生 save 消息 |
| `02-money-dates` | 金额按「分」换算 / 显示 / 算式、收支合计与账户余额；时区、跨月跨年闰年、日期文字、周期日期月底处理、按月筛选排序 |
| `03-storage` | localStorage 保存与恢复、自动保存、数据损坏恢复、原生文件优先、数据清洗、旧备份补默认值、操作前备份、CSV 防公式 |
| `04-record-flow` | 通过界面记支出 / 收入 / 转账、算式、校验提示、连点防重复、金币奖励 / 不重复奖励 / 删除收回、每日上限、签到 |
| `05-recurring-lock` | 单设备周期记账补记、不重复、月底、停用；密码锁解锁、输错 5 次锁 30 秒、切后台上锁、不存明文 |
| `06-cloud-mock` | （假 Supabase）请求头、首次上传、两台设备双向同步与删除、空同步、账号隔离与越权写入被拒、错误提示、令牌刷新、自动同步、断网、登录门注册 / 退出、换账号、原生桥 |
| `07-known-bugs` | 审计报告的 H1–H4：H1、H2 目前「预期内失败」，修好后会提醒把标记去掉；H3、H4 已修复，是正式断言（H3 在假 Supabase 上验证「没装恢复协议时拒绝恢复」，完整恢复流程见下面的 `tests/real/30-restore`） |

## 已知缺陷的写法（07-known-bugs）

准备步骤和前置检查照常断言（出错就是真失败）；最后一步先 `test.fail()`，再按「修好后应有的正确行为」断言。
缺陷还在 → 断言失败 → 显示为预期内失败；缺陷修好 → Playwright 报「本应失败却通过」→ 删掉那行 `test.fail()` 即可。

## 测试时观察到、但本阶段不修的问题（待统一处理）

- 【N1】「云端同步」面板开着时，App 任何一次重绘都会重画面板、清空已输入的邮箱和密码。启动后约 1 秒内就有定时重绘，所以测试里先等启动定时任务跑完再填表（见 `fixtures.js` 的 `settle`）。

## 没覆盖到的

- 真机 WKWebView / Safari（只在 Chromium 上跑）、iOS 原生层（Swift：文件存储、iCloud 备份、面容 ID、通知、小组件、液态玻璃底栏）。
- 真实 Supabase 的 RLS / 触发器 / pg_cron 月报（只用假服务模拟了行为）。
- 音效、动画、截图级的界面外观；客栈、猫咪、存钱计划、智能预算、分类预算等玩法的细节。
- Service Worker 离线缓存（测试里刻意关掉了）。

## 恢复协议（H3）的数据库测试 · `tests/db/`

不经过浏览器，直接在真实 PostgreSQL + 真实 PostgREST 上验证 `supabase/restore_epoch.sql`。不需要 npm 依赖。

```bash
node tests/db/run.mjs          # 起临时 PostgreSQL 和 PostgREST，跑全部 *.test.mjs，结束后清理
node tests/db/mutate.mjs       # SQL 变异测试：逐个拆掉防护，对应测试必须失败
XM_PG_URL=postgres://postgres@localhost:5432/postgres node tests/db/run.mjs   # 改用现成的数据库（CI 用 postgres:17）
```

- 同时建两个库：`xm_base`（现状，没有协议）用来**复现问题**，`xm_prot`（加了协议）用来**验证防护**。
- `supabase-emulation.sql` 模拟 Supabase 的角色、`auth.uid()` 和默认权限（public 里新建的对象默认授权给 anon），业务对象由非超级用户 `xm_owner` 创建，与 Supabase 的 `postgres` 角色一致。
- 并发测试用交互式 psql 会话精确控制两个事务的先后，并检查对方确实在等锁。
- `supabase-stack-smoke.mjs` 只在 CI 里跑：用 Supabase 官方 CLI 起本地服务栈，经过真实网关和认证再验证一遍。
- 测试专用的触发器（模拟篡改、崩溃、慢网络）只对单个测试用户生效，测试结束即删除。

## 前端 + 真实数据库端到端 · `tests/real/`（Phase 2B）

浏览器里的 App → 测试网关（模拟 GoTrue、转发 PostgREST，可装钩子：抢先恢复、丢响应、去请求头、注入失败）→ 真实 PostgREST → 真实 PostgreSQL（含 `restore_epoch.sql`）。

```bash
npx playwright test -c playwright.real.config.js      # 起临时 PostgreSQL + PostgREST，跑全部 tests/real/*.spec.js
node tests/real/mutate-frontend.js [关键词]            # 前端变异测试：逐个拆掉 www/ 里的一处防护，对应用例必须失败
XM_BIG_RECORDS=13000 npx playwright test -c playwright.real.config.js -g 大数据量   # 换一个数据量测恢复耗时
XM_EXTRA_SQL=supabase/proposals/2b3-restore-apply-timeout.sql npx playwright test -c playwright.real.config.js   # 评估待审核的数据库提案
```

| 文件 | 内容 |
|---|---|
| `10-epoch` | 2B-1：没迁移的服务器照常同步、所有写请求带 `x-xm-epoch`、409 处理不无限重试、请求头被去掉时暂停、旧版 App（main 上的前端）被挡住、换账号 |
| `20-rebase` | 2B-2：另一台设备恢复后，本机快照 → 未同步的新增 / 修改 / 删除 / 整块设置进冲突箱 → 对齐；快照或冲突箱写不进去时不覆盖；并发记账；冲突处理幂等、不重复发奖励 |
| `30-restore` | 2B-3：通过界面导入备份恢复（H3）；无效备份不发请求；apply 响应丢失后重试同一任务；连点；上传中断 / 封存后被杀再重开；另一台设备抢先恢复（取消 / 继续）；旧备份缺可选模块；恢复前后的本机修改进冲突箱；开始恢复瞬间的自动同步；本机快照写不进去；语句超时；没装协议的服务器；大数据量耗时 |
| `40-durable` | 方案 A（假原生层）：回执的各种故障（失败、永不回执、延迟、编号错、字节数错、SHA-256 错、迟到、重载后到达、没有能力声明 / 版本不同）；网页版存储写不下时安全停止；暂存 / 提交失败、提交途中被杀、提交完成但回执丢失、等回执时又记账；跨批次去重；4 万笔大账本；快照清理规则 |
| `50-local-restore` | 「从快照恢复本机」：界面流程、无网络请求、epoch 保持当前、冲突箱保留、暂停同步与重启、恢复云同步、撤销、失败回滚与中断、快照校验、重复操作、网页版 |

### 假原生层（`tests/support/fake-native.js`）

`openApp({ durable: {} })` 会在 Node 进程里模拟 `ios/Sources/DurableStore.swift` 的协议 v1：
- 文件存在 Node 内存里，页面重载后还在；
- SHA-256 用 Node `crypto` 独立计算；
- 普通保存和持久化请求按收到的顺序执行。

测试里的常用操作：
- `page.native.fault({ op, mode })`：注入回执故障；
- `page.reloadNative()`：模拟 App 被杀后重开（原生启动恢复 → 注入正式账本 → 重新加载）；
- `page.releaseReceipts()`：放行扣住的回执。

真机上的文件系统、`F_FULLFSYNC`、WKWebView 的消息通道**不在这里验证**，见阶段报告里的真机待测清单。

## 原生持久化的单元测试 · `ios/Tests/`

`DurableStore` 的 XCTest，在 macOS 上运行（文件系统语义与 iOS 相同）。用独立的 XcodeGen 配置，不改正式的 `project.yml`。由 `.github/workflows/build-ipa-test.yml` 在 macOS runner 上执行：

```bash
xcodegen generate --spec ios/Tests/project-tests.yml
xcodebuild test -project ios/Tests/XiaomiStoreTests.xcodeproj -scheme XiaomiStoreTests -destination 'platform=macOS'
```
