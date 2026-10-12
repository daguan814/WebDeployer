#!/usr/bin/env node
import { hasPassword, setPassword } from '../src/auth.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let input = '';
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          stdout.write('\n');
          return resolve(input);
        }
        if (char === '\u0003') {
          stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1);
          continue;
        }
        input += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  let password = process.argv[2];

  if (!password) {
    if (!process.stdin.isTTY) {
      console.error('非交互环境请这样用： node tools/set-password.js \'你的密码\'');
      process.exit(1);
    }
    password = await askHidden('设置后台密码：');
    const again = await askHidden('再输一次确认：');
    if (password !== again) {
      console.error('两次输入不一致');
      process.exit(1);
    }
  }

  if (String(password).length < 6) {
    console.error('密码至少 6 位');
    process.exit(1);
  }

  const existed = hasPassword();
  setPassword(password);
  console.log(existed ? '后台密码已更新，所有登录状态已失效。' : '后台密码已设置。');
  console.log('密码以 scrypt 哈希保存在 data/webdeployer.db，不会明文落盘。');
}

main().catch((err) => {
  console.error('设置失败：', err.message);
  process.exit(1);
});
