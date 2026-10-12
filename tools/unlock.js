#!/usr/bin/env node
import { db } from '../src/store.js';
import { clearFailures, listLockedIps } from '../src/auth.js';

const now = Date.now();

function describe(row) {
  const locked = row.locked_until > now;
  const left = locked ? `，还需等待 ${Math.ceil((row.locked_until - now) / 60000)} 分钟` : '';
  return `  ${row.ip.padEnd(16)} 失败 ${row.strikes} 次${locked ? ` · 已锁定${left}` : ' · 未锁定'}`;
}

function main() {
  const arg = process.argv[2];
  const rows = listLockedIps();

  if (arg === '--list' || (!arg && !rows.length)) {
    if (!rows.length) console.log('没有失败记录，登录没有被锁定。');
    else {
      console.log('失败记录：');
      rows.forEach((row) => console.log(describe(row)));
    }
    return;
  }

  if (!arg) {
    console.log('解锁前：');
    rows.forEach((row) => console.log(describe(row)));
    db.prepare('DELETE FROM login_events').run();
    console.log('已清空全部失败记录，现在可以重新登录。');
    return;
  }

  clearFailures(arg);
  console.log(`已解锁 ${arg}。`);
  console.log('注意：本地回环地址（127.0.0.1）本来就不会被锁定。');
}

main();
