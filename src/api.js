import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SITES_DIR, KEEP_RELEASES, SITE_PREFIX, VERSION_TZ } from './config.js';
import {
  addRelease,
  createSite,
  db,
  deleteSite,
  dropRelease,
  getSite,
  listReleases,
  listSites,
  promoteRelease,
  pruneReleases,
} from './store.js';
import {
  buildLogoutCookie,
  buildSessionCookie,
  checkPassword,
  clearFailures,
  clientIp,
  createSession,
  currentSession,
  destroySession,
  hasPassword,
  lockState,
  readCookie,
  recordFailure,
  sameOrigin,
  purgeExpiredSessions,
} from './auth.js';
import { scanRelease, walkFiles } from './scan.js';
import { releaseRoot } from './static.js';

const RESERVED_SLUGS = new Set(['api', 'admin', 's', 'favicon.ico', 'assets', 'public']);
const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-_. ]{0,59}$/u;

export function isValidSlug(slug) {
  if (typeof slug !== 'string') return false;
  const trimmed = slug.trim();
  if (!SLUG_RE.test(trimmed)) return false;
  if (trimmed.includes('..')) return false;
  if (RESERVED_SLUGS.has(trimmed.toLowerCase())) return false;
  return true;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function sitePublicUrl(site) {
  return `${SITE_PREFIX}/${encodeURIComponent(site.slug)}/`;
}

function serializeSite(site, { withReleases = true } = {}) {
  const releases = withReleases ? listReleases(site.id, 20) : [];
  const current = releases.find((r) => r.version === site.current_version);
  return {
    slug: site.slug,
    name: site.name,
    entry: site.entry,
    currentVersion: site.current_version,
    fileCount: site.file_count,
    sizeBytes: site.size_bytes,
    createdAt: site.created_at,
    updatedAt: site.updated_at,
    url: sitePublicUrl(site),
    candidates: current ? safeParse(current.candidates) : [],
    warnings: current ? safeParse(current.warnings) : [],
    releases: releases.map((r) => ({
      version: r.version,
      entry: r.entry,
      fileCount: r.file_count,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
      current: r.version === site.current_version,
    })),
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

function releaseDir(slug, version) {
  return path.join(SITES_DIR, slug, 'releases', version);
}

const versionClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: VERSION_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 版本号形如 20260930-113005-4f2a，用的是指定时区而不是容器系统时区 */
export function newVersion() {
  const parts = Object.fromEntries(
    versionClock.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${crypto.randomBytes(2).toString('hex')}`;
}

/** 把上传的相对路径转成绝对路径，并且防目录穿越 */
function resolveUploadPath(baseDir, relPath) {
  if (typeof relPath !== 'string' || !relPath) throw new Error('缺少 path 参数');
  let decoded = relPath;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    throw new Error('路径编码不合法');
  }
  if (decoded.includes('\0')) throw new Error('路径不合法');
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized.includes('..')) throw new Error('路径不合法');
  const segments = normalized.split('/').filter((s) => s && s !== '.');
  if (!segments.length) throw new Error('路径不合法');
  const abs = path.join(baseDir, ...segments);
  if (!abs.startsWith(baseDir + path.sep)) throw new Error('路径不合法');
  return { abs, rel: segments.join('/') };
}

const SKIP_FILE = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const isJunk = (rel) => rel.split('/').some((part) => SKIP_FILE.test(part) || part.startsWith('._'));

/* --------------------------------- 路由入口 -------------------------------- */

export async function handleApi(req, res, url) {
  // 路径里可能有中文，统一解码后再比对
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    }); // ['api', ...]
  const route = segments.slice(1);
  const method = req.method || 'GET';
  const ip = clientIp(req);

  if (route.length === 0) return sendJson(res, 404, { error: '未知接口' });

  // 写操作要求同源，挡掉 CSRF
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && !sameOrigin(req)) {
    return sendJson(res, 403, { error: '跨站请求被拒绝' });
  }

  /* --------------------------- 登录 / 会话（免鉴权） -------------------------- */

  if (route[0] === 'session' && method === 'GET') {
    const session = currentSession(req);
    const lock = lockState(ip);
    return sendJson(res, 200, {
      authed: Boolean(session),
      passwordSet: hasPassword(),
      lock: { locked: lock.locked, retryAfterMs: lock.retryAfterMs, remaining: lock.remaining },
    });
  }

  if (route[0] === 'login' && method === 'POST') {
    const lock = lockState(ip);
    if (lock.locked) {
      return sendJson(res, 429, {
        error: '登录已锁定',
        locked: true,
        retryAfterMs: lock.retryAfterMs,
      });
    }
    const body = await readJsonBody(req);
    if (!hasPassword()) {
      return sendJson(res, 503, { error: '后台密码还没设置，请先运行 npm run set-password' });
    }
    if (checkPassword(body.password)) {
      clearFailures(ip);
      purgeExpiredSessions();
      const token = createSession(ip);
      res.setHeader('Set-Cookie', buildSessionCookie(token, req));
      return sendJson(res, 200, { ok: true });
    }
    const next = recordFailure(ip);
    return sendJson(res, next.locked ? 429 : 401, {
      error: next.locked ? '登录已锁定' : '密码不正确',
      locked: next.locked,
      retryAfterMs: next.retryAfterMs,
      remaining: Number.isFinite(next.remaining) ? next.remaining : null,
    });
  }

  if (route[0] === 'logout' && method === 'POST') {
    destroySession(readCookie(req));
    res.setHeader('Set-Cookie', buildLogoutCookie());
    return sendJson(res, 200, { ok: true });
  }

  /* --------------------------------- 鉴权 --------------------------------- */

  const session = currentSession(req);
  if (!session) return sendJson(res, 401, { error: '未登录' });

  /* -------------------------------- 站点列表 ------------------------------- */

  if (route[0] === 'sites' && route.length === 1) {
    if (method === 'GET') {
      return sendJson(res, 200, { sites: listSites().map((s) => serializeSite(s)) });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const slug = String(body.slug || '').trim();
      const name = String(body.name || slug).trim() || slug;
      if (!isValidSlug(slug)) {
        return sendJson(res, 400, {
          error: '站点路径只能是中文/字母/数字/空格/横线/下划线/点，最长 60 字',
        });
      }
      if (getSite(slug)) return sendJson(res, 409, { error: '这个路径已经被占用了' });
      const site = createSite(slug, name);
      fs.mkdirSync(path.join(SITES_DIR, slug, 'releases'), { recursive: true });
      return sendJson(res, 201, { site: serializeSite(site) });
    }
    return sendJson(res, 405, { error: '不支持的方法' });
  }

  const slug = route[1];
  const site = slug ? getSite(slug) : null;
  if (!site) return sendJson(res, 404, { error: '站点不存在' });

  /* ---------------------------- 站点自身：改名 / 入口 --------------------------- */

  if (route.length === 2) {
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const name = body.name === undefined ? site.name : String(body.name).trim() || site.name;
      let entry = site.entry;
      if (body.entry !== undefined) {
        const candidate = String(body.entry || '');
        const dir = releaseDir(slug, site.current_version);
        if (candidate && !fs.existsSync(path.join(dir, candidate))) {
          return sendJson(res, 400, { error: '这个首页文件在站点里不存在' });
        }
        entry = candidate || null;
      }
      db.prepare('UPDATE sites SET name = ?, entry = ?, updated_at = ? WHERE id = ?').run(
        name,
        entry,
        Date.now(),
        site.id,
      );
      return sendJson(res, 200, { site: serializeSite(getSite(slug)) });
    }
    if (method === 'DELETE') {
      const target = path.join(SITES_DIR, slug);
      if (target.startsWith(SITES_DIR + path.sep)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      deleteSite(slug);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: '不支持的方法' });
  }

  /* ------------------------------ 当前版本的文件 ------------------------------ */

  // 后台用它列出文件、生成直链和下载链接
  if (route[2] === 'files' && route.length === 3 && method === 'GET') {
    const root = releaseRoot(site);
    if (!root || !fs.existsSync(root)) return sendJson(res, 200, { files: [], total: 0 });
    const all = walkFiles(root);
    const LIMIT = 1000;
    const prefix = `${SITE_PREFIX}/${encodeURIComponent(site.slug)}/`;
    const files = all.slice(0, LIMIT).map((file) => {
      const url = prefix + file.rel.split('/').map((part) => encodeURIComponent(part)).join('/');
      return {
        path: file.rel,
        size: file.size,
        ext: path.extname(file.rel).toLowerCase(),
        url,
        downloadUrl: `${url}?download=1`,
      };
    });
    return sendJson(res, 200, {
      files,
      total: all.length,
      truncated: all.length > LIMIT,
    });
  }

  /* ------------------------------- 新建发布版本 ------------------------------ */

  if (route[2] === 'releases' && route.length === 3 && method === 'POST') {
    const version = newVersion();
    const dir = releaseDir(slug, version);
    fs.mkdirSync(dir, { recursive: true });
    return sendJson(res, 201, { version });
  }

  if (route[2] === 'releases' && route.length >= 4) {
    const version = route[3];
    if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(version)) {
      return sendJson(res, 400, { error: '版本号不合法' });
    }

    // 上传单个文件：PUT /api/sites/:slug/releases/:version/files?path=xxx
    if (route[4] === 'files' && method === 'PUT') {
      const dir = releaseDir(slug, version);
      if (!fs.existsSync(dir)) return sendJson(res, 404, { error: '版本不存在或已提交' });
      const { abs, rel } = resolveUploadPath(dir, url.searchParams.get('path') || '');
      if (isJunk(rel)) return sendJson(res, 200, { skipped: true, path: rel });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.part-${process.pid}`;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        const cleanup = () => fs.rm(tmp, { force: true }, () => {});
        out.on('error', (err) => {
          cleanup();
          reject(err);
        });
        req.on('aborted', () => {
          out.destroy();
          cleanup();
          reject(new Error('客户端中断'));
        });
        out.on('finish', () => {
          try {
            fs.renameSync(tmp, abs);
            resolve();
          } catch (err) {
            cleanup();
            reject(err);
          }
        });
        req.pipe(out);
      });
      return sendJson(res, 200, { ok: true, path: rel });
    }

    // 丢弃整个未提交版本
    if (method === 'DELETE' && route.length === 4) {
      const dir = releaseDir(slug, version);
      if (version === site.current_version) {
        return sendJson(res, 400, { error: '不能删除正在使用的版本' });
      }
      fs.rmSync(dir, { recursive: true, force: true });
      dropRelease(site.id, version);
      return sendJson(res, 200, { ok: true });
    }

    // 提交：扫描 + 切换 current
    if (route[4] === 'commit' && method === 'POST') {
      const dir = releaseDir(slug, version);
      if (!fs.existsSync(dir)) return sendJson(res, 404, { error: '版本不存在或已提交' });
      const result = scanRelease(dir);
      addRelease(site.id, {
        version,
        entry: result.entry,
        candidates: result.candidates,
        warnings: result.warnings,
        file_count: result.file_count,
        size_bytes: result.size_bytes,
      });
      promoteRelease(site.id, {
        version,
        entry: result.entry,
        file_count: result.file_count,
        size_bytes: result.size_bytes,
      });

      // 清理超出保留数量的旧版本
      const stale = pruneReleases(site.id, KEEP_RELEASES);
      for (const row of stale) {
        fs.rmSync(releaseDir(slug, row.version), { recursive: true, force: true });
        dropRelease(site.id, row.version);
      }

      return sendJson(res, 200, { site: serializeSite(getSite(slug)) });
    }
  }

  /* --------------------------------- 回滚 --------------------------------- */

  if (route[2] === 'rollback' && method === 'POST') {
    const body = await readJsonBody(req);
    const version = String(body.version || '');
    const target = listReleases(site.id, 50).find((r) => r.version === version);
    if (!target) return sendJson(res, 404, { error: '找不到这个版本' });
    if (!fs.existsSync(releaseDir(slug, version))) {
      return sendJson(res, 410, { error: '这个版本的文件已经被清理了' });
    }
    promoteRelease(site.id, {
      version,
      entry: target.entry,
      file_count: target.file_count,
      size_bytes: target.size_bytes,
    });
    return sendJson(res, 200, { site: serializeSite(getSite(slug)) });
  }

  return sendJson(res, 404, { error: '未知接口' });
}
