import fs from 'node:fs';
import path from 'node:path';
import { SKIP_NAMES } from './config.js';

function shouldSkip(name) {
  return SKIP_NAMES.has(name) || name.startsWith('._');
}

/** 递归列出目录里的所有文件（返回相对路径，统一用 / 分隔） */
export function walkFiles(dir, prefix = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, rel, out);
    } else if (entry.isFile()) {
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      out.push({ rel, abs, size: stat.size });
    }
  }
  return out;
}

const HTML_RE = /\.(html?|htm)$/i;

/**
 * 扫描一个版本目录，识别首页 + 统计体积 + 检测绝对路径风险。
 */
export function scanRelease(releaseDir) {
  const files = walkFiles(releaseDir);
  let sizeBytes = 0;
  for (const f of files) sizeBytes += f.size;

  const htmlFiles = files.filter((f) => HTML_RE.test(f.rel));
  const candidates = pickCandidates(htmlFiles);
  const entry = candidates[0] || null;
  const warnings = detectAbsolutePaths(releaseDir, htmlFiles);

  return {
    file_count: files.length,
    size_bytes: sizeBytes,
    candidates,
    entry,
    warnings,
  };
}

/** 首页候选排序：根目录 index.html > 根目录唯一 html > 任意 index.html > 其他 */
function pickCandidates(htmlFiles) {
  const score = (rel) => {
    const depth = rel.split('/').length - 1;
    const base = path.basename(rel).toLowerCase();
    const isIndex = base === 'index.html' || base === 'index.htm';
    if (depth === 0 && isIndex) return 0;
    if (depth === 0) return 1;
    if (isIndex) return 2 + depth;
    return 10 + depth;
  };
  return htmlFiles
    .map((f) => f.rel)
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b, 'zh'))
    .slice(0, 12);
}

/** 检测 /xxx 这种绝对路径引用 —— 挂到子目录下会失效 */
function detectAbsolutePaths(releaseDir, htmlFiles) {
  const hits = [];
  for (const f of htmlFiles) {
    let text;
    try {
      const stat = fs.statSync(f.abs);
      if (stat.size > 4 * 1024 * 1024) continue;
      text = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const matches = text.match(/(?:src|href|poster|data-src)\s*=\s*["']\/(?!\/)[^"']*["']/gi);
    if (matches && matches.length) {
      hits.push({ file: f.rel, count: matches.length, sample: matches.slice(0, 3) });
    }
  }
  if (!hits.length) return [];
  const total = hits.reduce((a, h) => a + h.count, 0);
  return [
    {
      level: 'warn',
      message: `发现 ${total} 处以 / 开头的绝对路径引用，挂到子目录下会加载失败`,
      files: hits.slice(0, 5),
    },
  ];
}

/** 目录体积，用于展示 */
export function dirSize(dir) {
  let total = 0;
  for (const f of walkFiles(dir)) total += f.size;
  return total;
}
