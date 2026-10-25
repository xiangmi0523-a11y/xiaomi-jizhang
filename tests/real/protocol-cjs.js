// tests/db/protocol.mjs 里的行构造在 CommonJS 测试里的同款（保持字段一致）
'use strict';
const rec = (id, amount = 100, note = '', o = {}) => ({ id, type: 'expense', amount, cat: 'e_food', acc: 'a_cash', to_acc: '', date: '2026-10-21', note, ts: 1, rec: null, extra: {}, ...o });
const acc = (id, name = '现金', o = {}) => ({ id, name, type: 'cash', init: 0, hidden: false, sort: 0, extra: {}, ...o });
const cat = (id, name = '餐饮', o = {}) => ({ id, kind: 'expense', name, icon: '🍜', hidden: false, sort: 0, extra: {}, ...o });
const kitty = (id, o = {}) => ({ cat_id: id, got: '2026-10-01', n: 1, mood: 80, fed: null, extra: {}, ...o });
module.exports = { rec, acc, cat, kitty };
