import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// 对外只开放这一个端口
export const PORT = Number(process.env.PORT || 9090);
export const HOST = process.env.HOST || '0.0.0.0';

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const SITES_DIR = path.join(DATA_DIR, 'sites');
export const DB_PATH = path.join(DATA_DIR, 'webdeployer.db');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// 每个站点保留多少个历史版本（用于回滚）
export const KEEP_RELEASES = Math.max(1, Number(process.env.KEEP_RELEASES || 5));

// 后台登录会话有效期
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);

// 登录失败锁定策略：第 5 次失败开始锁定，之后每次失败升级
export const LOCK_THRESHOLD = 5;
export const LOCK_STEPS_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
// 失败记录多久后自动清零（避免几个月前的误操作一直累计）
export const FAILURE_DECAY_MS = 24 * 60 * 60 * 1000;

// 挂在反向代理后面时设为 1，才会信任 X-Forwarded-For
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// HTTPS：证书和私钥都设置好才会启用 TLS，直接由本服务对外提供 https
export const TLS_CERT = process.env.TLS_CERT || '';
export const TLS_KEY = process.env.TLS_KEY || '';
export const TLS_PFX = process.env.TLS_PFX || '';
export const TLS_PFX_PASSPHRASE = process.env.TLS_PFX_PASSPHRASE || '';
export const TLS_ENABLED = Boolean((TLS_CERT && TLS_KEY) || TLS_PFX);
export const SCHEME = TLS_ENABLED ? 'https' : 'http';

// 站点访问路径前缀，例如 /s/我的站点/
export const SITE_PREFIX = '/s';

// 版本号里的日期时间按哪个时区生成。
// 走 Intl/ICU 计算，不依赖系统 tzdata —— alpine 镜像里默认没有时区文件。
export const VERSION_TZ = process.env.VERSION_TZ || 'Asia/Shanghai';

export const COOKIE_NAME = 'wd_session';

export const SKIP_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.git',
  'node_modules',
  '__MACOSX',
]);
