#!/usr/bin/env node
/**
 * 端到端自检 / 命令行部署工具。
 *
 *   node tools/smoke-test.js <文件夹> [站点路径]
 *   node tools/smoke-test.js "/Users/me/Desktop/我的课件" 我的课件
 *
 * 它会走完整流程：登录 → 建站点 → 上传每个文件 → 提交 → 校验首页和大文件 Range 是否正常。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { walkFiles } from '../src/scan.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.join('=') || true];
    }),
);

const folder = positional[0];
const base = String(flags.base || process.env.WD_BASE || 'http://127.0.0.1:9090');
const password = String(flags.password || process.env.ADMIN_PASSWORD || '');

if (!folder) {
  console.error('用法： node tools/smoke-test.js <文件夹> [站点路径] [--password=xxx] [--base=http://127.0.0.1:9090]');
  process.exit(1);
}
if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
  console.error(`不是有效的文件夹：${folder}`);
  process.exit(1);
}
if (!password) {
  console.error('请用 --password= 或环境变量 ADMIN_PASSWORD 提供后台密码');
  process.exit(1);
}

const slug = positional[1] || path.basename(path.resolve(folder));
const name = String(flags.name || slug);
let cookie = '';

function request(method, urlPath, { body, headers = {}, stream } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    if (stream) stream.pipe(req);
    else {
      if (body !== undefined) req.write(body);
      req.end();
    }
  });
}

const json = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return {};
  }
};

function step(msg) {
  process.stdout.write(`  ${msg}\n`);
}

async function main() {
  console.log(`\n部署「${slug}」 → ${base}\n`);

  // 1. 登录
  const loginBody = JSON.stringify({ password });
  const login = await request('POST', '/api/login', {
    body: loginBody,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
  });
  if (login.status !== 200) {
    throw new Error(`登录失败（${login.status}）：${json(login).error || ''}`);
  }
  cookie = (login.headers['set-cookie']?.[0] || '').split(';')[0];
  step(`✓ 已登录`);

  // 2. 建站点（已存在就当作更新）
  const create = await request('POST', '/api/sites', {
    body: JSON.stringify({ slug, name }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (create.status === 409) step(`· 站点已存在，按更新处理`);
  else if (create.status !== 201) throw new Error(`建站点失败（${create.status}）：${json(create).error || ''}`);
  else step(`✓ 已创建站点 /s/${slug}/`);

  // 3. 新建版本
  const begin = await request('POST', `/api/sites/${encodeURIComponent(slug)}/releases`);
  if (begin.status !== 201) throw new Error(`创建版本失败（${begin.status}）`);
  const { version } = json(begin);
  step(`✓ 版本 ${version}`);

  // 4. 逐个上传文件
  const files = walkFiles(folder);
  if (!files.length) throw new Error('文件夹是空的');
  const total = files.reduce((a, f) => a + f.size, 0);
  let sent = 0;
  let failures = 0;

  for (const file of files) {
    const target = `/api/sites/${encodeURIComponent(slug)}/releases/${version}/files?path=${encodeURIComponent(file.rel)}`;
    const res = await request('PUT', target, {
      stream: fs.createReadStream(file.abs),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size },
    });
    if (res.status !== 200) {
      failures += 1;
      console.error(`    ✗ ${file.rel} → ${res.status} ${json(res).error || ''}`);
    }
    sent += file.size;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  上传中 ${((sent / total) * 100).toFixed(0)}%  ${file.rel.slice(0, 40).padEnd(42)}`);
    }
  }
  process.stdout.write('\r'.padEnd(90) + '\r');
  if (failures) throw new Error(`${failures} 个文件上传失败`);
  step(`✓ 已上传 ${files.length} 个文件（${(total / 1024 / 1024).toFixed(1)} MB）`);

  // 5. 提交
  const commit = await request(
    'POST',
    `/api/sites/${encodeURIComponent(slug)}/releases/${version}/commit`,
  );
  if (commit.status !== 200) throw new Error(`提交失败（${commit.status}）：${json(commit).error || ''}`);
  const site = json(commit).site;
  step(`✓ 已上线，首页识别为「${site.entry}」`);
  if (site.warnings?.length) {
    for (const w of site.warnings) console.log(`    ⚠ ${w.message}`);
  }

  // 6. 校验首页
  const page = await request('GET', site.url);
  const isHtml = String(page.headers['content-type'] || '').includes('text/html');
  if (page.status !== 200 || !isHtml) {
    throw new Error(`首页校验失败：${page.status} ${page.headers['content-type']}`);
  }
  step(`✓ 首页返回 ${page.status} · ${isHtml ? 'text/html' : '?'} · ${(page.body.length / 1024).toFixed(0)} KB`);

  // 7. 校验大文件 Range（视频能否拖进度条）
  const biggest = [...files].sort((a, b) => b.size - a.size)[0];
  const rangeUrl = `${site.url}${biggest.rel.split('/').map(encodeURIComponent).join('/')}`;
  const ranged = await request('GET', rangeUrl, { headers: { Range: 'bytes=100-199' } });
  if (ranged.status !== 206) {
    throw new Error(`Range 请求失败：${ranged.status}（视频将无法拖动进度条）`);
  }
  step(`✓ 大文件分段读取正常 ${ranged.status} · ${ranged.headers['content-range']}`);

  console.log(`\n部署完成 → ${base}${site.url}\n`);
}

main().catch((err) => {
  console.error(`\n失败：${err.message}\n`);
  process.exit(1);
});
