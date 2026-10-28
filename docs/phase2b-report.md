# Phase 2B 阶段报告：前端协议接入、冲突箱、备份恢复（2B-1 / 2B-2 / 2B-3）

> 分支 `feat/h3-frontend`（基于 `feat/h3-restore-protocol`）。**未合并 main，未执行生产迁移，未发布 IPA，未部署。**
> 服务端协议（Phase 2A）没有改动；新发现的数据库问题只写成**待审核提案**（`supabase/proposals/`），没有并入迁移脚本。

## 1. 结论

- **H3 已在前端端到端修复。** 登录状态下「导入备份」不再直接覆盖本机，而是走服务端恢复任务：校验 → 确认页 → 建任务 → 分批暂存 → 封存核对 → 单事务应用（epoch +1）。应用之后本机自动对齐。云端和本机都回到备份，再同步也不会把新账单合并回来；其他设备按 epoch 自动对齐。
- **测试全部实际运行：**
  - 原有 Playwright 60 / 60；
  - 真实后端端到端 27 / 27（2B-1 6 项、2B-2 6 项、2B-3 15 项）；
  - 数据库协议 46 / 46；
  - 前端变异 运行中（结果见后续提交）。
- **两个需要审核的发现**（详见第 7 节）：
  1. `xm_restore_apply` 在约 1.3–2 万行时超过 Supabase 默认的 8 秒语句超时。事务整体回滚、云端不变，前端已能明确提示。附数据库提案和评估结果：待评估。
  2. 2B-2 的「对齐前本机快照」存在 localStorage。账本很大时（Chromium 上约 1.5 万笔以上，iOS 可能更低）快照写不进去，对齐会安全地暂停。数据不会丢，但会卡住。修复需要改核心存储或原生层，先请审核方案。

## 2. 修改文件清单和关键函数

### 2B-3（本阶段）

| 文件 | 改动 |
|---|---|
| `www/js/restore.js`（新） | `App.restore`：校验、导出格式、恢复任务状态机、界面（确认页、进度面板）；纯 JS SHA-256 |
| `www/js/cloud.js` | `C.sync` 开头先推进恢复任务（`R.step`），没生效就不做普通同步；`C.rebase(stat, info)` 可以标注来源（导入备份）、快照名和提示；状态行和云端面板显示恢复进度 |
| `www/js/conflicts.js` | `snapshot(id, label)`：快照文件名可指定（「恢复前备份」） |
| `www/js/mine.js` | 「导入备份」改为 `A.importBackup`；「导出备份」改用 `App.restore.exportText()` |
| `www/js/backup.js` | 自动备份与导出同一格式（带校验信息，不含同步记录和冲突箱） |
| `www/js/auth.js` | 退出登录：确认框提示；在云端取消未生效的恢复任务，清掉本机任务 |
| `www/js/main.js` | 密码锁「忘记密码 → 重置」（H4）时清掉本机恢复任务 |
| `www/index.html` / `www/sw.js` / `www/css/style.css` | 加载 `restore.js`（在 `conflicts.js` 之后、`auth.js` 之前）；SW 版本 `xm-v4.9-1`，预缓存含 `restore.js`；确认页 / 进度样式 |
| `tests/real/30-restore.spec.js`（新） | 15 项真实后端端到端 |
| `tests/real/mutations.js` | 新增 16 个 2B-3 变异，并更新 3 个因为 2B-3 改了原文的旧变异（共 29 个） |
| `tests/e2e/07-known-bugs.spec.js` | H3 由「预期内失败」改为正式断言，走导入界面 |
| `tests/db/env.mjs` | `XM_EXTRA_SQL`：只用于评估待审核的数据库提案，默认不加载 |
| `supabase/proposals/2b3-restore-apply-timeout.sql`（新） | 提案，**未批准**，不在迁移脚本里 |
| `tests/README.md`、本报告 | 文档 |

### `App.restore` 关键函数

| 函数 | 说明 |
|---|---|
| `validate(raw)` | **不发任何请求**。依次检查：<br>• 新格式备份的校验码：键排序后的 JSON 算 sha256，与 `_manifest.sha256` 对比；<br>• 必需模块：账单、账户、分类；<br>• `normalize` 前后条数一致（不丢账）；<br>• 每张表编号唯一；<br>• 总行数 ≤ 20000。<br>然后算出：<br>• 恢复范围：有 `game.cats` 才包含 `xm_cats`；整块设置只放原始 JSON 里真有的模块，`settings` 去掉只属于本机的键；<br>• 每行的 `{h, row}`：复用 `cloud.js` 的 `toRow` / `rowHash`；<br>• 清单 `{count, digest}`：与 `xm_restore_seal` 同一算法 |
| `exportObject()` / `exportText()` | 导出：去掉 `sync`、`conflicts`，加 `_manifest`（时间、各类条数、sha256） |
| `start(v)` | 读 epoch，确认服务器装了协议。本机落后或从没同步过时先同步一次。**不先上传本机未同步的修改**（它们之后进冲突箱）。然后生成任务编号，任务和待上传的行**先存进 localStorage 再发请求**。从开始到建好任务期间，挡住其他自动同步 |
| `step()` | 由 `C.sync` 调用的状态机：`new → staging → sealing → sealed → applied`。每一步都以服务器为准（见第 3 节）。返回 `true` 才继续对齐或普通同步 |
| `cancel()` / `answer(go)` / `retry()` / `abandon()` / `clear()` | 取消（只能取消未生效的任务）；另一台设备抢先恢复时由用户选「继续覆盖」或「取消」；重试；退出登录；H4 重置 |
| `rebaseInfo()` / `synced()` | 恢复生效后交给 `C.rebase` 的标注（来源 `import`、快照名、提示）；本机对齐到新 epoch 后清掉任务 |
| `A.importBackup` / `A.restoreConfirm` / `A.openRestore` | 导入入口、确认页、进度面板 |

### 与交接文档的一处差异（请审核）

交接文档建议在 apply **之前**就用备份覆盖本机。实现时改为：**apply 成功之前本机一点不动**；apply 成功后，复用 2B-2 已测试过的对齐流程：快照 → 未同步修改进冲突箱 → 用云端（这时等于备份）覆盖本机。

理由：
- 取消、失败、中断时本机没有任何东西需要撤销；
- 对齐代码只有一份；
- 恢复前没同步的修改、恢复途中新记的账，都按同一规则进冲突箱。

代价是对齐需要从云端全量拉一次。1 万笔约 0.8 秒。

## 3. 前后端请求协议和模块依赖

**加载顺序：** `cloud.js` → `conflicts.js` → `restore.js` → `auth.js`。

三个模块初始化时互不调用，全部是运行时按需引用，所以没有循环依赖。也**没有新增任何全局函数包装**：`App.flush`、`App.cloud.sync`、`App.deleteRecord` 的包装层数和调用顺序都没变。

- `restore.js` 用到：
  - `App.supabase.call / select / readMeta / user`；
  - `App.cloud.sync / schedule / paint / kit`（`kit` 只读）；
  - `App.conflicts.pending`；
  - `App.normalize`。
- `cloud.js` 用到（存在时才调用）：`App.restore.pending / step / rebaseInfo / synced / status`。

| 步骤 | 请求 | `x-xm-epoch` | 失败和重试 |
|---|---|---|---|
| 确认版本 | `GET /rest/v1/xm_meta` | 不带（读） | 404 → 服务器没装协议，拒绝恢复 |
| 建任务 | `POST /rest/v1/rpc/xm_restore_create {p_job, p_scope}` | 不带（RPC 自己校验 `auth.uid()`） | 网络错误：同一个 `p_job` 重试（幂等）；`xm_too_many_jobs` 等：中止，什么都没改 |
| 暂存 | `POST …/rpc/xm_restore_stage`，每批 ≤ 500 行 | 不带 | 记录每张表传到第几批，断点续传；`xm_bad_state` → 查任务状态接着做 |
| 封存 | `POST …/rpc/xm_restore_seal {p_manifest, p_state_patch}` | 不带 | `xm_manifest_mismatch` → 整份重传一次再封存，第二次仍不符就取消；`xm_bad_state` → 查状态 |
| 应用 | `POST …/rpc/xm_restore_apply {p_job, p_expected_epoch}` | 不带 | 网络错误或响应丢失 → 任务保持「已封存」，重试同一任务（服务器返回原结果）；`xm_epoch_changed` → 停下来问用户；`xm_verify_failed`、语句超时 → 停下来，用户选重试或取消 |
| 查任务 | `GET /rest/v1/xm_restore_job?job_id=eq.…` | 不带 | 遇到 `xm_bad_state` 时以服务器为准：applied / sealed / staging / cancelled |
| 取消 | `POST …/rpc/xm_restore_cancel` | 不带 | 已生效的不能取消 |
| 对齐 | 普通同步：`checkEpoch` → 发现 epoch 变了 → `C.rebase` 全量拉取 | 之后的写入带新 epoch | 快照或冲突箱写不进去 → 不覆盖本机，任务保持「已生效」，可以重试 |

`x-xm-epoch` 只加在写 `/rest/v1/xm_*` 数据表的请求上（2B-1 的 `isDataWrite`），RPC 路径 `/rest/v1/rpc/…` 不匹配，由服务器在函数里校验。

**任务记录：**
- `localStorage['xm_restore_job_v1']`：任务编号、账号、阶段、expected epoch、范围、清单、整块设置补丁、已传批次、错误；
- `localStorage['xm_restore_payload_v1']`：待上传的行，封存后删除。存不下时只放在内存里，这时如果中途 App 被杀，会提示重新导入；云端和本机都没改动。

## 4. 测试结果（全部在最终代码上实际运行）

| 测试 | 结果 |
|---|---|
| 原有 Playwright（`CI=1 npx playwright test`） | **60 / 60 通过**。H1、H2 仍是「预期内失败」，计为通过；H3 已改为正式断言并通过 |
| 真实后端端到端（`npx playwright test -c playwright.real.config.js`） | **27 / 27 通过**，3.7 分钟 |
| 数据库协议（`node tests/db/run.mjs`） | **46 / 46 通过** |
| 前端变异（`node tests/real/mutate-frontend.js`） | **运行中（结果见后续提交）** |
| 纯 JS SHA-256 和清单摘要 | 与 Node `crypto` 和服务器算法对比 359 组（含中文、emoji、分块边界长度），0 处不一致 |

### `tests/real/30-restore.spec.js`（2B-3，15 项）

1. **H3 修复**：导出 → 又记一笔并同步 → 通过界面导入：
   - 云端 epoch 1、多出的那笔被软删除、整块设置回到备份；
   - 恢复期间 A 没直接写数据表；
   - 本机回到备份，再同步两次也不合并回来；
   - 另一台设备自动对齐。
2. **无效备份**（校验码不符、坏日期、重复编号、没有账户、没有分类、猫咪格式错）：一个恢复请求都不发，本机和云端都不动，提示具体原因。
3. **apply 已成功但响应丢了**：本机保持「已封存」、账本不动；重试同一任务，服务器返回原结果；epoch 只 +1，存档只有一份。
4. **连点「开始恢复」**：只建一个任务。
5. **上传到一半断网，App 被杀后重开**：接着同一任务，只补传没传完的批次（1203 笔，5 批中补 2 批）。
6. **已封存还没应用时 App 被杀**：重开后直接应用同一任务，不重新建任务、不重新上传。
7. **另一台设备抢先恢复，选「取消恢复」**：等待期间自动或手动同步都不擅自继续；取消后云端保持另一台设备的恢复，本机跟着对齐。
8. **另一台设备抢先恢复，选「继续覆盖」**：同一个已封存任务在新 epoch 上应用（epoch 2）。
9. **旧版备份**（没有校验信息、只有必需模块）：
   - 确认页说明「旧版备份」「备份里没有…保留云端现有的」；
   - 恢复后预算、存钱计划、金币、猫咪都保留云端原值，`xm_cats` 没被软删除。
10. **恢复前没同步的修改（新增、修改）和恢复途中新记的账**：都进冲突箱（来源 `import`）；从没上过云；快照里有；「加回去」后正常上云。
11. **点「开始恢复」的瞬间正好有一次自动同步**：那次同步被挡住，没同步的修改不会被抢先传上去再被删掉。
12. **恢复已在云端生效，但本机快照写不进去**：本机不覆盖、提示原因、不能取消；腾出空间后点「现在重试」完成对齐。
13. **服务器没装恢复协议**：登录状态下导入被拒绝，提示明确，不发任何恢复请求。
14. **大数据量**：10003 笔走完整界面流程，各阶段耗时见第 6 节。
15. **apply 撞上语句超时**：明确提示「备份太大」，不自动反复重试；取消后云端和本机都不变。

### 审核要求的测试 ↔ 用例

| 要求 | 用例 |
|---|---|
| 所有相关写入都带正确 epoch | `10-epoch` #2；`30-restore` #10（恢复后写入 epoch = 1） |
| 409 时暂停写入、读新 epoch、安全对齐 | `10-epoch` #3 #4；`20-rebase` #4 |
| 两台设备并发记账与恢复 | `20-rebase` #4；`30-restore` #1 #7 #8 |
| 第二台设备的未同步新增、编辑、删除完整保留 | `20-rebase` #1；`30-restore` #10 |
| 本机快照完成前不得覆盖本机账本 | `20-rebase` #2；`30-restore` #12 |
| apply 成功但响应丢失 | `30-restore` #3 |
| 恢复中断、应用重启、重复点击 | `30-restore` #4 #5 #6 #11 |
| 冲突箱重复处理不重复生成记录或奖励 | `20-rebase` #5 |
| 旧备份缺少可选模块不清空设置 | `30-restore` #9 |
| 旧版客户端失败提示明确、不无限重试 | `10-epoch` #5 |
| 大量记录和超时 | `30-restore` #14 #15，以及第 6 节的实测 |

**未覆盖：**
- 真机 WKWebView（localStorage 配额、`crypto.getRandomValues`、原生 http 层超时）；
- 托管 Supabase 网关；
- iOS 原生快照文件是否真的写成功（原生层没有回执）。

## 5. 现有 60 项 Playwright

全部通过（1.9 分钟）。`07-known-bugs` 的 H3 用例原来直接调用 `replaceState`，现在改为走「数据与备份 → 导入备份 → 开始恢复」的界面。假 Supabase 没有 `xm_meta`，所以断言的是「拒绝恢复、本机和云端都不变、不会合并回来」；完整恢复流程由 `30-restore` #1 在真实数据库上验证。

## 6. 真实恢复流程：大数据量实测（测试库，本机 Chromium）

| 账单数 | 结果 | apply 耗时 | 上传+封存+应用 |
|---|---|---|---|
| 10,003 | 通过（CI 默认用这个数量） | 0.8–3.6 秒（多次运行） | 5–9 秒 |
| 13,003 | 通过 | 5.5 秒 | 11.9 秒 |
| 16,003 | **云端应用成功**；本机对齐时快照写不进 localStorage，**安全暂停**（本机不覆盖，提示「手机存储空间不足」） | — | — |
| 19,903 | **apply 超过 8 秒被取消**，事务整体回滚，云端不变 | > 8 秒 | — |

暂存每批（500 行）最慢约 0.3–0.4 秒，封存 < 0.03 秒。

## 7. 剩余风险

1. **apply 语句超时（新发现，需要审核）。** 提案 `supabase/proposals/2b3-restore-apply-timeout.sql`：只给 `xm_restore_apply` 设 `statement_timeout = 60s`（PostgREST 12 会以事务级生效），不改角色默认值。评估：待评估。未批准前，前端遇到超时会明确提示并停下，不会反复重试。
2. **本机快照受 localStorage 配额限制（2B-2 设计限制，新发现）。** 快照和账本主副本都在 localStorage 里，大账本时快照写不进去，对齐就会暂停。这样是安全的，但用户腾不出空间就会一直卡住。WebKit 对中文内容可能按 2 字节/字符计算，所以 iOS 上的阈值可能比 Chromium 的约 1.5 万笔更低。可选方案（都涉及核心模块，先请审核）：
   - (a) 原生层收到快照后回执「已写入文件」，有回执就算快照完成。需要改 Swift、重新打包 IPA；
   - (b) 快照改存 IndexedDB（配额大得多），需要先在 `xiaomi://` 自定义协议下真机验证可用；
   - (c) 只把「会被覆盖的部分」写进快照，而不是整份账本。
3. **生产库结构没有比对过**（禁止连接生产库）：迁移前要先比对 `schema.sql` 和线上库。
4. **托管网关是否放行 `x-xm-epoch` 请求头**（CORS）没有验证。不放行的话，网页版会暂停自动同步，并提示「版本校验没通过」。
5. **接管界面没做**：另一台设备看不到别人未完成的恢复任务。云端每个账号最多 3 个未完成任务，被丢弃的任务（H4 重置、离线时退出登录）会占名额，占满后提示「稍后再试」，目前没有清理机制。
6. **旧版备份没有校验信息**：只能提示用户确认文件来源。新导出的备份和自动备份都带校验信息。
7. **待上传的行太大存不进 localStorage 时只放在内存里**：这时如果中途 App 被杀，要重新导入（会明确提示；云端和本机都没改动）。
8. **设计取舍**：恢复期间本机新记的账不会自动上传，生效后进冲突箱，由用户「加回去」。
9. **H1（周期账单重复）、H2（整块设置后写覆盖）没有修。**
10. **只在 Chromium 上测过**，没有在真机 WKWebView 上测。

## 8. Git

- 分支：`feat/h3-frontend`，已推送；`main` 仍是 `3200d30`。
- 提交：
  - `26bc7d2` Phase 2B-1；
  - `cff26e8` Phase 2B-2 和交接文档；
  - （本提交） Phase 2B-3。
- 2B-3 的 diff 摘要：见 git log --stat
