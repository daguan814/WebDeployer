import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  HOST,
  PORT,
  PUBLIC_DIR,
  SCHEME,
  SITES_DIR,
  SITE_PREFIX,
  TLS_CERT,
  TLS_ENABLED,
  TLS_KEY,
  TLS_PFX,
  TLS_PFX_PASSPHRASE,
} from './src/config.js';
import { getSite, db } from './src/store.js';
import { handleApi } from './src/api.js';
import { serveSite } from './src/static.js';
import { hasPassword, purgeExpiredSessions, setPassword } from './src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendAdminAsset(req, res, assetPath) {
  const rel = assetPath.replace(/^\/+/, '') || 'index.html';
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return plain(res, 403, '路径不合法');
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return plain(res, 404, '没有这个文件');
  }
  if (!stat.isFile()) return plain(res, 404, '没有这个文件');

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', ADMIN_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }
  const body = fs.readFileSync(abs);
  res.writeHead(200, { 'Content-Length': body.length });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

function plain(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

const handler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (pathname === '/healthz') return plain(res, 200, 'ok');
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/') {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }

    if (pathname === '/admin') {
      res.writeHead(301, { Location: '/admin/' + (url.search || '') });
      return res.end();
    }

    if (pathname.startsWith('/admin/')) {
      const asset = pathname.slice('/admin/'.length);
      return sendAdminAsset(req, res, asset || 'index.html');
    }

    // 静态站点：/s/<slug>/...
    if (pathname === SITE_PREFIX) {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }
    if (pathname.startsWith(SITE_PREFIX + '/')) {
      const restRaw = pathname.slice(SITE_PREFIX.length + 1);
      const slash = restRaw.indexOf('/');
      const rawSlug = slash === -1 ? restRaw : restRaw.slice(0, slash);
      const rest = slash === -1 ? '' : restRaw.slice(slash);
      let slug;
      try {
        slug = decodeURIComponent(rawSlug);
      } catch {
        return plain(res, 400, '路径编码不合法');
      }
      const site = getSite(slug);
      if (!site) return plain(res, 404, '没有这个站点');
      return serveSite(req, res, url, site, rest);
    }

    return plain(res, 404, '没有找到页面');
  } catch (err) {
    if (!res.headersSent) {
      return plain(res, 500, `服务器错误：${err?.message || err}`);
    }
    res.destroy();
  }
};

/** 组装 TLS 参数，证书文件读不到时给出人话报错 */
function tlsOptions() {
  if (TLS_PFX) {
    const options = { pfx: fs.readFileSync(TLS_PFX) };
    if (TLS_PFX_PASSPHRASE) options.passphrase = TLS_PFX_PASSPHRASE;
    return options;
  }
  for (const [label, file] of [['TLS_CERT（证书）', TLS_CERT], ['TLS_KEY（私钥）', TLS_KEY]]) {
    if (!fs.existsSync(file)) {
      throw new Error(`${label} 指向的文件不存在：${file}`);
    }
  }
  return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
}

let server;
if (TLS_ENABLED) {
  try {
    server = https.createServer(tlsOptions(), handler);
  } catch (err) {
    console.error(`\nHTTPS 启动失败：${err.message}`);
    console.error('检查 docker-compose.yml 里 TLS_CERT / TLS_KEY 的路径和证书文件名是否对应。\n');
    process.exit(1);
  }
} else {
  server = http.createServer(handler);
}

async function bootstrap() {
  fs.mkdirSync(SITES_DIR, { recursive: true });

  if (process.env.ADMIN_PASSWORD && !hasPassword()) {
    setPassword(process.env.ADMIN_PASSWORD);
    console.log('[WebDeployer] 已用 ADMIN_PASSWORD 初始化后台密码');
  }

  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

  server.listen(PORT, HOST, () => {
    const sites = db.prepare('SELECT COUNT(*) AS n FROM sites').get();
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address);

    console.log('');
    console.log('  WebDeployer 已启动');
    console.log(
      `  监听端口   ${PORT}（${TLS_ENABLED ? 'HTTPS' : 'HTTP'}，后台与所有站点共用这一个端口）`,
    );
    console.log(`  本机后台   ${SCHEME}://localhost:${PORT}/admin/`);
    for (const addr of addresses) {
      console.log(`  局域网     ${SCHEME}://${addr}:${PORT}/admin/`);
    }
    console.log(`  已有站点   ${sites.n} 个`);
    if (!TLS_ENABLED) {
      console.log('  提示       未启用 HTTPS（公网访问建议挂证书，见 README）');
    }
    if (!hasPassword()) {
      console.log('');
      console.log('  ⚠ 还没有设置后台密码，请运行： npm run set-password');
    }
    console.log('');
  });
}

bootstrap().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { server };
