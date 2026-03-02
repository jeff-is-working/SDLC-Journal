/**
 * PeopleSafe SDLC Journal - Alpine.js Application
 * State management, auth flow, and all view logic.
 */

document.addEventListener('alpine:init', () => {

  Alpine.data('sdlcApp', () => ({
    // --- State ---
    view: 'loading', // loading | unsupported | setup | auth | dashboard | entry | browse | rollup | about | settings
    error: '',
    message: '',
    isProcessing: false,

    // Auth
    passphrase: '',
    passphraseConfirm: '',
    cryptoKey: null,
    isFirstTime: false,

    // Dashboard / Entry
    todayDate: Utils.today(),
    entryForm: { success: '', delight: '', learning: '', compliment: '' },
    hasEntryToday: false,
    recentEntries: [],

    // Browse
    allEntryMetas: [],
    browseGroups: [],
    searchQuery: '',
    searchResults: null,
    selectedEntry: null,
    isEditing: false,
    editForm: { success: '', delight: '', learning: '', compliment: '' },

    // Rollups
    rollupTab: 'weekly',
    availablePeriods: { weeks: [], months: [], quarters: [], years: [] },
    selectedPeriod: '',
    currentRollup: null,
    subReflections: [],
    reflectionText: '',
    _reflectionSaveTimer: null,

    // Settings
    storageEstimate: null,
    entryCount: 0,
    showClearConfirm: false,
    clearConfirmText: '',
    importError: '',

    // Session
    _lockTimer: null,
    _lastActivity: Date.now(),
    _failedAttempts: 0,
    _lockoutUntil: 0,

    // --- Init ---
    async init() {
      if (!Crypto.isSupported()) {
        this.view = 'unsupported';
        return;
      }

      try {
        await Storage.init();
        this.isFirstTime = !(await Storage.hasPassphrase());
        this.view = this.isFirstTime ? 'setup' : 'auth';
      } catch (e) {
        this.error = 'Failed to initialize storage: ' + e.message;
        this.view = 'unsupported';
      }

      // Session management
      this._setupSessionHandlers();

      // Expose app reference for Electron bridge (only when running in Electron)
      if (window.electronAPI) window.sdlcAppRef = this;
    },

    // --- Auth ---
    async createPassphrase() {
      this.error = '';

      if (this.passphrase.length < 12) {
        this.error = 'Passphrase must be at least 12 characters.';
        return;
      }

      if (this.passphrase !== this.passphraseConfirm) {
        this.error = 'Passphrases do not match.';
        return;
      }

      this.isProcessing = true;

      try {
        // Generate salts
        const keySalt = Crypto.generateSalt();
        const hashSalt = Crypto.generateSalt();

        // Derive encryption key
        this.cryptoKey = await Crypto.deriveKey(this.passphrase, keySalt);

        // Hash passphrase for verification
        const hash = await Crypto.hashPassphrase(this.passphrase, hashSalt);

        // Store salts and hash
        await Storage.setMeta('keySalt', Crypto.saltToBase64(keySalt));
        await Storage.setMeta('passphraseSalt', Crypto.saltToBase64(hashSalt));
        await Storage.setMeta('passphraseHash', hash);

        this._clearPassphraseFields();
        await this._enterApp();
      } catch (e) {
        this.error = 'Failed to create passphrase: ' + e.message;
      } finally {
        this.isProcessing = false;
      }
    },

    async unlock() {
      this.error = '';

      // Rate limiting: progressive delay after failed attempts
      if (Date.now() < this._lockoutUntil) {
        const remaining = Math.ceil((this._lockoutUntil - Date.now()) / 1000);
        this.error = `Too many attempts. Please wait ${remaining} seconds.`;
        return;
      }

      if (!this.passphrase) {
        this.error = 'Please enter your passphrase.';
        return;
      }

      this.isProcessing = true;

      try {
        // Verify passphrase
        const storedHash = await Storage.getMeta('passphraseHash');
        const hashSalt = await Storage.getMeta('passphraseSalt');
        const computedHash = await Crypto.hashPassphrase(this.passphrase, hashSalt);

        if (computedHash !== storedHash) {
          this._failedAttempts++;
          const delay = Math.min(Math.pow(2, this._failedAttempts) * 1000, 30000);
          this._lockoutUntil = Date.now() + delay;
          this.error = 'Incorrect passphrase. Please try again.';
          this.isProcessing = false;
          return;
        }

        // Derive encryption key
        const keySalt = await Storage.getMeta('keySalt');
        this.cryptoKey = await Crypto.deriveKey(this.passphrase, keySalt);

        // Reset rate limiting on success
        this._failedAttempts = 0;
        this._lockoutUntil = 0;

        this._clearPassphraseFields();
        await this._enterApp();
      } catch (e) {
        this.error = 'Failed to unlock: ' + e.message;
      } finally {
        this.isProcessing = false;
      }
    },

    async _enterApp() {
      await this._loadDashboard();
      this.view = 'dashboard';
      this._resetLockTimer();
    },

    _clearPassphraseFields() {
      this.passphrase = '';
      this.passphraseConfirm = '';
    },

    lock() {
      // Clear the encryption key
      this.cryptoKey = null;

      // Clear all decrypted content
      this.entryForm = { success: '', delight: '', learning: '', compliment: '' };
      this.editForm = { success: '', delight: '', learning: '', compliment: '' };
      this.selectedEntry = null;
      this.currentRollup = null;
      this.searchResults = null;
      this.recentEntries = [];
      this.reflectionText = '';
      this.subReflections = [];
      this.browseGroups = [];
      this.allEntryMetas = [];
      this.searchQuery = '';

      // Reset UI state
      this.view = 'auth';
      this.error = '';
      this.message = '';
      this.isEditing = false;

      // Cancel timers
      clearTimeout(this._lockTimer);
      clearTimeout(this._reflectionSaveTimer);

      // Clear clipboard of any copied journal content
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText('').catch(() => {});
      }
    },

    // --- Dashboard ---
    async _loadDashboard() {
      this.todayDate = Utils.today();
      this.allEntryMetas = await Storage.getAllEntryMetas();

      // Load today's entry if exists
      const todayEntry = await Storage.getEntry(this.todayDate);
      if (todayEntry) {
        try {
          const plain = await Crypto.decrypt(todayEntry.ciphertext, todayEntry.iv, this.cryptoKey);
          const data = JSON.parse(plain);
          this.entryForm = {
            success: data.success || '',
            delight: data.delight || '',
            learning: data.learning || '',
            compliment: data.compliment || ''
          };
          this.hasEntryToday = true;
        } catch (e) {
          this.entryForm = { success: '', delight: '', learning: '', compliment: '' };
          this.hasEntryToday = false;
        }
      } else {
        this.entryForm = { success: '', delight: '', learning: '', compliment: '' };
        this.hasEntryToday = false;
      }

      // Recent entries (last 5, excluding today)
      this.recentEntries = [];
      const recent = this.allEntryMetas.filter(m => m.date !== this.todayDate).slice(0, 5);
      for (const meta of recent) {
        try {
          const entry = await Storage.getEntry(meta.id);
          const plain = await Crypto.decrypt(entry.ciphertext, entry.iv, this.cryptoKey);
          const data = JSON.parse(plain);
          this.recentEntries.push({
            date: meta.date,
            dateLabel: Utils.formatDateShort(meta.date),
            preview: Utils.truncate(
              [data.success, data.delight, data.learning, data.compliment].filter(Boolean).join(' | '),
              120
            )
          });
        } catch (e) {
          // Skip unreadable entries
        }
      }
    },

    async saveEntry() {
      this.error = '';
      this.message = '';

      const hasContent = this.entryForm.success.trim() ||
                         this.entryForm.delight.trim() ||
                         this.entryForm.learning.trim() ||
                         this.entryForm.compliment.trim();

      if (!hasContent) {
        this.error = 'Please fill in at least one field.';
        return;
      }

      this.isProcessing = true;

      try {
        const plaintext = JSON.stringify(this.entryForm);
        const { ciphertext, iv } = await Crypto.encrypt(plaintext, this.cryptoKey);
        const now = new Date().toISOString();

        const existing = await Storage.getEntry(this.todayDate);

        await Storage.saveEntry({
          id: this.todayDate,
          date: this.todayDate,
          ciphertext,
          iv,
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now
        });

        this.hasEntryToday = true;
        this.message = 'Entry saved successfully.';
        this.allEntryMetas = await Storage.getAllEntryMetas();

        // Refresh recent entries
        await this._loadDashboard();
      } catch (e) {
        this.error = 'Failed to save entry: ' + e.message;
      } finally {
        this.isProcessing = false;
      }
    },

    // --- Navigation ---
    async navigate(view) {
      this.error = '';
      this.message = '';
      this._resetLockTimer();

      if (view === 'dashboard') {
        await this._loadDashboard();
      } else if (view === 'browse') {
        await this._loadBrowse();
      } else if (view === 'rollup') {
        await this._loadRollups();
      } else if (view === 'settings') {
        await this._loadSettings();
      }

      this.view = view;
      this.selectedEntry = null;
      this.isEditing = false;
      this.searchResults = null;
      this.searchQuery = '';

      // Move focus to the new view's heading for screen readers
      this.$nextTick(() => {
        const heading = document.querySelector('[x-show="view === \'' + view + '\'"] h2');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus();
        }
      });
    },

    // --- Browse ---
    async _loadBrowse() {
      this.allEntryMetas = await Storage.getAllEntryMetas();
      this.browseGroups = Utils.groupByMonth(this.allEntryMetas);
    },

    async viewEntry(dateId) {
      this._resetLockTimer();
      try {
        const entry = await Storage.getEntry(dateId);
        if (!entry) return;

        const plain = await Crypto.decrypt(entry.ciphertext, entry.iv, this.cryptoKey);
        const data = JSON.parse(plain);

        this.selectedEntry = {
          id: entry.id,
          date: entry.date,
          dateLabel: Utils.formatDate(entry.date),
          data,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        };
        this.isEditing = false;
      } catch (e) {
        this.error = 'Failed to decrypt entry.';
      }
    },

    startEdit() {
      if (!this.selectedEntry) return;
      this.editForm = { ...this.selectedEntry.data };
      this.isEditing = true;
    },

    cancelEdit() {
      this.isEditing = false;
    },

    async saveEdit() {
      this.error = '';
      this.isProcessing = true;

      try {
        const plaintext = JSON.stringify(this.editForm);
        const { ciphertext, iv } = await Crypto.encrypt(plaintext, this.cryptoKey);
        const existing = await Storage.getEntry(this.selectedEntry.id);

        await Storage.saveEntry({
          id: this.selectedEntry.id,
          date: this.selectedEntry.date,
          ciphertext,
          iv,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString()
        });

        this.selectedEntry.data = { ...this.editForm };
        this.isEditing = false;
        this.message = 'Entry updated.';
        await this._loadBrowse();
      } catch (e) {
        this.error = 'Failed to save edit: ' + e.message;
      } finally {
        this.isProcessing = false;
      }
    },

    async deleteEntry() {
      if (!this.selectedEntry) return;
      if (!confirm('Delete this entry? This cannot be undone.')) return;

      try {
        await Storage.deleteEntry(this.selectedEntry.id);
        this.selectedEntry = null;
        this.message = 'Entry deleted.';
        await this._loadBrowse();
      } catch (e) {
        this.error = 'Failed to delete entry.';
      }
    },

    async search() {
      this._resetLockTimer();
      const q = this.searchQuery.trim().toLowerCase();
      if (!q) {
        this.searchResults = null;
        return;
      }

      this.isProcessing = true;
      const results = [];

      try {
        for (const meta of this.allEntryMetas) {
          const entry = await Storage.getEntry(meta.id);
          if (!entry) continue;
          try {
            const plain = await Crypto.decrypt(entry.ciphertext, entry.iv, this.cryptoKey);
            const data = JSON.parse(plain);
            const combined = [data.success, data.delight, data.learning, data.compliment]
              .join(' ').toLowerCase();
            if (combined.includes(q)) {
              results.push({
                date: meta.date,
                dateLabel: Utils.formatDateShort(meta.date),
                preview: Utils.truncate(
                  [data.success, data.delight, data.learning, data.compliment].filter(Boolean).join(' | '),
                  120
                )
              });
            }
          } catch (e) {
            // Skip unreadable
          }
        }
        this.searchResults = results;
      } finally {
        this.isProcessing = false;
      }
    },

    // --- Rollups ---
    async _loadRollups() {
      this.allEntryMetas = await Storage.getAllEntryMetas();
      this.availablePeriods = Rollups.getAvailablePeriods(this.allEntryMetas);
      this._selectDefaultPeriod();
      if (this.selectedPeriod) {
        await this._loadRollupData();
      } else {
        this.currentRollup = null;
      }
    },

    _selectDefaultPeriod() {
      const periodMap = {
        weekly: this.availablePeriods.weeks,
        monthly: this.availablePeriods.months,
        quarterly: this.availablePeriods.quarters,
        yearly: this.availablePeriods.years
      };
      const periods = periodMap[this.rollupTab] || [];
      this.selectedPeriod = periods.length > 0 ? periods[0] : '';
    },

    async switchRollupTab(tab) {
      this.rollupTab = tab;
      this._selectDefaultPeriod();
      if (this.selectedPeriod) {
        await this._loadRollupData();
      } else {
        this.currentRollup = null;
        this.subReflections = [];
      }
    },

    async selectPeriod(periodKey) {
      this.selectedPeriod = periodKey;
      await this._loadRollupData();
    },

    async _loadRollupData() {
      if (!this.selectedPeriod) return;

      this.isProcessing = true;

      try {
        // Get all entries for this period
        const allEncrypted = await Storage.getEntriesByDateRange('0000-00-00', '9999-99-99');
        const periodEntries = Rollups.getEntriesForPeriod(
          allEncrypted.map(e => ({ ...e })),
          this.selectedPeriod,
          this.rollupTab
        );

        // Decrypt entries
        const decrypted = [];
        for (const entry of periodEntries) {
          try {
            const plain = await Crypto.decrypt(entry.ciphertext, entry.iv, this.cryptoKey);
            decrypted.push({ date: entry.date, data: JSON.parse(plain) });
          } catch (e) {
            // Skip
          }
        }

        // Load existing reflection
        const rollupId = `${this.rollupTab}:${this.selectedPeriod}`;
        const existingRollup = await Storage.getRollup(rollupId);
        let existingReflection = '';
        if (existingRollup && existingRollup.ciphertext) {
          try {
            existingReflection = await Crypto.decrypt(
              existingRollup.ciphertext, existingRollup.iv, this.cryptoKey
            );
          } catch (e) {
            // Ignore
          }
        }

        this.currentRollup = Rollups.generateSummary(
          decrypted, this.selectedPeriod, this.rollupTab, existingReflection
        );
        this.reflectionText = existingReflection;

        // Load sub-period reflections for higher-level rollups
        this.subReflections = await Rollups.getSubPeriodReflections(
          this.rollupTab, this.selectedPeriod, this.cryptoKey
        );
      } catch (e) {
        this.error = 'Failed to load rollup: ' + e.message;
      } finally {
        this.isProcessing = false;
      }
    },

    async saveReflection() {
      if (!this.selectedPeriod) return;

      try {
        const rollupId = `${this.rollupTab}:${this.selectedPeriod}`;
        const now = new Date().toISOString();
        const existing = await Storage.getRollup(rollupId);

        let ciphertext = '';
        let iv = '';
        if (this.reflectionText.trim()) {
          const encrypted = await Crypto.encrypt(this.reflectionText, this.cryptoKey);
          ciphertext = encrypted.ciphertext;
          iv = encrypted.iv;
        }

        await Storage.saveRollup({
          id: rollupId,
          type: this.rollupTab,
          periodKey: this.selectedPeriod,
          ciphertext,
          iv,
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now
        });
      } catch (e) {
        // Silent fail for auto-save; user can retry
      }
    },

    debouncedSaveReflection: null,

    _initReflectionAutoSave() {
      if (!this.debouncedSaveReflection) {
        this.debouncedSaveReflection = Utils.debounce(() => {
          this.saveReflection();
        }, 1500);
      }
    },

    onReflectionInput() {
      this._initReflectionAutoSave();
      this.debouncedSaveReflection();
    },

    // --- Settings ---
    async _loadSettings() {
      this.storageEstimate = await Storage.getStorageEstimate();
      this.entryCount = await Storage.getEntryCount();
      this.showClearConfirm = false;
      this.clearConfirmText = '';
      this.importError = '';
    },

    async exportData() {
      try {
        const result = await Storage.exportAll();
        this.message = `Exported ${result.entryCount} entries and ${result.rollupCount} rollups.`;
      } catch (e) {
        this.error = 'Export failed: ' + e.message;
      }
    },

    async importData(event) {
      this.importError = '';
      const file = event.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const result = await Storage.importAll(text);
        this.message = `Imported ${result.entriesImported} entries and ${result.rollupsImported} rollups. Please lock and re-enter your passphrase.`;
        event.target.value = '';
      } catch (e) {
        this.importError = 'Import failed: ' + e.message;
        event.target.value = '';
      }
    },

    async clearAllData() {
      if (this.clearConfirmText !== 'DELETE ALL') return;

      try {
        await Storage.clearAll();
        this.message = 'All data cleared. Redirecting to setup...';
        this.cryptoKey = null;
        setTimeout(() => {
          this.view = 'setup';
          this.isFirstTime = true;
          this.message = '';
        }, 1500);
      } catch (e) {
        this.error = 'Failed to clear data: ' + e.message;
      }
    },

    // --- Session Management ---
    _setupSessionHandlers() {
      // Clear key on page unload
      window.addEventListener('beforeunload', () => {
        this.cryptoKey = null;
      });

      // Auto-lock after 5 min of inactivity (tab hidden)
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.cryptoKey) {
          this._lockTimer = setTimeout(() => {
            this.lock();
          }, 5 * 60 * 1000);
        } else {
          clearTimeout(this._lockTimer);
        }
      });

      // Track activity
      ['click', 'keydown', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, () => {
          this._lastActivity = Date.now();
          this._resetLockTimer();
        }, { passive: true });
      });
    },

    _resetLockTimer() {
      this._lastActivity = Date.now();
    },

    // --- Helpers for Templates ---
    get isAuthed() {
      return this.cryptoKey !== null;
    },

    get currentPeriods() {
      const map = {
        weekly: this.availablePeriods.weeks,
        monthly: this.availablePeriods.months,
        quarterly: this.availablePeriods.quarters,
        yearly: this.availablePeriods.years
      };
      return map[this.rollupTab] || [];
    },

    formatPeriodLabel(key) {
      const fn = {
        weekly: Utils.formatWeekLabel,
        monthly: Utils.formatMonthLabel,
        quarterly: Utils.formatQuarterLabel,
        yearly: Utils.formatYearLabel
      };
      return (fn[this.rollupTab] || (k => k))(key);
    },

    getCategoryLabel(cat) {
      const labels = {
        success: 'Success',
        delight: 'Delight',
        learning: 'Learning',
        compliment: 'Compliment'
      };
      return labels[cat] || cat;
    },

    getCategoryIcon(cat) {
      const icons = {
        success: '\u2713',
        delight: '\u2605',
        learning: '\u270E',
        compliment: '\u2665'
      };
      return icons[cat] || '';
    }
  }));
});
