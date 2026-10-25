// 前端变异清单：[文件, 原文, 替换] + 用哪些测试去抓（-g 关键词）
'use strict';
module.exports = [
  { name: '写入不带版本号请求头', grep: '所有写请求都带', edits: [['js/cloud.js', "if (ep != null) h['x-xm-epoch'] = String(ep);", '']] },
  { name: '版本号未确认时也照样写（不带请求头）', grep: '恰好被另一台设备恢复', edits: [['js/cloud.js', "const e = new Error('还没确认云端账本版本，暂不上传'); e.code = 'xm_no_epoch'; throw e;", 'return null;'], ['js/cloud.js', "if (Number.isInteger(m.epoch)) return m.epoch === r.epoch ? 'normal' : 'rebase';", "if (Number.isInteger(m.epoch) && m.epoch !== r.epoch) { m.epoch = undefined; return 'normal'; }"]] },
  { name: '版本号落后时直接采用云端版本号（跳过对齐）', grep: '恰好被另一台设备恢复', edits: [['js/cloud.js', "if (Number.isInteger(m.epoch)) return m.epoch === r.epoch ? 'normal' : 'rebase';", "if (Number.isInteger(m.epoch)) { m.epoch = r.epoch; return 'normal'; }"]] },
  { name: '409 后不暂停、一直自动重试', grep: '请求头没送到服务器', edits: [['js/cloud.js', "      C.halted = 'epoch-header';", "      clearTimeout(timer); timer = setTimeout(() => C.sync(false), 300);"]] },
  { name: '换账号时不清除暂停状态', grep: '换了账号', edits: [['js/cloud.js', "if (before !== after && App.cloud) { App.cloud.halted = ''; App.cloud.staleRetry = 0; App.cloud.proto = null; }", '']] },
  { name: '暂停后自动同步照样进行', grep: '请求头没送到服务器', edits: [['js/cloud.js', 'if (C.halted && !manual) return false;', '']] }
];
