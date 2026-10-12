import fs from 'node:fs';
import path from 'node:path';
import { SCHEME, SITES_DIR, TRUST_PROXY } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
  '.csv': 'text/csv; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.epub': 'application/epub+zip',
  '.apk': 'application/vnd.android.package-archive',
  '.psd': 'image/vnd.adobe.photoshop',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  // 图纸类文件：浏览器会当成未知类型直接下载，而不是当 XML 显示
  '.drawio': 'application/vnd.jgraph.mxfile',
  '.dio': 'application/vnd.jgraph.mxfile',
  '.vsdx': 'application/vnd.ms-visio.drawing',
};

const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

/**
 * 站点内容本来就是公开的，这里放开 CORS，
 * 别的网页想直接 fetch 这些文件时才不会被同源策略挡住。
 */
function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'ETag, Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
  );
}

/**
 * Content-Disposition 的 filename 只能是 ASCII（Node 不接受裸的 UTF-8），
 * 所以中文名走 filename*，这里给一个纯 ASCII 的兜底名字。
 */
function fallbackFilename(name) {
  const ext = path.extname(name).replace(/[^\x20-\x7e]/g, '');
  const base = path
    .basename(name, path.extname(name))
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim();
  return `${base || 'file'}${ext}`;
}

function disposition(name, download) {
  const kind = download ? 'attachment' : 'inline';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallbackFilename(name)}"; filename*=UTF-8''${encoded}`;
}

/** 拼对外的绝对地址：目录页里「复制直链」要用 */
function absoluteBase(req) {
  const forwarded = (key) =>
    TRUST_PROXY ? String(req.headers[key] || '').split(',')[0].trim() : '';
  const proto = forwarded('x-forwarded-proto') || SCHEME;
  const host = forwarded('x-forwarded-host') || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

const encodeSegment = (segment) => encodeURIComponent(segment);

function sendPlain(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * 带 Range / ETag / 304 的文件发送。
 * 视频拖进度条靠的就是 Range，缺了它只能从头播。
 * 默认 inline（能在浏览器里直接看），?download=1 时改成 attachment 强制下载。
 */
function sendFile(req, res, abs, stat, { download = false } = {}) {
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = new Date(stat.mtimeMs).toUTCString();

  corsHeaders(res);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Content-Type', mimeFor(abs));
  res.setHeader('Content-Disposition', disposition(path.basename(abs), download));

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }
  if (!req.headers['if-none-match'] && req.headers['if-modified-since']) {
    const since = Date.parse(req.headers['if-modified-since']);
    if (!Number.isNaN(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
      res.writeHead(304);
      return res.end();
    }
  }

  let start = 0;
  let end = stat.size - 1;
  let status = 200;

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!match || (match[1] === '' && match[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2] !== '') end = Number(match[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }

  res.setHeader('Content-Length', end - start + 1);
  res.writeHead(status);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

function sendDirectoryListing(req, res, dir, rawPath, site, { download = false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return sendPlain(res, 403, '无法读取目录');
  }

  const visible = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const abs = path.join(dir, e.name);
      const size = e.isFile() ? statOrNull(abs)?.size || 0 : 0;
      return { name: e.name, isDir: e.isDirectory(), size };
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));

  const base = rawPath.endsWith('/') ? rawPath : `${rawPath}/`;
  const origin = absoluteBase(req);
  const suffix = download ? '?download=1' : '';
  const rows = visible
    .map((e) => {
      const href = base + encodeSegment(e.name);
      if (e.isDir) {
        return `<li><a class="name" href="${escapeHtml(href)}/">${escapeHtml(e.name)}/</a>`
          + `<span class="size">—</span><span class="acts"></span></li>`;
      }
      const direct = `${origin}${href}`;
      const acts = [
        `<button class="act" type="button" data-copy="${escapeHtml(direct)}">复制直链</button>`,
        `<a class="act" href="${escapeHtml(href)}?download=1">下载</a>`,
      ].join('');
      return `<li><a class="name" href="${escapeHtml(href + suffix)}">${escapeHtml(e.name)}</a>`
        + `<span class="size">${formatSize(e.size)}</span><span class="acts">${acts}</span></li>`;
    })
    .join('\n');

  const parent = base.replace(/[^/]+\/$/, '');
  const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(site.name)} · ${escapeHtml(rawPath)}</title>
<style>
  body{margin:0;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2933;background:#f7f8fa}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{color:#7b8794;margin:0 0 20px;font-size:13px}
  ul{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e4e7eb;border-radius:10px;overflow:hidden}
  li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px;border-top:1px solid #f0f2f5}
  li:first-child{border-top:none}
  a{color:#2563eb;text-decoration:none}
  a:hover{text-decoration:underline}
  .size{color:#9aa5b1;font-size:13px;white-space:nowrap;margin-left:auto}
  .acts{display:flex;gap:6px;white-space:nowrap}
  .act{border:1px solid #e4e7eb;border-radius:7px;background:#fff;color:#52606d;font-size:12px;padding:3px 9px;text-decoration:none}
  .act:hover{border-color:#bfdbfe;color:#2563eb;text-decoration:none}
  .direct{margin:0 0 20px;font-size:13px;color:#7b8794;word-break:break-all}
</style></head>
<body>
  <h1>${escapeHtml(site.name)}</h1>
  <p class="sub">${escapeHtml(rawPath)}</p>
  <p class="direct">直链：<a href="${escapeHtml(origin + base)}">${escapeHtml(origin + base)}</a>
    <button class="act" type="button" data-copy="${escapeHtml(origin + base)}">复制</button></p>
  <ul>
    <li><a href="${escapeHtml(parent)}">../</a><span></span></li>
    ${rows || '<li><span>（空目录）</span><span></span></li>'}
  </ul>
  <script>
    for (const button of document.querySelectorAll('button[data-copy]')) {
      const label = button.textContent;
      button.addEventListener('click', async () => {
        const text = button.dataset.copy;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          window.prompt('复制这个地址：', text);
          return;
        }
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = label; }, 1500);
      });
    }
  </script>
</body></html>`;

  const buf = Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  return res.end(req.method === 'HEAD' ? undefined : buf);
}

function notFound(req, res, site) {
  const body = Buffer.from(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#52606d;background:#f7f8fa}
div{text-align:center}h1{font-size:44px;margin:0;color:#cbd2d9}p{margin:8px 0 0}</style></head>
<body><div><h1>404</h1><p>没有找到这个文件 · ${escapeHtml(site.name)}</p></div></body></html>`,
    'utf8',
  );
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

export function releaseRoot(site) {
  if (!site?.current_version) return null;
  return path.join(SITES_DIR, site.slug, 'releases', site.current_version);
}

/**
 * 处理 /s/<slug>/<rest>。
 * restPath 是尚未解码的原始路径（以 / 开头），空字符串表示 /s/<slug>
 */
export function serveSite(req, res, url, site, restPath) {
  // 别的网页跨域取文件前可能先来一个预检
  if (req.method === 'OPTIONS') {
    corsHeaders(res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204);
    return res.end();
  }

  const download = ['1', 'true', 'yes'].includes(
    String(url.searchParams.get('download') || '').toLowerCase(),
  );

  const base = releaseRoot(site);
  if (!base || !fs.existsSync(base)) {
    return sendPlain(res, 404, '这个站点还没有可用的版本');
  }

  // 补斜杠，保证页面里的相对路径能正确解析
  if (restPath === '') {
    res.writeHead(301, { Location: `${url.pathname}/${url.search || ''}` });
    return res.end();
  }

  const decoded = decodePath(restPath);
  if (decoded === null || decoded.includes('\0')) {
    return sendPlain(res, 400, '路径编码不合法');
  }

  const normalized = path.posix.normalize(decoded);
  if (normalized.includes('..')) {
    return sendPlain(res, 403, '路径不合法');
  }

  const segments = normalized.split('/').filter((s) => s && s !== '.');
  const target = path.join(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return sendPlain(res, 403, '路径不合法');
  }

  const wantsDir = decoded.endsWith('/') || segments.length === 0;
  let stat = statOrNull(target);

  // 允许 /about 命中 about.html
  if (!stat && !wantsDir) {
    const withHtml = statOrNull(`${target}.html`);
    if (withHtml?.isFile()) stat = withHtml;
  }

  if (!stat) return notFound(req, res, site);

  if (stat.isDirectory()) {
    if (!wantsDir) {
      res.writeHead(301, { Location: `${url.pathname}/${url.search || ''}` });
      return res.end();
    }
    const indexPath = ['index.html', 'index.htm']
      .map((f) => path.join(target, f))
      .find((p) => statOrNull(p)?.isFile());
    if (indexPath) return sendFile(req, res, indexPath, fs.statSync(indexPath), { download });

    // 站点根目录没有 index.html 时，自动用识别出来的首页
    if (segments.length === 0 && site.entry) {
      const entryPath = path.join(base, site.entry);
      const entryStat = statOrNull(entryPath);
      if (entryStat?.isFile()) return sendFile(req, res, entryPath, entryStat, { download });
    }
    return sendDirectoryListing(req, res, target, url.pathname, site, { download });
  }

  if (stat.isFile()) return sendFile(req, res, target, stat, { download });
  return notFound(req, res, site);
}
