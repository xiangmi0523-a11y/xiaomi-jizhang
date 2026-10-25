// 环境自检：真实 PostgreSQL + 真实 PostgREST，迁移已生效
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql, newUser, select, rpc, BASE, PROT } from './lib.mjs';

test('环境：PostgreSQL 与 PostgREST 可用，基线库没有协议、协议库有', async () => {
  assert.match(sql(PROT, 'show server_version'), /^\d+/);
  assert.equal(sql(BASE, "select to_regclass('public.xm_meta') is null"), 't');
  assert.equal(sql(PROT, "select to_regclass('public.xm_meta') is not null"), 't');
  const u = newUser(BASE, PROT);
  for (const db of [BASE, PROT]) {
    const r = await select(db, u, 'xm_records');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, []);
  }
  const r = await rpc(PROT, u, 'xm_restore_cancel', { p_job: '00000000-0000-4000-8000-000000000000' });
  assert.equal(r.status, 404, r.text);
  assert.equal(r.json.hint, 'xm_not_found');
});
