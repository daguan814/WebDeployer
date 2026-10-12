import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, SITES_DIR, DB_PATH } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT    NOT NULL UNIQUE,
    name            TEXT    NOT NULL,
    entry           TEXT,
    current_version TEXT,
    file_count      INTEGER NOT NULL DEFAULT 0,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS releases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    version    TEXT    NOT NULL,
    entry      TEXT,
    candidates TEXT,
    warnings   TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (site_id, version)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    ip         TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_events (
    ip           TEXT PRIMARY KEY,
    strikes      INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    last_fail    INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
  );
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function listSites() {
  return db.prepare('SELECT * FROM sites ORDER BY updated_at DESC').all();
}

export function getSite(slug) {
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug) || null;
}

export function listReleases(siteId, limit = 20) {
  return db
    .prepare('SELECT * FROM releases WHERE site_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(siteId, limit);
}

export function createSite(slug, name) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO sites (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(slug, name, now, now);
  return getSite(slug);
}

export function addRelease(siteId, release) {
  db.prepare(
    `INSERT INTO releases (site_id, version, entry, candidates, warnings, file_count, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    siteId,
    release.version,
    release.entry,
    JSON.stringify(release.candidates || []),
    JSON.stringify(release.warnings || []),
    release.file_count,
    release.size_bytes,
    Date.now(),
  );
}

export function promoteRelease(siteId, release) {
  db.prepare(
    `UPDATE sites
        SET current_version = ?, entry = ?, file_count = ?, size_bytes = ?, updated_at = ?
      WHERE id = ?`,
  ).run(release.version, release.entry, release.file_count, release.size_bytes, Date.now(), siteId);
}

export function pruneReleases(siteId, keep) {
  const rows = db
    .prepare('SELECT * FROM releases WHERE site_id = ? ORDER BY created_at DESC')
    .all(siteId);
  const keepers = rows.slice(0, keep);
  const current = db.prepare('SELECT current_version FROM sites WHERE id = ?').get(siteId);
  const keepVersions = new Set(keepers.map((r) => r.version));
  if (current?.current_version) keepVersions.add(current.current_version);
  return rows.filter((r) => !keepVersions.has(r.version));
}

export function dropRelease(siteId, version) {
  db.prepare('DELETE FROM releases WHERE site_id = ? AND version = ?').run(siteId, version);
}

export function deleteSite(slug) {
  db.prepare('DELETE FROM sites WHERE slug = ?').run(slug);
}
