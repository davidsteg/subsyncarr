class SubsyncarrPlusClient {
  constructor() {
    this.ws = null;
    this.state = { currentRun: null, files: [], isRunning: false };
    this.reconnectInterval = 3000;
    this.historyRuns = [];
    this.historyPage = 0;
    this.historyPageSize = 50;
    this.allHistoryLoaded = false;

    this.initWebSocket();
    this.setupEventHandlers();
    this.fetchInitialState();
    this.fetchConfigStatus();
    this.fetchVersion();
  }

  initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws`);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      setTimeout(() => this.initWebSocket(), this.reconnectInterval);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        this.state = msg.data;
        this.render();
        break;
      case 'run:started':
        this.state.currentRun = msg.data;
        this.state.isRunning = true;
        this.render();
        break;
      case 'run:completed':
        this.state.currentRun = msg.data;
        this.state.isRunning = false;
        this.render();
        this.fetchHistory();
        break;
      case 'run:cancelled':
        this.state.currentRun = msg.data;
        this.state.isRunning = false;
        this.render();
        this.fetchHistory();
        break;
      case 'file:updated':
        this.updateFile(msg.data.file);
        if (msg.data.run) {
          this.state.currentRun = msg.data.run;
        }
        this.render();
        break;
      case 'files:cleared':
        this.state.currentRun = msg.data.currentRun;
        this.state.files = msg.data.files;
        this.render();
        break;
    }
  }

  updateFile(fileData) {
    const index = this.state.files.findIndex((f) => f.file_path === fileData.file_path);
    if (index >= 0) {
      this.state.files[index] = fileData;
    } else {
      this.state.files.push(fileData);
    }
  }

  async fetchInitialState() {
    this.showSkeleton('currentRunSkeleton', true);
    const response = await fetch('/api/status');
    const data = await response.json();
    this.state = data;
    this.render();
    this.showSkeleton('currentRunSkeleton', false);
    this.fetchHistory();
  }

  // ── History (uses /api/history/stats to avoid N+1 fetches) ──

  async fetchHistory(reset = true) {
    if (reset) {
      this.historyPage = 0;
      this.allHistoryLoaded = false;
      this.historyRuns = [];
    }

    this.showSkeleton('historySkeleton', true);

    const limit = this.historyPageSize;
    try {
      const response = await fetch(`/api/history/stats?limit=${limit}`);
      const history = await response.json();

      if (!history || history.length === 0) {
        this.allHistoryLoaded = true;
        this.renderHistory([]);
        return;
      }

      // Detect if we've loaded all available runs
      if (history.length < limit) {
        this.allHistoryLoaded = true;
      }

      // Merge: on reset = replace, on load more = append
      if (reset) {
        this.historyRuns = history;
      } else {
        // Avoid duplicates by run ID
        const existingIds = new Set(this.historyRuns.map((r) => r.id));
        const newRuns = history.filter((r) => !existingIds.has(r.id));
        this.historyRuns = [...this.historyRuns, ...newRuns];
      }

      this.renderHistory(this.historyRuns);
    } catch (error) {
      console.error('Failed to fetch history:', error);
      this.showToast('Failed to load run history', 'error');
    } finally {
      this.showSkeleton('historySkeleton', false);
    }
  }

  async loadMoreHistory() {
    this.historyPage++;
    // Multiply offset: each page loads a fresh batch from server
    // Server limits by row count, so we need to pass an offset
    const limit = this.historyPageSize;

    this.showSkeleton('historySkeleton', true);
    try {
      const response = await fetch(`/api/history/stats?limit=${limit}&offset=${this.historyPage * this.historyPageSize}`);
      const history = await response.json();

      if (!history || history.length === 0) {
        this.allHistoryLoaded = true;
      } else {
        if (history.length < limit) {
          this.allHistoryLoaded = true;
        }
        const existingIds = new Set(this.historyRuns.map((r) => r.id));
        const newRuns = history.filter((r) => !existingIds.has(r.id));
        this.historyRuns = [...this.historyRuns, ...newRuns];
        this.renderHistory(this.historyRuns);
      }
    } catch (error) {
      console.error('Failed to load more history:', error);
      this.showToast('Failed to load more history', 'error');
    } finally {
      this.showSkeleton('historySkeleton', false);
    }
  }

  // ── Toast Notification System ──

  showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => toast.remove();
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    // Auto-remove after duration
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  // ── Custom Confirm Modal ──

  showConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('confirmOverlay');
      const textEl = document.getElementById('confirmText');
      const yesBtn = document.getElementById('confirmYes');
      const noBtn = document.getElementById('confirmNo');

      if (!overlay || !textEl || !yesBtn || !noBtn) {
        // Fallback if DOM elements are missing
        resolve(confirm(message));
        return;
      }

      textEl.textContent = message;
      overlay.classList.remove('hidden');

      const cleanup = () => {
        overlay.classList.add('hidden');
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
      };

      const onYes = () => { cleanup(); resolve(true); };
      const onNo = () => { cleanup(); resolve(false); };

      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
    });
  }

  // ── Skeleton Loading States ──

  showSkeleton(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !show);
  }

  // ── Config ──

  async fetchVersion() {
    try {
      const response = await fetch('/api/version');
      const data = await response.json();
      const badge = document.getElementById('versionBadge');
      if (badge) {
        badge.textContent = 'v' + data.version;
        badge.href = data.releaseUrl;
      }
    } catch (error) {
      console.error('Failed to fetch version:', error);
    }
  }

  async fetchConfigStatus() {
    try {
      const response = await fetch('/api/config');
      const config = await response.json();
      this.renderConfigStatus(config);
    } catch (error) {
      console.error('Failed to fetch config status:', error);
      this.renderConfigStatus({ isConfigured: false, paths: [], excludePaths: [] });
    }
  }

  renderConfigStatus(config) {
    // Render path status
    const light = document.getElementById('statusLight');
    const label = document.getElementById('statusLabel');
    const paths = document.getElementById('statusPaths');

    if (config.isConfigured) {
      light.className = 'status-light active';
      label.textContent = 'Watching Folders';
      const pathsList = config.paths.join(', ');
      paths.textContent = pathsList;
      paths.title = pathsList;
    } else {
      light.className = 'status-light inactive';
      label.textContent = 'No Paths Configured';
      paths.textContent = 'Using default: /scan_dir';
    }

    // Render schedule status
    this.renderScheduleStatus(config.schedule);
  }

  renderScheduleStatus(schedule) {
    const scheduleLabel = document.getElementById('scheduleLabel');
    const scheduleTime = document.getElementById('scheduleTime');

    if (schedule && schedule.enabled) {
      scheduleLabel.textContent = 'Next Scheduled Scan';

      if (schedule.nextRun) {
        const nextRunDate = new Date(schedule.nextRun);
        const now = new Date();
        const diff = nextRunDate - now;
        const timeUntil = this.formatTimeUntil(diff);
        scheduleTime.textContent = `${nextRunDate.toLocaleString()} (${timeUntil})`;
        scheduleTime.title = `Schedule: ${schedule.description}`;

        if (this.scheduleUpdateTimer) {
          clearInterval(this.scheduleUpdateTimer);
        }
        this.scheduleUpdateTimer = setInterval(() => {
          this.fetchConfigStatus();
        }, 60000);
      } else {
        scheduleTime.textContent = schedule.description || schedule.cron;
      }
    } else {
      scheduleLabel.textContent = 'Auto-Scan Disabled';
      scheduleTime.textContent = 'Manual runs only';
    }
  }

  formatTimeUntil(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `in ${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      return `in ${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      return 'very soon';
    }
  }

  setupEventHandlers() {
    document.getElementById('startRun').addEventListener('click', () => {
      this.startRun();
    });

    document.getElementById('startCustom').addEventListener('click', () => {
      document.getElementById('customPathModal').classList.remove('hidden');
      document.getElementById('customPaths').value = '';
    });

    document.getElementById('stopRun').addEventListener('click', () => {
      this.stopRun();
    });

    document.getElementById('closeModal').addEventListener('click', () => {
      console.log('Close button clicked');
      document.getElementById('customPathModal').classList.add('hidden');
      document.getElementById('customPaths').value = '';
    });

    document.getElementById('cancelCustom').addEventListener('click', () => {
      document.getElementById('customPathModal').classList.add('hidden');
      document.getElementById('customPaths').value = '';
    });

    document.getElementById('submitCustom').addEventListener('click', () => {
      const paths = document
        .getElementById('customPaths')
        .value.split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      document.getElementById('customPathModal').classList.add('hidden');
      document.getElementById('customPaths').value = '';
      this.startRun(paths);
    });

    // Close modal when clicking outside
    document.getElementById('customPathModal').addEventListener('click', (e) => {
      if (e.target.id === 'customPathModal') {
        document.getElementById('customPathModal').classList.add('hidden');
        document.getElementById('customPaths').value = '';
      }
    });

    // Logs modal handlers
    document.getElementById('closeLogsModal').addEventListener('click', () => {
      document.getElementById('logsModal').classList.add('hidden');
    });

    document.getElementById('closeLogsButton').addEventListener('click', () => {
      document.getElementById('logsModal').classList.add('hidden');
    });

    document.getElementById('copyLogs').addEventListener('click', async () => {
      const logsContent = document.getElementById('logsContent').textContent;
      try {
        await navigator.clipboard.writeText(logsContent);
        const btn = document.getElementById('copyLogs');
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy logs:', err);
        const textArea = document.createElement('textarea');
        textArea.value = logsContent;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand('copy');
          const btn = document.getElementById('copyLogs');
          const originalText = btn.textContent;
          btn.textContent = '✓ Copied!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 2000);
        } catch (execErr) {
          console.error('Fallback copy also failed:', execErr);
          this.showToast('Failed to copy logs to clipboard', 'error');
        }
        document.body.removeChild(textArea);
      }
    });

    // Close logs modal when clicking outside
    document.getElementById('logsModal').addEventListener('click', (e) => {
      if (e.target.id === 'logsModal') {
        document.getElementById('logsModal').classList.add('hidden');
      }
    });

    // Clear completed files
    document.getElementById('clearCompleted').addEventListener('click', () => {
      this.clearCompleted();
    });

    // File list modal handlers
    document.getElementById('closeFileListModal').addEventListener('click', () => {
      document.getElementById('fileListModal').classList.add('hidden');
    });

    document.getElementById('closeFileListButton').addEventListener('click', () => {
      document.getElementById('fileListModal').classList.add('hidden');
    });

    // Close file list modal when clicking outside
    document.getElementById('fileListModal').addEventListener('click', (e) => {
      if (e.target.id === 'fileListModal') {
        document.getElementById('fileListModal').classList.add('hidden');
      }
    });

    // Load more history
    const loadMoreBtn = document.getElementById('loadMoreHistory');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => this.loadMoreHistory());
    }

    // Dark mode toggle
    const darkToggle = document.getElementById('darkModeToggle');
    if (darkToggle) {
      darkToggle.addEventListener('change', (e) => {
        document.documentElement.setAttribute('data-theme', e.target.checked ? 'dark' : 'light');
        localStorage.setItem('subsyncarr-theme', e.target.checked ? 'dark' : 'light');
      });
    }

    // Restore saved theme
    const savedTheme = localStorage.getItem('subsyncarr-theme');
    if (savedTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (darkToggle) darkToggle.checked = true;
    }
  }

  async startRun(paths = null) {
    try {
      const response = await fetch('/api/run/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });

      if (!response.ok) {
        const error = await response.json();
        this.showToast(`Failed to start run: ${error.error}`, 'error');
      } else {
        this.showToast('Run started successfully', 'success');
      }
    } catch (error) {
      this.showToast(`Failed to start run: ${error.message}`, 'error');
    }
  }

  async stopRun() {
    const confirmed = await this.showConfirm('Are you sure you want to stop the current run? All processing will be halted.');
    if (!confirmed) return;

    try {
      const response = await fetch('/api/run/stop', {
        method: 'POST',
      });

      if (!response.ok) {
        const error = await response.json();
        this.showToast(`Failed to stop run: ${error.error}`, 'error');
      } else {
        this.showToast('Run stopped', 'info');
      }
    } catch (error) {
      this.showToast(`Failed to stop run: ${error.message}`, 'error');
    }
  }

  async skipFile(filePath) {
    try {
      await fetch('/api/file/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
    } catch (error) {
      console.error('Failed to skip file:', error);
    }
  }

  async viewLogs(runId) {
    try {
      const response = await fetch(`/api/runs/${runId}/logs`);
      const data = await response.json();

      document.getElementById('logsContent').textContent = data.logs || 'No logs available';
      document.getElementById('logsModal').classList.remove('hidden');
    } catch (error) {
      console.error('Failed to fetch logs:', error);
      this.showToast('Failed to load logs', 'error');
    }
  }

  async clearCompleted() {
    const confirmed = await this.showConfirm('Are you sure you want to clear all completed and skipped files?');
    if (!confirmed) return;

    try {
      const response = await fetch('/api/files/clear', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to clear files');
      }

      this.showToast('Completed files cleared', 'success');
    } catch (error) {
      console.error('Failed to clear files:', error);
      this.showToast('Failed to clear files', 'error');
    }
  }

  render() {
    this.renderProgress();
    this.renderFiles();
    this.updateButtonVisibility();
  }

  updateButtonVisibility() {
    const stopButton = document.getElementById('stopRun');
    const startButton = document.getElementById('startRun');
    const customButton = document.getElementById('startCustom');

    if (this.state.isRunning) {
      stopButton.classList.remove('hidden');
      startButton.classList.add('hidden');
      customButton.classList.add('hidden');
    } else {
      stopButton.classList.add('hidden');
      startButton.classList.remove('hidden');
      customButton.classList.remove('hidden');
    }
  }

  renderProgress() {
    const { currentRun } = this.state;
    const section = document.getElementById('currentRun');

    if (!currentRun || currentRun.status === 'completed') {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');

    const percent = currentRun.total_engines > 0 ? (currentRun.completed_engines / currentRun.total_engines) * 100 : 0;
    document.getElementById('progressFill').style.width = `${percent}%`;
    document.getElementById('progressText').textContent =
      `${currentRun.completed} / ${currentRun.total_files} files (${Math.round(percent)}%)`;
  }

  renderFiles() {
    const processing = this.state.files.filter((f) => f.status === 'processing');
    const completed = this.state.files.filter((f) => ['completed', 'skipped', 'error'].includes(f.status));

    // Render processing files
    const progressHtml = processing
      .map((file) => {
        const engines = JSON.parse(file.engines);
        return `
        <div class="file-card processing">
          <div class="file-header">
            <div class="file-name">${this.basename(file.file_path)}</div>
            <button class="btn-skip" onclick="client.skipFile('${file.file_path.replace(/'/g, "\\'")}')">
              Skip
            </button>
          </div>
          <div class="engine-status">
            ${file.current_engine ? `&#x2699;&#xFE0F; Working on ${file.current_engine}` : 'Starting...'}
          </div>
          ${this.renderEngineResults(engines)}
        </div>
      `;
      })
      .join('');

    document.getElementById('filesInProgress').innerHTML = progressHtml;

    // Render completed files
    const completedHtml = completed
      .map((file) => {
        const engines = JSON.parse(file.engines);
        return `
        <div class="file-card ${file.status}">
          <div class="file-name">${this.basename(file.file_path)}</div>
          ${this.renderEngineResults(engines)}
        </div>
      `;
      })
      .join('');

    document.getElementById('completedList').innerHTML =
      completedHtml || '<p class="no-data">No completed files yet</p>';
  }

  renderEngineResults(engines) {
    return Object.entries(engines)
      .map(([name, result]) => {
        const icon = result.success ? '&#10003;' : '&#10007;';
        const className = result.success ? 'success' : 'error';
        const duration = (result.duration / 1000).toFixed(1);

        return `
        <div class="engine-result ${className}">
          <span>${icon} ${name}</span>
          <span class="duration">${duration}s</span>
        </div>
      `;
      })
      .join('');
  }

  renderEngineCell(engineStats) {
    if (engineStats.pass === 0 && engineStats.fail === 0) {
      return '<td class="engine-cell">-</td>';
    }

    const parts = [];
    if (engineStats.pass > 0) {
      parts.push(`<span class="engine-pass">${engineStats.pass}</span>`);
    }
    if (engineStats.fail > 0) {
      parts.push(`<span class="engine-fail">${engineStats.fail}</span>`);
    }

    return `<td class="engine-cell">${parts.join('/')}</td>`;
  }

  // ── History Table ──

  renderHistory(runs) {
    if (!runs || runs.length === 0) {
      document.getElementById('historyBody').innerHTML =
        '<tr><td colspan="11" class="no-data">No runs yet</td></tr>';
      this.updateLoadMoreVisibility();
      return;
    }

    const html = runs
      .map((run) => {
        const duration = run.end_time ? ((run.end_time - run.start_time) / 1000).toFixed(0) + 's' : 'Running...';
        // Use server-side engine_stats instead of client-side N+1 calculation
        const engineStats = run.engine_stats || {};

        // Make stats clickable if there are files in that category
        const completedCell =
          run.completed > 0
            ? `<span class="stat-clickable stat-completed" onclick="client.showFileList('${run.id}', 'completed')">${run.completed}</span>`
            : run.completed;
        const skippedCell =
          run.skipped > 0
            ? `<span class="stat-clickable stat-skipped" onclick="client.showFileList('${run.id}', 'skipped')">${run.skipped}</span>`
            : run.skipped;
        const failedCell =
          run.failed > 0
            ? `<span class="stat-clickable stat-failed" onclick="client.showFileList('${run.id}', 'failed')">${run.failed}</span>`
            : run.failed;

        return `
        <tr>
          <td>${new Date(run.start_time).toLocaleString()}</td>
          <td><span class="status-badge ${run.status}">${run.status}</span></td>
          <td>${run.total_files}</td>
          <td>${completedCell}</td>
          <td>${skippedCell}</td>
          <td>${failedCell}</td>
          ${this.renderEngineCell(engineStats.ffsubsync || { pass: 0, fail: 0 })}
          ${this.renderEngineCell(engineStats.autosubsync || { pass: 0, fail: 0 })}
          ${this.renderEngineCell(engineStats.alass || { pass: 0, fail: 0 })}
          <td>${duration}</td>
          <td>
            <button class="btn-view-logs" onclick="client.viewLogs('${run.id}')">
              &#x1F4C4; View Logs
            </button>
          </td>
        </tr>
      `;
      })
      .join('');

    document.getElementById('historyBody').innerHTML = html;
    this.updateLoadMoreVisibility();
  }

  updateLoadMoreVisibility() {
    const btn = document.getElementById('loadMoreContainer');
    if (!btn) return;
    btn.classList.toggle('hidden', this.allHistoryLoaded);
  }

  basename(path) {
    return path.split('/').pop();
  }

  // Extract clean movie/show title from filename
  cleanFileName(filePath) {
    let name = filePath.split('/').pop();

    // Remove file extension (.srt, .eng.srt, .eng.sdh.srt, etc.)
    name = name.replace(/\.(eng|spa|fre|ger|ita|por|jpn|kor|chi|rus|ara|hin|pol|dut|swe|nor|dan|fin|tur|heb|tha|vie|ind|msa|hun|ces|slk|ron|bul|ukr|ell|srp|hrv|slv|lit|lav|est|cat|eus|glg|sdh)?\.(srt|sub|ass|ssa|vtt)$/i, '');
    name = name.replace(/\.(srt|sub|ass|ssa|vtt)$/i, '');

    // Try to extract just the title with year
    const titleMatch = name.match(/^(.+?\s*\(\d{4}\))/);
    if (titleMatch) {
      return titleMatch[1].trim();
    }

    // Fallback: remove common metadata patterns
    name = name.replace(/\s*\[.*?\]/g, '');
    name = name.replace(/\s*-[A-Za-z0-9.]+$/, '');
    name = name.replace(/\s+/g, ' ').trim();

    return name || filePath.split('/').pop();
  }

  // Async showFileList — fetches per-run file data on demand (no historyCache needed)
  async showFileList(runId, category) {
    try {
      // Show skeleton in the modal
      const content = document.getElementById('fileListContent');
      content.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
      document.getElementById('fileListTitle').textContent = 'Loading...';
      document.getElementById('fileListModal').classList.remove('hidden');

      const response = await fetch(`/api/runs/${runId}?limit=500`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const files = data.files || [];

      let filteredFiles = [];
      let title = '';

      switch (category) {
        case 'completed':
          filteredFiles = files.filter((f) => f.status === 'completed');
          title = `Completed Files (${filteredFiles.length})`;
          break;
        case 'skipped':
          filteredFiles = files.filter((f) => f.status === 'skipped');
          title = `Skipped Files (${filteredFiles.length})`;
          break;
        case 'failed':
          filteredFiles = files.filter((f) => f.status === 'error');
          title = `Failed Files (${filteredFiles.length})`;
          break;
        default:
          return;
      }

      document.getElementById('fileListTitle').textContent = title;

      if (filteredFiles.length === 0) {
        content.innerHTML = '<div class="file-list-empty">No files in this category</div>';
      } else {
        const html = filteredFiles
          .map((file) => `<div class="file-list-item">${this.cleanFileName(file.file_path)}</div>`)
          .join('');
        content.innerHTML = html;
      }
    } catch (error) {
      console.error('Failed to load file list:', error);
      this.showToast('Failed to load file data', 'error');
      document.getElementById('fileListModal').classList.add('hidden');
    }
  }
}

// Initialize client when DOM is ready
let client;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    client = new SubsyncarrPlusClient();
  });
} else {
  client = new SubsyncarrPlusClient();
}
