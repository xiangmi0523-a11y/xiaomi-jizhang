# 交接文档：Phase 2B-1 / 2B-2 已完成 → Phase 2B-3 待开发

> **更新：2B-3 已完成，见 `docs/phase2b-report.md`。** 与本文第 3.4 节的一处差异：恢复改为「apply 成功之前本机不动，成功后复用 2B-2 的对齐流程」，原因见报告第 2 节。

> 分支：`feat/h3-frontend`（基于 `feat/h3-restore-protocol`）。**未合并 main，未执行生产迁移，未发布 IPA，未部署。**
> 服务端协议的权威定义是 `supabase/restore_epoch.sql` 和 `docs/restore-protocol.md`，本文只记录前端如何对接，参数以 SQL 为准。

## 0. 当前状态一览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 2A | 服务端：epoch、写入保护触发器、暂存 / 封存 / 单事务应用 RPC | 已完成（`feat/h3-restore-protocol`），待审核 |
| 2B-1 | `cloud.js` 接入 epoch：请求头、409、启动 / 登录 / 回前台读版本号、旧版兼容 | **已完成** |
| 2B-2 | 本机快照 + 冲突箱 + 与云端对齐（rebase） | **已完成** |
| 2B-3 | `restore.js` + 恢复确认界面 | **未开始**（没有任何代码） |

本次收尾时实际运行的测试（全部在 2B-2 最终代码上）：

| 测试 | 结果 |
|---|---|
| 原有 Playwright 回归（`CI=1 npx playwright test`） | 60 / 60 通过（H1/H2/H3 已知问题按预期失败计为通过） |
| 真实后端端到端（`npx playwright test -c playwright.real.config.js`） | 12 / 12 通过（`10-epoch` 6 项 + `20-rebase` 6 项） |
| 数据库协议（`node tests/db/run.mjs`） | 46 / 46 通过 |
| 前端变异测试（`node tests/real/mutate-frontend.js`） | 13 个变异全部被发现，0 漏掉 |

收尾时修过一处：`10-epoch` 的 409 用例原先断言「409 后本机账本里还有那笔账」，这是 2B-1 时的行为。2B-2 起发现版本号变化会自动对齐，那笔账进入冲突箱。断言改为「冲突箱里有且只有一条 pending 的 add，原始备注完整」，并断言本机账本已与云端一致。改后的断言比原来更严格。

---

## 1. 2B-1：`www/js/cloud.js` 怎么处理 epoch

### 1.1 状态字段

```js
App.cloud = C = {
  busy,           // 是否正在同步
  proto,          // 服务器是否装了恢复协议：true / false / null（还不知道）
  serverEpoch,    // 最近一次读到的云端 epoch
  halted,         // '' | 'epoch-header'（409 但版本号没变）| 'stale-loop'（连续对齐失败）
  staleRetry,     // 409 后自动重试次数（最多 2 次）
  err, last, ...
}
App.S.sync = {    // 存在账本里，随账本一起保存
  uid, at, epoch, // epoch：本机认为自己基于的云端版本号（整数）；旧版 App 升级上来时可能没有
  t: {
    xm_records | xm_accounts | xm_categories | xm_cats: { since, h: {key: rowHash}, init },
    xm_state: { since, h, rh, base, init }   // base = 上次同步后整块设置的样子（2B-2 新增）
  }
}
```

### 1.2 关键函数

| 函数 | 作用 |
|---|---|
| `isDataWrite(method, path)` | 非 GET 且路径是 `/rest/v1/xm_*` 就算数据写入 |
| `SB.call(...)` | 数据写入自动加请求头 `x-xm-epoch: C.writeEpoch()`。失败时错误对象带 `status / code / hint / details`；`e.stale = (status === 409 && hint === 'xm_stale_epoch')` |
| `SB.readMeta()` | 读 `xm_meta`，返回 `{ protocol, epoch }`。404 / `PGRST205` / `42P01` 视为服务器没装协议，返回 `protocol: false` |
| `C.writeEpoch()` | `proto === false` 时返回 `null`（不带请求头，兼容没迁移的服务器）；`proto === true` 且本机 epoch 是整数时返回该值；**其他情况一律抛 `xm_no_epoch`，不会不带请求头偷偷写入** |
| `C.checkEpoch()` | 每次同步都先调用。返回 `'normal'` 或 `'rebase'`。本机有 epoch：相等为 normal，否则为 rebase。本机没有 epoch：从没同步过或云端是 0，就直接采用云端版本；否则按落后处理（rebase） |
| `C.onStale()` | 写入收到 409 时调用：重读 meta。版本号确实变了，就在 300ms 后再同步一次（会走 rebase），最多 2 次，超过则 `halted = 'stale-loop'`。版本号没变（多半是请求头被网关去掉），就设 `halted = 'epoch-header'` 并给出明确提示 |
| `C.sync(manual)` | 流程：`checkEpoch` → `rebase` 或普通同步（各表 + `xm_state`）。成功后清除 `halted / staleRetry`。暂停中只有手动同步才会再试 |
| `saveSession` | 换账号时重置 `halted / staleRetry / proto` |

没有新增任何函数包装。`App.flush` 仍然只被 bridge.js 和 cloud.js 各包一层，`App.cloud.sync` 仍然只被 auth.js 包一层。

---

## 2. 2B-2：快照、冲突箱、与云端对齐

### 2.1 对齐流程 `C.rebase(stat)`（cloud.js）

1. 调 `App.conflicts.snapshot(batch)`：把整份账本存进 `localStorage['xm_snap_rebase']`，并通过原生层另存一个文件「晓米记账-对齐前备份-日期时间.json」。**写入失败就抛 `xm_snapshot_failed`，本机数据不动。**
2. 全量拉取 4 张表和 `xm_state`。这一步不改本机。
3. 再读一次 meta。如果版本号在拉取期间又变了，就抛 `xm_rebase_moved`，本机不动。
4. 以下步骤在同一段同步代码里完成，中间没有 `await`，用户无法插入操作：
   - `C.pendingChanges()` 重新找出未同步的修改，包括拉取期间新记的；
   - `App.conflicts.protect(...)` 写进冲突箱并确认落盘，**失败就抛 `xm_protect_failed`，并回滚 `S.conflicts`，本机不覆盖**；
   - 用云端数据覆盖本机各表，重建 `S.sync.t`（since、h、init）；
   - 用 `stateIn` 写入云端的整块设置（`LOCAL_ONLY` 设置保持本机的），并重建 `xm_state` 基线。
5. `S.sync.epoch = target`；调 `App.conflicts.prune(batch)`，把已与云端一致的项自动关闭；弹 toast 提示冲突条数。

`C.pendingChanges()` 的判断依据：
- 每张表用「本机行指纹」对比 `tm.h` 基线：基线里没有为 add，指纹不同为 edit，基线里有但本机没了为 delete。
- `xm_state` 的整体指纹 ≠ `sm.h` 时，逐个模块对比 `sm.base`，找出改过的模块（budget、recurring、game、smart、saving、settings、created）。

### 2.2 冲突箱数据结构（`App.S.conflicts`，存在账本里）

```js
{
  id:     `${batch}|${table}|${key}`,   // 唯一键；同一批次重复调用 protect 只更新、不重复
  batch:  `${uid}:${targetEpoch}`,
  src:    'rebase' | 'import',          // 'import' 留给 2B-3：这台手机导入备份覆盖云端
  from:   本机原 epoch | null,
  to:     对齐到的 epoch,
  at:     放进冲突箱的时间,
  table:  'xm_records' | 'xm_accounts' | 'xm_categories' | 'xm_cats' | 'xm_state',
  key:    记录 id / 账户 id / 分类 id / 猫咪 id / 设置模块名,
  kind:   'add' | 'edit' | 'delete' | 'state',
  local:  本机的原始内容（深拷贝；delete 时为 null）,
  status: 'pending' | 'applied' | 'discarded' | 'same',
  doneAt: 处理时间
}
```

待处理项永久保留；处理过的项保留 30 天。

### 2.3 `www/js/conflicts.js` 对外接口

| 接口 | 说明 |
|---|---|
| `App.conflicts.all()` / `.pending()` | 全部项 / 待处理项 |
| `.snapshot(id)` | 覆盖本机之前的快照；失败抛 `xm_snapshot_failed` |
| `.lastSnapshot()` | 读最近一份快照 `{id, at, data}` |
| `.protect(batch, {src, from, to}, items)` | 写入冲突箱并**立即落盘**（localStorage 加原生 save）；失败回滚并抛 `xm_protect_failed`。已处理过的项不会被覆盖 |
| `.prune(batch)` | 与当前本机（即云端）一致的项标为 `same` |
| `.resolve(id, 'apply' \| 'discard')` | 幂等：只处理 pending 项。apply 时直接改数组或对象，**不经过** `addRecord / deleteRecord / rewardRecord`，所以不会重复发金币、签到、盲盒进度、猫咪心情，也不会退金币。状态和修改在同一次 `App.flush()` 里保存，之后由普通同步上传 |
| `App.A.openConflicts()` | 冲突箱界面，支持逐条处理和「全部加回去 / 全部不要」 |

其他界面接入点：
- 云端同步面板显示「冲突箱 N 条」入口（`data-cl="conflicts"`），`C.status()` 末尾追加「· 冲突箱 N 条」；
- 退出登录确认框在有待处理冲突时额外警告（auth.js）；
- 样式在 `style.css` 的「v4.8 冲突箱」段（`.cf-*`）。

### 2.4 修改文件清单（2B-1 + 2B-2）

- **前端：**
  - `www/js/cloud.js`
  - `www/js/conflicts.js`（新）
  - `www/js/auth.js`
  - `www/index.html`（`conflicts.js` 放在 `cloud.js` 之后）
  - `www/css/style.css`
  - `www/sw.js`（`python3 tools/gen_sw.py 4.8-1` 生成，`VERSION = xm-v4.8-1`，预缓存已包含 `conflicts.js`）
- **测试：**
  - `tests/db/env.mjs`（新）、`tests/db/run.mjs`
  - `tests/real/*`（新：网关、夹具、旧版对照服务器、变异）
  - `tests/support/fixtures.js`
  - `playwright.real.config.js`（新）
- **CI：** `.github/workflows/tests.yml` 新增 `e2e-real` 任务（postgres:17 + PostgREST，跑真实后端用例和前端变异）

---

## 3. 2B-3 要做什么

### 3.1 新建 `www/js/restore.js`（`App.restore`）

- 职责：备份校验、恢复任务状态机、暂存上传、封存、应用、重试、恢复后对齐。
- `cloud.js` 只保留通用请求、epoch 和同步协调，**不要再包任何全局函数**。
- 加载顺序：在 `index.html` 里放在 `conflicts.js` 之后、`auth.js` 之前。改完后运行 `python3 tools/gen_sw.py <新版本号>` 重新生成 `sw.js`。

建议的接口：

```js
App.restore = {
  validate(raw)       → { ok, errors[], scope, rows: {table: [{h,row}]}, statePatch, manifest }
  start(raw)          → 校验通过后：准备本机 → 创建任务 → 暂存 → 封存 → 应用
  run()               → 从 localStorage 读取未完成的任务并继续（启动、回前台、C.sync 调用）
  cancel()            → 调 xm_restore_cancel 并清掉本地任务
  job()               → 当前本地任务或 null
}
```

### 3.2 需要对接的服务端 RPC（参数以 `supabase/restore_epoch.sql` 为准）

通过 `SB.call('POST', '/rest/v1/rpc/<name>', { body })` 调用。RPC 不是 `xm_*` 表路径，所以不会自动加 `x-xm-epoch`，这是正确的：RPC 自己做校验。

| RPC | 参数 | 前端要点 |
|---|---|---|
| `xm_restore_create` | `p_job uuid, p_scope jsonb` | `p_job` 由前端生成并**先存进本地任务再调用**，响应丢失时用同一个 id 重试 |
| `xm_restore_stage` | `p_job, p_table, p_rows [{h,row}]`（每批 ≤ 500） | 记下每张表已暂存到第几批，可断点续传 |
| `xm_restore_seal` | `p_job, p_manifest {table:{count,digest}}, p_state_patch` | digest 计算方法见 3.3 |
| `xm_restore_apply` | `p_job, p_expected_epoch int` | 单事务、幂等。**响应丢失时用同一个 job 再调一次，绝不新建任务**。成功返回新 epoch |
| `xm_restore_cancel` | `p_job` | 用户放弃时调用 |

错误按 `hint` 区分：

- `xm_epoch_changed`：确认期间别的设备又恢复了。询问用户后，用**同一个已封存任务**和新的 expected epoch 再 apply，或者取消。
- `xm_bad_state`：任务状态不对（例如已应用）。先查询并接管，不要当作「未开始」。
- `xm_manifest_mismatch`、`xm_verify_failed`：备份或暂存数据不一致，停止并提示，**不 apply**。
- `xm_bad_scope`、`xm_bad_row`、`xm_bad_manifest`、`xm_too_large`：校验失败，提示用户。
- `xm_too_many_jobs`：提示稍后再试，或先取消旧任务。
- `xm_not_found`：任务不存在。如果本地记录显示已经 apply 过，就读 meta 确认 epoch。

### 3.3 备份校验和数据准备（前端可以直接调用的现有接口）

- 必需模块：records、accounts、cats（分类）。`App.normalize` 前后记录数必须相同，id 必须唯一；带 `_manifest` 的备份要先对清单。**无效备份不得调用 apply。**
- 恢复范围只看原始备份里有哪些键：
  - 备份里有 `game.cats` 才包含 `xm_cats`；
  - 设置模块只包含备份里实际存在的模块；
  - `settings` 去掉 `C.kit.LOCAL_ONLY` 里的键。
  - 旧备份缺少的可选模块不进入 `p_state_patch`，这样云端和本机原有的设置都不会被清空。
- 构造行：用 `C.kit.TABLES[i].toRow(item)`，`h = C.kit.rowHash(t, row)`。这样恢复后本机基线和云端一致，不会触发整库重新上传。
- digest：把每行写成 `rkey + '\t' + h`，按 UTF-8 字节序排序，用 `\n` 连接，再算 sha256（十六进制）。**要用纯 JS 实现 SHA-256**，因为 `xiaomi://` 协议下 `crypto.subtle` 可能不可用。
- 本地任务持久化：`localStorage['xm_restore_job_v1'] = { id, uid, phase: 'created'|'staging'|'sealed'|'applying'|'applied', staged: {table: n}, expectedEpoch, scope, at }`。每次进入下一阶段**之前**先保存。

### 3.4 本机准备和恢复后对齐

**apply 之前：**
1. 把这台手机未同步的修改放进冲突箱：`App.conflicts.protect(batch, {src: 'import', from, to}, C.pendingChanges())`；
2. 调 `App.conflicts.snapshot(...)`；
3. 用备份覆盖本机（`replaceState`），然后恢复 `S.sync`（uid、epoch，基线取自备份行的 h），并保留本机的 `LOCAL_ONLY` 设置。

**apply 成功之后：**
1. `S.sync.epoch = result.epoch`，基线设为备份行的 hash；
2. 跑一次普通同步。

**`C.sync`：**
- 本地存在未完成任务时，先调 `App.restore.run()`，期间不做普通写入。

### 3.5 界面接入点

- **`mine.js` 的 `openData` 导入入口：** 改为先进入恢复确认页。确认页需要展示：
  - 当前账号；
  - 恢复范围（包含哪些模块）；
  - 「云端现有账单会被软删除，可在冲突箱或快照中找回」；
  - 「其他设备上的旧版 App 需要升级，否则无法再同步」；
  - 「这台手机未同步的修改会进入冲突箱」；
  - 旧备份没有清单时的提示。
- **`dataExport`：** 导出时去掉 `sync` 和 `conflicts`，并加上 `_manifest`。
- **退出登录和 H4 重置：** 都要清掉本地恢复任务；有未完成任务时给出警告。
- **防重复点击：** 恢复按钮点一次后锁定；任务 id 只生成一次。

### 3.6 还欠的测试（审核要求，2B-3 必须补上并真实运行）

- apply 已成功但响应丢失：重试不会重复应用，epoch 只加 1；
- 恢复中断、杀掉 App 重启、重复点击：都继续原任务，已封存的任务不会被当成「未开始」；
- 旧备份缺少可选模块：走界面完整流程，云端和本机的设置不会被清空；
- 大量记录（接近 20000 行上限）和超时：`authenticated` 角色的语句超时是 8s，需要实测或明确记录限制；
- `tests/e2e/07-known-bugs` 里的 H3 用例目前直接调用 `replaceState`（预期失败），要改成走导入界面，2B-3 完成后应转为通过；
- 给 `restore.js` 补前端变异测试，加到 `tests/real/mutations.js`。

---

## 4. 剩余风险（2B-3 之前和之中都要记住）

1. **生产库结构没有对比过。** `restore_epoch.sql` 只在测试库验证过，上线前要先对比生产 schema，再走审核和迁移流程。
2. **托管网关是否放行 `x-xm-epoch` 没有验证。** 需要确认 Supabase 线上网关的 CORS 允许这个请求头，否则网页版会一直触发 `halted = 'epoch-header'`。
3. **H2 没修。** `xm_state` 在普通同步里仍然是整块后写覆盖先写；冲突箱只在对齐（rebase）时保护整块设置。
4. **`xm_rebase_moved` 和对齐失败** 只设置 `C.err`，等下一次自动同步（回前台或有改动时）再试，没有专门的定时重试。
5. **快照只保留最近一份**（`xm_snap_rebase`）。原生侧另存的文件不会被覆盖。
6. **8 秒语句超时**：大账本 apply 可能超时，需要 2B-3 实测。
7. **「接管」界面没有做**：用户在恢复确认页之外看不到「别的设备正在恢复」的状态。

## 5. 分支情况

- `feat/h3-restore-protocol`：服务端协议（2A）。
- `feat/h3-frontend`：本分支（2B-1 + 2B-2 + 本文档）。
- `fix/test-route-teardown`：测试收尾修复，未合并。
- 本地另有一个空置分支 `feat/h3-restore-frontend`（`320cbd4`），没有动过、没有推送，可以删除。
- `main` 仍是 `3200d30`，最新发布仍是 v1.0.35。
