// 恢复协议的纯客户端部分（不依赖测试环境）：行构造、内容指纹、清单摘要、恢复计划
// 将来前端实现时，摘要算法必须与这里和 supabase/restore_epoch.sql 的 xm_restore_seal 一致
import crypto from 'node:crypto';

// ---------- 行构造（与 cloud.js 的 toRow 形状一致） ----------
export const rec = (id, amount = 100, note = '', o = {}) => ({ id, type: 'expense', amount, cat: 'e_food', acc: 'a_cash', to_acc: '', date: '2026-10-21', note, ts: 1, rec: null, extra: {}, ...o });
export const acc = (id, name = '现金', o = {}) => ({ id, name, type: 'cash', init: 0, hidden: false, sort: 0, extra: {}, ...o });
export const cat = (id, name = '餐饮', o = {}) => ({ id, kind: 'expense', name, icon: '🍜', hidden: false, sort: 0, extra: {}, ...o });
export const kitty = (id, o = {}) => ({ cat_id: id, got: '2026-10-01', n: 1, mood: 80, fed: null, extra: {}, ...o });

// ---------- 未来前端的恢复协议客户端（本阶段只在测试里用） ----------
export const KEYS = { xm_records: 'id', xm_accounts: 'id', xm_categories: 'id', xm_cats: 'cat_id' };
export const fp = row => crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 32);
export function digest(items) {   // items: [{rkey, h}]；按 UTF-8 字节序排序
  const sorted = items.slice().sort((a, b) => Buffer.compare(Buffer.from(a.rkey, 'utf8'), Buffer.from(b.rkey, 'utf8')));
  return crypto.createHash('sha256').update(sorted.map(x => x.rkey + '\t' + x.h).join('\n'), 'utf8').digest('hex');
}
// backup = { tables: { xm_records: [...], ... }, state: { budget: ..., ... } }
export function planFor(backup) {
  const tables = Object.keys(backup.tables).sort();
  const items = {}, manifest = {};
  for (const t of tables) {
    items[t] = backup.tables[t].map(row => ({ rkey: row[KEYS[t]], h: fp(row), row }));
    manifest[t] = { count: items[t].length, digest: digest(items[t]) };
  }
  const state = backup.state || {};
  return { scope: { tables, state_modules: Object.keys(state).sort() }, items, manifest, state };
}
