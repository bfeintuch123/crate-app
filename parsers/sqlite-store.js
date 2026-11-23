'use strict';

// Bounded SQLite WAL state & stat-keyed cache store backed by Node 24 / Electron 42's
// built-in `node:sqlite` (`DatabaseSync`). Zero external npm dependencies.
//
// Provides drop-in compatibility with Crate's `store.get / set / delete` surface while
// replacing whole-file JSON re-reads and re-writes with indexed per-project rows,
// ACID multi-key transactions, and a persistent (dev, ino, size, mtimeNs, ctimeNs)
// cache for font inspections and raster thumbnails.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const OWNER_ONLY_FILE_MODE = 0o600;
const DEFAULT_MAX_STAT_CACHE_ENTRIES = 2000;
const SQLITE_FILENAME = 'crate-state.sqlite';

function hardenSqliteFile(filePath, expectedDirRealPath) {
  if (process.platform === 'win32') return true;
  let fd = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    fd = fs.openSync(filePath, flags);
    const initialStat = fs.fstatSync(fd);
    if (!initialStat.isFile() || initialStat.nlink !== 1) return false;
    if (typeof process.getuid === 'function' && initialStat.uid !== process.getuid()) return false;
    const real = fs.realpathSync.native(filePath);
    if (path.dirname(real) !== expectedDirRealPath) return false;
    fs.fchmodSync(fd, OWNER_ONLY_FILE_MODE);
    const finalStat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(filePath);
    return (
      finalStat.isFile() &&
      finalStat.nlink === 1 &&
      finalStat.dev === initialStat.dev &&
      finalStat.ino === initialStat.ino &&
      (finalStat.mode & 0o777) === OWNER_ONLY_FILE_MODE &&
      !pathStat.isSymbolicLink() &&
      pathStat.isFile() &&
      pathStat.dev === finalStat.dev &&
      pathStat.ino === finalStat.ino &&
      pathStat.nlink === 1
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function preflightSqlitePaths(userDataRealPath, fileName = SQLITE_FILENAME) {
  if (typeof userDataRealPath !== 'string' || !userDataRealPath || !path.isAbsolute(userDataRealPath)) {
    throw new Error('Invalid SQLite storage directory.');
  }
  const dbPath = path.join(userDataRealPath, fileName);
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!hardenSqliteFile(candidate, userDataRealPath)) {
      throw new Error('Crate could not secure local SQLite storage.');
    }
  }
  return dbPath;
}

function normalizeStatTuple(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const dev = stat.dev !== undefined && stat.dev !== null ? String(stat.dev) : null;
  const ino = stat.ino !== undefined && stat.ino !== null ? String(stat.ino) : null;
  const sizeNum = typeof stat.size === 'bigint' ? Number(stat.size) : Number(stat.size);
  const mtimeNs = stat.mtimeNs !== undefined && stat.mtimeNs !== null
    ? String(stat.mtimeNs)
    : (stat.mtimeMs !== undefined && stat.mtimeMs !== null ? String(stat.mtimeMs) : null);
  const ctimeNs = stat.ctimeNs !== undefined && stat.ctimeNs !== null
    ? String(stat.ctimeNs)
    : (stat.ctimeMs !== undefined && stat.ctimeMs !== null ? String(stat.ctimeMs) : '');
  if (dev === null || ino === null || !Number.isSafeInteger(sizeNum) || sizeNum < 0 || mtimeNs === null) {
    return null;
  }
  return { dev, ino, size: sizeNum, mtimeNs, ctimeNs };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getNestedValue(root, parts) {
  let cursor = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function setNestedValue(root, parts, value) {
  const target = isPlainObject(root) ? { ...root } : {};
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = cursor[part];
    cursor[part] = isPlainObject(next) ? { ...next } : {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

function deleteNestedValue(root, parts) {
  if (!isPlainObject(root)) return root;
  const target = structuredClone(root);
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainObject(cursor[part])) return target;
    cursor = cursor[part];
  }
  delete cursor[parts[parts.length - 1]];
  return target;
}

class CrateSqliteStore {
  constructor({
    userDataRealPath,
    fileName = SQLITE_FILENAME,
    defaults = {},
    maxStatCacheEntries = DEFAULT_MAX_STAT_CACHE_ENTRIES,
  }) {
    this.userDataRealPath = userDataRealPath;
    this.path = preflightSqlitePaths(userDataRealPath, fileName);
    this.defaults = structuredClone(defaults || {});
    this.maxStatCacheEntries = Math.max(64, Number(maxStatCacheEntries) || DEFAULT_MAX_STAT_CACHE_ENTRIES);
    this.closed = false;
    this.inTransaction = false;

    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        status TEXT,
        updated_at INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_position ON projects(position);
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_stat_cache (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        dev TEXT NOT NULL,
        ino TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ns TEXT NOT NULL,
        ctime_ns TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        accessed_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, cache_key)
      );
      CREATE INDEX IF NOT EXISTS idx_file_stat_cache_accessed ON file_stat_cache(accessed_at);
    `);

    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (!hardenSqliteFile(candidate, this.userDataRealPath)) {
        this.close();
        throw new Error('Crate could not secure local SQLite storage.');
      }
    }

    this.stmts = {
      selectAllProjects: this.db.prepare('SELECT id, position, data_json FROM projects ORDER BY position ASC, rowid ASC'),
      selectProjectById: this.db.prepare('SELECT id, position, data_json FROM projects WHERE id = ?'),
      upsertProject: this.db.prepare(
        'INSERT INTO projects (id, position, status, updated_at, data_json) VALUES (?, ?, ?, ?, ?) '
        + 'ON CONFLICT(id) DO UPDATE SET position = excluded.position, status = excluded.status, '
        + 'updated_at = excluded.updated_at, data_json = excluded.data_json'
      ),
      deleteProjectById: this.db.prepare('DELETE FROM projects WHERE id = ?'),
      deleteAllProjects: this.db.prepare('DELETE FROM projects'),
      selectKv: this.db.prepare('SELECT value_json FROM kv WHERE key = ?'),
      upsertKv: this.db.prepare(
        'INSERT INTO kv (key, value_json) VALUES (?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
      ),
      deleteKv: this.db.prepare('DELETE FROM kv WHERE key = ?'),
      selectStatCache: this.db.prepare(
        'SELECT dev, ino, size, mtime_ns, ctime_ns, payload_json FROM file_stat_cache WHERE namespace = ? AND cache_key = ?'
      ),
      touchStatCache: this.db.prepare(
        'UPDATE file_stat_cache SET accessed_at = ? WHERE namespace = ? AND cache_key = ?'
      ),
      upsertStatCache: this.db.prepare(
        'INSERT INTO file_stat_cache (namespace, cache_key, dev, ino, size, mtime_ns, ctime_ns, payload_json, accessed_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(namespace, cache_key) DO UPDATE SET '
        + 'dev = excluded.dev, ino = excluded.ino, size = excluded.size, '
        + 'mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns, '
        + 'payload_json = excluded.payload_json, accessed_at = excluded.accessed_at'
      ),
      countStatCache: this.db.prepare('SELECT COUNT(*) AS count FROM file_stat_cache'),
      evictOldestStatCache: this.db.prepare(
        'DELETE FROM file_stat_cache WHERE rowid IN (SELECT rowid FROM file_stat_cache ORDER BY accessed_at ASC LIMIT ?)'
      ),
      clearStatCacheNamespace: this.db.prepare('DELETE FROM file_stat_cache WHERE namespace = ?'),
      clearAllStatCache: this.db.prepare('DELETE FROM file_stat_cache'),
    };

    // In-memory write-through mirror of raw JSON strings & parsed templates.
    // Every public getter returns a fresh clone so caller mutations before commit
    // can never corrupt persisted state (matching electron-store's isolation contract).
    this.projectJsonById = new Map();
    this.projectOrder = [];
    this.kvCache = new Map();
    this.statCacheWrites = 0;

    this._hydrateMemoryCache();
    this._ensureDefaults();
  }

  _hydrateMemoryCache() {
    this.projectJsonById.clear();
    this.projectOrder = [];
    for (const row of this.stmts.selectAllProjects.all()) {
      this.projectOrder.push(row.id);
      this.projectJsonById.set(row.id, row.data_json);
    }
    this.kvCache.clear();
  }

  _ensureDefaults() {
    const missing = [];
    for (const [key, value] of Object.entries(this.defaults)) {
      if (key === 'projects') continue;
      if (!this.stmts.selectKv.get(key)) {
        missing.push([key, value]);
      }
    }
    if (missing.length > 0) {
      this.transaction(() => {
        for (const [key, value] of missing) {
          this._setKvDirect(key, value);
        }
      });
    }
  }

  migrateFromLegacyStore(legacyStore) {
    if (!legacyStore || typeof legacyStore.get !== 'function') return false;
    // Fast pre-check avoids reading legacy JSON on ordinary subsequent startups;
    // authoritative check still runs atomically inside BEGIN IMMEDIATE below.
    const cachedMeta = this._getKvRaw('_meta');
    if (cachedMeta && cachedMeta.migratedFromLegacy === true) return false;

    const legacyProjects = legacyStore.get('projects', []);
    const legacySettings = legacyStore.get('settings', this.defaults.settings || {});
    const legacyUsage = legacyStore.get('usage', this.defaults.usage || {});
    const legacyQuickOutputs = legacyStore.get('quickPackageOutputPaths', undefined);

    let migrated = false;
    this.transaction(() => {
      // Authoritative in-transaction check against SQLite (never trust stale memory cache)
      // so two concurrent processes cannot both migrate the same profile.
      const metaRow = this.stmts.selectKv.get('_meta');
      if (metaRow) {
        try {
          const parsedMeta = JSON.parse(metaRow.value_json);
          if (parsedMeta && parsedMeta.migratedFromLegacy === true) {
            this._hydrateMemoryCache();
            this.kvCache.set('_meta', metaRow.value_json);
            return;
          }
        } catch (_) {}
      }
      const existingRows = this.stmts.selectAllProjects.all();
      const hasExistingProjects = existingRows.length > 0;
      if (Array.isArray(legacyProjects) && legacyProjects.length > 0 && !hasExistingProjects) {
        this._replaceProjectsDirect(legacyProjects);
      } else if (hasExistingProjects) {
        this._hydrateMemoryCache();
      }
      if (isPlainObject(legacySettings) && (!hasExistingProjects || !this.stmts.selectKv.get('settings'))) {
        this._setKvDirect('settings', legacySettings);
      }
      if (isPlainObject(legacyUsage) && (!hasExistingProjects || !this.stmts.selectKv.get('usage'))) {
        this._setKvDirect('usage', legacyUsage);
      }
      if (Array.isArray(legacyQuickOutputs) && (!hasExistingProjects || !this.stmts.selectKv.get('quickPackageOutputPaths'))) {
        this._setKvDirect('quickPackageOutputPaths', legacyQuickOutputs);
      }
      this._setKvDirect('_meta', { migratedFromLegacy: true, migratedAt: Date.now() });
      migrated = true;
    });
    return migrated;
  }

  transaction(fn) {
    if (this.closed) throw new Error('SQLite store is closed.');
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      this._hydrateMemoryCache();
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  _getKvRaw(key) {
    if (this.kvCache.has(key)) {
      const cached = this.kvCache.get(key);
      return cached === undefined ? undefined : JSON.parse(cached);
    }
    const row = this.stmts.selectKv.get(key);
    if (!row) {
      this.kvCache.set(key, undefined);
      return undefined;
    }
    this.kvCache.set(key, row.value_json);
    return JSON.parse(row.value_json);
  }

  _setKvDirect(key, value) {
    const json = JSON.stringify(value);
    if (this.kvCache.get(key) === json) return false;
    this.stmts.upsertKv.run(key, json);
    this.kvCache.set(key, json);
    return true;
  }

  _deleteKvDirect(key) {
    this.stmts.deleteKv.run(key);
    this.kvCache.set(key, undefined);
  }

  _replaceProjectsDirect(projects) {
    if (!Array.isArray(projects)) throw new Error('projects must be an array');
    const now = Date.now();
    const nextOrder = [];
    const seenIds = new Set();

    for (let position = 0; position < projects.length; position += 1) {
      const project = projects[position];
      if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !project.id) {
        continue;
      }
      if (seenIds.has(project.id)) continue;
      seenIds.add(project.id);
      nextOrder.push(project.id);

      const json = JSON.stringify(project);
      const prevJson = this.projectJsonById.get(project.id);
      const prevPos = this.projectOrder.indexOf(project.id);
      if (prevJson !== json || prevPos !== position) {
        this.stmts.upsertProject.run(
          project.id,
          position,
          typeof project.status === 'string' ? project.status : null,
          now,
          json
        );
        this.projectJsonById.set(project.id, json);
      }
    }

    for (const existingId of this.projectOrder) {
      if (!seenIds.has(existingId)) {
        this.stmts.deleteProjectById.run(existingId);
        this.projectJsonById.delete(existingId);
      }
    }
    this.projectOrder = nextOrder;
  }

  getProjectById(projectId) {
    if (this.closed) throw new Error('SQLite store is closed.');
    if (typeof projectId !== 'string' || !projectId) return null;
    const json = this.projectJsonById.get(projectId);
    if (json === undefined) return null;
    return JSON.parse(json);
  }

  upsertProject(project) {
    if (this.closed) throw new Error('SQLite store is closed.');
    if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !project.id) {
      throw new Error('Invalid project record.');
    }
    const json = JSON.stringify(project);
    const existingIndex = this.projectOrder.indexOf(project.id);
    if (existingIndex >= 0 && this.projectJsonById.get(project.id) === json) {
      return false;
    }
    const position = existingIndex >= 0 ? existingIndex : this.projectOrder.length;
    this.transaction(() => {
      this.stmts.upsertProject.run(
        project.id,
        position,
        typeof project.status === 'string' ? project.status : null,
        Date.now(),
        json
      );
      if (existingIndex < 0) this.projectOrder.push(project.id);
      this.projectJsonById.set(project.id, json);
    });
    return true;
  }

  get(key, defaultValue) {
    if (this.closed) throw new Error('SQLite store is closed.');
    if (key === 'projects') {
      const list = new Array(this.projectOrder.length);
      for (let i = 0; i < this.projectOrder.length; i += 1) {
        list[i] = JSON.parse(this.projectJsonById.get(this.projectOrder[i]));
      }
      return list;
    }
    if (typeof key === 'string' && key.includes('.')) {
      const parts = key.split('.');
      const root = this._getKvRaw(parts[0]);
      const found = getNestedValue(root, parts.slice(1));
      if (found !== undefined) return found;
      const fallback = getNestedValue(this.defaults, parts);
      return fallback !== undefined ? structuredClone(fallback) : defaultValue;
    }
    const value = this._getKvRaw(key);
    if (value !== undefined) return value;
    if (Object.prototype.hasOwnProperty.call(this.defaults, key)) {
      return structuredClone(this.defaults[key]);
    }
    return defaultValue;
  }

  set(keyOrObject, value) {
    if (this.closed) throw new Error('SQLite store is closed.');
    if (isPlainObject(keyOrObject)) {
      this.transaction(() => {
        for (const [entryKey, entryValue] of Object.entries(keyOrObject)) {
          this._setSingle(entryKey, entryValue);
        }
      });
      return;
    }
    this.transaction(() => {
      this._setSingle(keyOrObject, value);
    });
  }

  _setSingle(key, value) {
    if (key === 'projects') {
      this._replaceProjectsDirect(value);
      return;
    }
    if (typeof key === 'string' && key.includes('.')) {
      const parts = key.split('.');
      const rootKey = parts[0];
      const current = this._getKvRaw(rootKey) ?? structuredClone(this.defaults[rootKey] || {});
      const updated = setNestedValue(current, parts.slice(1), value);
      this._setKvDirect(rootKey, updated);
      return;
    }
    this._setKvDirect(key, value);
  }

  delete(key) {
    if (this.closed) throw new Error('SQLite store is closed.');
    this.transaction(() => {
      if (key === 'projects') {
        this.stmts.deleteAllProjects.run();
        this.projectJsonById.clear();
        this.projectOrder = [];
        return;
      }
      if (typeof key === 'string' && key.includes('.')) {
        const parts = key.split('.');
        const rootKey = parts[0];
        const current = this._getKvRaw(rootKey);
        if (current === undefined) return;
        const updated = deleteNestedValue(current, parts.slice(1));
        this._setKvDirect(rootKey, updated);
        return;
      }
      this._deleteKvDirect(key);
    });
  }

  getStatCache(namespace, cacheKey, stat) {
    if (this.closed) return null;
    const tuple = normalizeStatTuple(stat);
    if (!tuple || typeof namespace !== 'string' || typeof cacheKey !== 'string') return null;
    try {
      const row = this.stmts.selectStatCache.get(namespace, cacheKey);
      if (!row) return null;
      if (
        row.dev !== tuple.dev
        || row.ino !== tuple.ino
        || row.size !== tuple.size
        || row.mtime_ns !== tuple.mtimeNs
        || row.ctime_ns !== tuple.ctimeNs
      ) {
        return null;
      }
      return JSON.parse(row.payload_json);
    } catch (_) {
      return null;
    }
  }

  setStatCache(namespace, cacheKey, stat, payload) {
    if (this.closed) return false;
    const tuple = normalizeStatTuple(stat);
    if (!tuple || typeof namespace !== 'string' || typeof cacheKey !== 'string') return false;
    try {
      const json = JSON.stringify(payload);
      const now = Date.now();
      this.stmts.upsertStatCache.run(
        namespace,
        cacheKey,
        tuple.dev,
        tuple.ino,
        tuple.size,
        tuple.mtimeNs,
        tuple.ctimeNs,
        json,
        now
      );
      this.statCacheWrites += 1;
      if (this.statCacheWrites % 64 === 0) {
        const row = this.stmts.countStatCache.get();
        const excess = (row ? Number(row.count) : 0) - this.maxStatCacheEntries;
        if (excess > 0) {
          this.stmts.evictOldestStatCache.run(excess + 32);
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  clearStatCache(namespace = null) {
    if (this.closed) return;
    try {
      if (typeof namespace === 'string' && namespace) {
        this.stmts.clearStatCacheNamespace.run(namespace);
      } else {
        this.stmts.clearAllStatCache.run();
      }
    } catch (_) {}
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    try { this.db.close(); } catch (_) {}
  }
}

module.exports = {
  CrateSqliteStore,
  SQLITE_FILENAME,
  normalizeStatTuple,
  preflightSqlitePaths,
};
