// 前端变异清单：[文件, 原文, 替换] + 用哪些测试去抓（-g 关键词）
'use strict';
module.exports = [
  { name: '写入不带版本号请求头', grep: '所有写请求都带', edits: [['js/cloud.js', "if (ep != null) h['x-xm-epoch'] = String(ep);", '']] },
  { name: '版本号未确认时也照样写（不带请求头）', grep: '恰好被另一台设备恢复', edits: [['js/cloud.js', "const e = new Error('还没确认云端账本版本，暂不上传'); e.code = 'xm_no_epoch'; throw e;", 'return null;'], ['js/cloud.js', "if (Number.isInteger(m.epoch)) return m.epoch === r.epoch ? 'normal' : 'rebase';", "if (Number.isInteger(m.epoch) && m.epoch !== r.epoch) { m.epoch = undefined; return 'normal'; }"]] },
  { name: '版本号落后时直接采用云端版本号（跳过对齐）', grep: '恰好被另一台设备恢复', edits: [['js/cloud.js', "if (Number.isInteger(m.epoch)) return m.epoch === r.epoch ? 'normal' : 'rebase';", "if (Number.isInteger(m.epoch)) { m.epoch = r.epoch; return 'normal'; }"]] },
  { name: '409 后不暂停、一直自动重试', grep: '请求头没送到服务器', edits: [['js/cloud.js', "      C.halted = 'epoch-header';", "      clearTimeout(timer); timer = setTimeout(() => C.sync(false), 300);"]] },
  { name: '换账号时不清除暂停状态', grep: '换了账号', edits: [['js/cloud.js', "if (before !== after && App.cloud) { App.cloud.halted = ''; App.cloud.staleRetry = 0; App.cloud.proto = null; }", '']] },
  { name: '对齐前不存快照', grep: '本机快照没写成功', edits: [['js/cloud.js', '    App.conflicts.snapshot(batch, info && info.label);\n', '']] },
  { name: '对齐时不把未同步修改放进冲突箱', grep: '全部原样进冲突箱|静默丢掉', edits: [['js/cloud.js', "    App.conflicts.protect(batch, { src: (info && info.src) || 'rebase', from, to: target }, pending);", '']] },
  { name: '冲突箱写入失败时不回滚', grep: '冲突箱写不进去', edits: [['js/conflicts.js', '    catch (e) { App.S.conflicts = keep; throw', '    catch (e) { throw']] },
  { name: '冲突处理不幂等', grep: '冲突箱重复处理', edits: [['js/conflicts.js', "    if (!c || c.status !== 'pending') return false;", '    if (!c) return false;']] },
  { name: '加回去时触发记账奖励', grep: '冲突箱重复处理', edits: [['js/conflicts.js', "    if (action === 'apply') applyItem(c);", "    if (action === 'apply') { applyItem(c); if (c.table === 'xm_records' && c.kind !== 'delete') App.game.rewardRecord(null, c.local); }"]] },
  { name: '整块设置不看基线（所有模块都进冲突箱）', grep: '整块设置', edits: [['js/cloud.js', 'if (!sm.base || JSON.stringify(cur[mod]) !== JSON.stringify(sm.base[mod]))', 'if (true)']] },
  { name: '拉取期间新记的账不重新收集', grep: '两台设备并发', edits: [['js/cloud.js', "    const pending = C.pendingChanges();\n    App.conflicts.protect", "    const pending = early;\n    App.conflicts.protect"], ['js/cloud.js', '    App.conflicts.snapshot(batch, info && info.label);\n', '    App.conflicts.snapshot(batch, info && info.label);\n    const early = C.pendingChanges();\n']] },
  { name: '暂停后自动同步照样进行', grep: '请求头没送到服务器', edits: [['js/cloud.js', 'if (C.halted && !manual) return false;', '']] },
  // ---- Phase 2B-3：备份恢复（restore.js）----
  { name: '导出的备份仍带同步记录', grep: 'H3 修复', edits: [['js/restore.js', 'delete o.sync; delete o.conflicts; delete o._manifest;', 'delete o.conflicts; delete o._manifest;']] },
  { name: '不核对备份校验码', grep: '无效备份', edits: [['js/restore.js', 'if (sha256(stable(o)) !== man.sha256)', 'if (false)']] },
  { name: 'normalize 丢掉坏账单也照样恢复', grep: '无效备份', edits: [['js/restore.js', '    if (lost) errors.push(', '    if (false) errors.push(']] },
  { name: '应用成功之前就先覆盖本机账本', grep: '响应丢了', edits: [['js/restore.js', "      notice = ''; tries = 0;\n", "      notice = ''; tries = 0; App.S.records = v.L.records;\n"]] },
  { name: 'apply 响应丢失后另起新任务', grep: '响应丢了', edits: [['js/restore.js', '      throw e;   // 网络断了、响应丢了', "      job.id = uuid(); job.phase = 'new'; job.staged = {}; save(); throw e;   // 网络断了、响应丢了"]] },
  { name: '连点「开始恢复」不防重', grep: '连点', edits: [['js/restore.js', '    if (starting) return false;\n', ''], ['js/restore.js', '          if (starting || b.disabled) return;\n', ''], ['js/restore.js', "    if (job) throw fail('上一次的恢复还没完成", "    if (false) throw fail('上一次的恢复还没完成"], ['js/restore.js', "      if (job) throw fail('已经有一个恢复任务在进行了');", '']] },
  { name: '断点续传不跳过已传完的批次', grep: '上传到一半断网', edits: [['js/restore.js', 'for (let i = job.staged[t] || 0; i < n; i++)', 'for (let i = 0; i < n; i++)']] },
  { name: '重启后把已封存的任务当成未开始', grep: '已封存、还没应用', edits: [['js/restore.js', 'let job = load(), mem = null, tries = 0, sheet = null;', "let job = load(), mem = null, tries = 0, sheet = null; if (job && job.phase === 'sealed') { job.phase = 'staging'; job.staged = {}; }"]] },
  { name: '另一台设备抢先恢复时不问用户、直接覆盖', grep: 'epoch_changed', edits: [['js/restore.js', '        job.ask = { epoch: ep }; save(); paint();\n        return;', '        job.expected = ep; save(); return doApply();']] },
  { name: '等待用户确认期间自动同步照样推进任务', grep: 'epoch_changed', edits: [['js/restore.js', '    if (job.ask || job.failed) return false;', '    if (job.failed) return false;']] },
  { name: '恢复任务没完成时照样普通同步', grep: 'epoch_changed|静默丢掉', edits: [['js/cloud.js', 'const go = R && R.pending() ? await R.step() : true;', 'const go = R && R.pending() ? (await R.step(), true) : true;']] },
  { name: '整块设置补丁不看原始备份有没有这个模块', grep: '旧版备份', edits: [['js/restore.js', 'const mods = MODS.filter(m => has(raw, m)).sort();', 'const mods = MODS.slice().sort();']] },
  { name: '备份里没有猫咪也覆盖猫咪表', grep: '旧版备份', edits: [['js/restore.js', "const tables = REQ.concat(hasCats ? ['xm_cats'] : []).sort();", "const tables = REQ.concat(['xm_cats']).sort();"]] },
  { name: '语句超时当成网络问题一直自动重试', grep: '语句超时', edits: [['js/restore.js', "      if (e.code === '57014') {", "      if (false) {"]] },
  { name: '开始恢复时不挡住同时发生的自动同步', grep: '开始恢复」的瞬间', edits: [['js/restore.js', '    if (!job) return !hold;', '    if (!job) return true;']] },
  { name: '恢复前先把未同步的修改传上去（之后被备份删掉）', grep: '静默丢掉', edits: [['js/restore.js', '      if (!fresh()) {\n', '      if (true) {\n']] }
];
