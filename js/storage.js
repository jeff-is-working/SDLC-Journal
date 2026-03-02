/**
 * PeopleSafe SDLC Journal - Storage Module
 * IndexedDB abstraction for encrypted entries, rollups, and metadata.
 */

const Storage = (() => {
  'use strict';

  const DB_NAME = 'PeopleSafeSDLC';
  const DB_VERSION = 1;
  let _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('entries')) {
          const entries = db.createObjectStore('entries', { keyPath: 'id' });
          entries.createIndex('date', 'date', { unique: true });
        }

        if (!db.objectStoreNames.contains('rollups')) {
          const rollups = db.createObjectStore('rollups', { keyPath: 'id' });
          rollups.createIndex('type', 'type', { unique: false });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        _db = event.target.result;
        resolve(_db);
      };

      request.onerror = (event) => {
        reject(new Error('IndexedDB open failed: ' + event.target.error));
      };
    });
  }

  function _tx(storeName, mode) {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function _request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function init() {
    await _open();
    // Request persistent storage
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist().catch(() => {});
    }
  }

  // --- Meta ---

  async function getMeta(key) {
    await _open();
    const result = await _request(_tx('meta', 'readonly').get(key));
    return result ? result.value : null;
  }

  async function setMeta(key, value) {
    await _open();
    return _request(_tx('meta', 'readwrite').put({ key, value }));
  }

  async function hasPassphrase() {
    const hash = await getMeta('passphraseHash');
    return !!hash;
  }

  // --- Entries ---

  async function saveEntry(entry) {
    await _open();
    // entry: { id, date, ciphertext, iv, createdAt, updatedAt }
    return _request(_tx('entries', 'readwrite').put(entry));
  }

  async function getEntry(id) {
    await _open();
    return _request(_tx('entries', 'readonly').get(id));
  }

  async function deleteEntry(id) {
    await _open();
    return _request(_tx('entries', 'readwrite').delete(id));
  }

  async function getAllEntryMetas() {
    await _open();
    const all = await _request(_tx('entries', 'readonly').getAll());
    // Return lightweight metadata (no ciphertext) for listing
    return all.map(e => ({
      id: e.id,
      date: e.date,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt
    })).sort((a, b) => b.date.localeCompare(a.date));
  }

  async function getEntriesByDateRange(startDate, endDate) {
    await _open();
    const all = await _request(_tx('entries', 'readonly').getAll());
    return all.filter(e => e.date >= startDate && e.date <= endDate)
              .sort((a, b) => a.date.localeCompare(b.date));
  }

  async function getEntryCount() {
    await _open();
    return _request(_tx('entries', 'readonly').count());
  }

  // --- Rollups ---

  async function saveRollup(rollup) {
    await _open();
    // rollup: { id, type, periodKey, ciphertext, iv, createdAt, updatedAt }
    return _request(_tx('rollups', 'readwrite').put(rollup));
  }

  async function getRollup(id) {
    await _open();
    return _request(_tx('rollups', 'readonly').get(id));
  }

  async function getAllRollupMetas() {
    await _open();
    const all = await _request(_tx('rollups', 'readonly').getAll());
    return all.map(r => ({
      id: r.id,
      type: r.type,
      periodKey: r.periodKey,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));
  }

  async function getRollupsByType(type) {
    await _open();
    const store = _tx('rollups', 'readonly');
    const index = store.index('type');
    return _request(index.getAll(type));
  }

  // --- Export / Import ---

  async function exportAll() {
    await _open();
    const entries = await _request(_tx('entries', 'readonly').getAll());
    const rollups = await _request(_tx('rollups', 'readonly').getAll());

    // Get all meta values
    const metaStore = _tx('meta', 'readonly');
    const allMeta = await _request(metaStore.getAll());

    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      app: 'PeopleSafe SDLC Journal',
      entries,
      rollups,
      meta: allMeta
    };

    const json = JSON.stringify(data, null, 2);
    const filename = `peoplesafe-sdlc-backup-${Utils.today()}.json`;

    // Use native save dialog in Electron, browser download otherwise
    if (window.electronAPI) {
      const result = await window.electronAPI.showSaveDialog({
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      });
      if (!result.canceled && result.filePath) {
        await window.electronAPI.saveFile(result.filePath, json);
      }
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    return { entryCount: entries.length, rollupCount: rollups.length };
  }

  async function importAll(jsonStr) {
    const data = JSON.parse(jsonStr);

    if (!data.version || !data.entries || !data.meta) {
      throw new Error('Invalid backup file format');
    }

    await _open();

    // Import meta — protect cryptographic keys from overwrite
    const protectedKeys = ['passphraseHash', 'passphraseSalt', 'keySalt'];
    for (const item of data.meta) {
      if (protectedKeys.includes(item.key)) continue;
      await _request(_tx('meta', 'readwrite').put(item));
    }

    // Import entries (merge - newer wins)
    for (const entry of data.entries) {
      const existing = await _request(_tx('entries', 'readonly').get(entry.id));
      if (!existing || entry.updatedAt > existing.updatedAt) {
        await _request(_tx('entries', 'readwrite').put(entry));
      }
    }

    // Import rollups (merge - newer wins)
    if (data.rollups) {
      for (const rollup of data.rollups) {
        const existing = await _request(_tx('rollups', 'readonly').get(rollup.id));
        if (!existing || rollup.updatedAt > existing.updatedAt) {
          await _request(_tx('rollups', 'readwrite').put(rollup));
        }
      }
    }

    return {
      entriesImported: data.entries.length,
      rollupsImported: (data.rollups || []).length
    };
  }

  // --- Clear All ---

  async function clearAll() {
    await _open();
    await _request(_tx('entries', 'readwrite').clear());
    await _request(_tx('rollups', 'readwrite').clear());
    await _request(_tx('meta', 'readwrite').clear());
  }

  // --- Storage Estimate ---

  async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return {
        usage: est.usage || 0,
        quota: est.quota || 0,
        usageMB: ((est.usage || 0) / (1024 * 1024)).toFixed(2),
        quotaMB: ((est.quota || 0) / (1024 * 1024)).toFixed(0)
      };
    }
    return { usage: 0, quota: 0, usageMB: '0', quotaMB: 'Unknown' };
  }

  return {
    init,
    getMeta,
    setMeta,
    hasPassphrase,
    saveEntry,
    getEntry,
    deleteEntry,
    getAllEntryMetas,
    getEntriesByDateRange,
    getEntryCount,
    saveRollup,
    getRollup,
    getAllRollupMetas,
    getRollupsByType,
    exportAll,
    importAll,
    clearAll,
    getStorageEstimate
  };
})();
