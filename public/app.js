class SubsyncarrPlusClient {
  constructor() {
    this.ws = null;
    this.state = { currentRun: null, files: [], isRunning: false, scanProgress: null, avgTimePerFile: 0, fileTimestamps: [], dryRun: false }; this._scanPoll = null;
    this.historyCache = {};
    this.initialized = false;
    this.activePage = 'dashboard';
    this.config = null;
    this.folderPath = null;  // current folder drill-down path
    this.initTheme();
    this.initWebSocket();
    this.setupEvents();
    this.fetchInitialState();
    this.fetchConfig();
    this.fetchVersion();
    this.fetchStats(); // dashboard is the default page — populate it immediately, not after the 15s interval
  }
  initTheme() {
    var saved = localStorage.getItem('subsyncarr-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    this.updateThemeButton();
  }
  toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('subsyncarr-theme', next);
    this.updateThemeButton();
  }
  updateThemeButton() {
    var btn = document.getElementById('themeToggle');
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = isDark ? '\u2600\uFE0F Light' : '\uD83C\uDF19 Dark';
  }
  navigate(page) {
    this.activePage = page;
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    var target = document.querySelector('[data-page="' + page + '"]');
    if (target) target.classList.add('active');
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    document.getElementById('page-' + page).classList.add('active');
    if (page === 'folders') this.fetchFolders();
    if (page === 'settings') this.fetchSettings();
    if (page === 'dashboard') { this.fetchStats(); this.fetchConfig(); }
    if (page === 'run' && this.state.isRunning) { this.fetchRunFiles(); }
  }
  initWebSocket() {
    var self = this;
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(protocol + '//' + location.host + '/ws');
    this.ws.onopen = function() {};
    this.ws.onmessage = function(event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'batch' && Array.isArray(msg.messages)) {
        msg.messages.forEach(function(m) { self.handleMessage(m); });
        self.render();
      } else { self.handleMessage(msg); }
    };
    this.ws.onclose = function() { setTimeout(function() { self.initWebSocket(); }, 3000); };
  }
  handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        this.state.currentRun = msg.data.currentRun || this.state.currentRun;
        this.state.isRunning = msg.data.isRunning !== undefined ? msg.data.isRunning : this.state.isRunning;
        this.state.scanProgress = msg.data.scanProgress || null;
        if (msg.data.dryRun !== undefined) this.state.dryRun = msg.data.dryRun;
        if (!this.initialized) this.fetchInitialState(); else this.render();
        break;
      case 'run:started':
        this.state.currentRun = msg.data; this.state.isRunning = true; this.state.files = [];
        this.navigate('run'); this.render();
        break;
      case 'run:completed': case 'run:cancelled':
        this.state.currentRun = msg.data; this.state.isRunning = false;
        this.render(); this.fetchHistory();
        // Refresh dashboard media stats now instead of waiting for the next
        // 15s poll — otherwise the stat cards keep showing mid-run numbers
        // for up to that long after the run actually finished.
        if (this.activePage === 'dashboard') this.fetchStats();
        break;
      case 'file:updated':
        if (msg.data.run) this.state.currentRun = msg.data.run;
        // Track recent file completion times for ETA
        var now = Date.now();
        this.state.fileTimestamps.push(now);
        if (this.state.fileTimestamps.length > 20) this.state.fileTimestamps.shift();
        if (this.state.fileTimestamps.length >= 2) {
          this.state.avgTimePerFile = (now - this.state.fileTimestamps[0]) / this.state.fileTimestamps.length;
        }
        this.render();
        break;
      case 'files:cleared':
        this.state.currentRun = msg.data.currentRun; this.state.files = msg.data.files;
        this.render();
        break;
    }
  }
  async fetchInitialState() {
    var r = await fetch('/api/status?brief=true'); var d = await r.json();
    this.state.currentRun = d.currentRun; this.state.isRunning = d.isRunning;
    this.state.files = d.files || []; this.state.scanProgress = d.scanProgress;
    if (d.dryRun !== undefined) this.state.dryRun = d.dryRun;
    this.initialized = true; this.render(); this.fetchHistory();
  }
  async fetchRunFiles() {
    if (!this.state.currentRun) return;
    try {
      var r = await fetch('/api/status?limit=200');
      var d = await r.json();
      this.state.files = d.files || [];
      this.render();
    } catch(e) {}
  }
  async fetchHistory() {
    var r = await fetch('/api/history'); var data = await r.json();
    var self = this; data.forEach(function(run) { self.historyCache[run.id] = run; });
    this.renderHistory(data);
  }
  async fetchConfig() {
    try { var r = await fetch('/api/config'); this.config = await r.json(); this.renderConfig(); }
    catch(e) { this.config = { isConfigured: false, paths: [], excludePaths: [], schedule: null }; this.renderConfig(); }
  }
  async fetchVersion() {
    try { var r = await fetch('/api/version'); var d = await r.json();
      document.getElementById('versionText').textContent = 'v' + d.version;
      document.getElementById('releaseLink').href = d.releaseUrl; } catch(e) {}
  }
  async fetchStats() { try { var r = await fetch('/api/stats'); this.renderStats(await r.json()); } catch(e) {} }
  async fetchFolders(parent) {
    try {
      var url = '/api/folders';
      if (parent) url += '?parent=' + encodeURIComponent(parent);
      var r = await fetch(url);
      this.renderFolders(await r.json(), parent);
    } catch(e) {}
  }
  renderConfig() {
    var c = this.config;
    var dot = document.getElementById('dashStatusDot');
    var txt = document.getElementById('dashStatusText');
    var sch = document.getElementById('dashSchedule');
    var sidebar = document.getElementById('sidebarStatus');
    if (c && c.isConfigured) {
      dot.className = 'status-dot'; if (this.state.isRunning) dot.classList.add('running');
      txt.textContent = 'Watching: ' + c.paths.join(', '); sidebar.textContent = 'Active'; sidebar.className = 'status-indicator active';
    } else {
      dot.className = 'status-dot off'; txt.textContent = 'No paths configured'; sidebar.textContent = 'Idle'; sidebar.className = 'status-indicator idle';
    }
    if (c && c.schedule && c.schedule.enabled) {
      sch.textContent = c.schedule.nextRun ? 'Next: ' + new Date(c.schedule.nextRun).toLocaleTimeString() : (c.schedule.description || c.schedule.cron || 'Scheduled');
    } else { sch.textContent = 'Manual only'; }
  }
  renderStats(stats) {
    if (!stats) return;
    var banner = document.getElementById('scanBanner');
    var sp = this.state.scanProgress;
    if (sp && sp.total > 0) {
      banner.classList.remove('hidden');
      document.getElementById('scanProgressFill').style.width = Math.round((sp.checked/sp.total)*100) + '%';
      document.getElementById('scanChecked').textContent = sp.checked.toLocaleString() + ' / ' + sp.total.toLocaleString() + ' checked';
      document.getElementById('scanNeedSync').textContent = sp.needSync.toLocaleString() + ' need sync';
      document.getElementById('scanAlready').textContent = sp.alreadySynced.toLocaleString() + ' already synced';
    } else { banner.classList.add('hidden'); }
    document.getElementById('statsGrid').innerHTML =
      '<div class="stat-card accent"><div class="label">Total Tracked</div><div class="value">' + stats.totalFiles.toLocaleString() + '</div></div>' +
      '<div class="stat-card success"><div class="label">Synced</div><div class="value">' + stats.syncedFiles.toLocaleString() + '</div><div class="sub">' + stats.syncRate + '% complete</div><div class="mini-progress"><div class="mini-progress-fill" style="width:' + stats.syncRate + '%"></div></div></div>' +
      '<div class="stat-card warning"><div class="label">Skipped</div><div class="value">' + stats.skippedFiles.toLocaleString() + '</div></div>' +
      '<div class="stat-card"><div class="label">Pending</div><div class="value">' + (stats.totalFiles - stats.syncedFiles - stats.skippedFiles).toLocaleString() + '</div></div>';
    var engHtml = (stats.engines || []).map(function(e) {
      return '<div class="stat-card success"><div class="label">' + e.engine + '</div><div class="value">' + e.synced.toLocaleString() + '</div><div class="sub">' + e.rate + '% synced - ' + e.total.toLocaleString() + ' total</div><div class="mini-progress"><div class="mini-progress-fill" style="width:' + e.rate + '%"></div></div></div>';
    }).join('');
    document.getElementById('engineCards').innerHTML = engHtml;
    var langHtml = (stats.languages || []).map(function(l) {
      var label = l.name || (l.lang ? l.lang.toUpperCase() : '?');
      return '<div class="lang-chip"><div class="lang-code">' + label + '</div><div class="lang-count">' + l.count.toLocaleString() + '</div></div>';
    }).join('');
    document.getElementById('langGrid').innerHTML = langHtml || '<p class="text-muted">No language data</p>';
  }
  renderRun() {
    var run = this.state.currentRun;
    var container = document.getElementById('runContent');
    // No run at all
    if (!run) {
      container.innerHTML = '<p class="text-muted text-sm">No run in progress.</p>';
      document.getElementById('runStatusBadge').textContent = 'IDLE';
      document.getElementById('runStatusBadge').className = 'status-badge'; return;
    }
    // Scanning phase: run exists but total_files hasn't been populated yet
    if (run.total_files === 0) {
      var sp = this.state.scanProgress;
      if (sp && sp.total > 0) {
        var pct = Math.round((sp.checked / sp.total) * 100);
        container.innerHTML = '<div class="run-progress"><div class="run-stats-row"><span>Scanning files: ' + sp.checked.toLocaleString() + ' / ' + sp.total.toLocaleString() + '</span></div><div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div><div class="scan-stats" style="margin-top:8px"><span>' + sp.checked.toLocaleString() + ' checked</span><span>' + sp.needSync.toLocaleString() + ' need sync</span><span>' + sp.alreadySynced.toLocaleString() + ' synced</span></div></div>';
      } else {
        container.innerHTML = '<div class="run-progress"><div class="run-stats-row"><span>Starting scan...</span></div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div><div class="text-sm text-muted">Waiting for file list...</div></div>';
      }
      document.getElementById('runStatusBadge').textContent = 'SCANNING';
      document.getElementById('runStatusBadge').className = 'status-badge running';
      this._startScanPoll();
      return;
    }
    this._stopScanPoll();
    var pct = run.total_engines > 0 ? Math.round((run.completed_engines / run.total_engines) * 100) : 0;
    document.getElementById('runStatusBadge').textContent = run.status === 'running' ? 'RUNNING' : run.status.toUpperCase();
    document.getElementById('runStatusBadge').className = 'status-badge ' + run.status;
    var self = this;
    var searchQ = document.getElementById("runSearch");
    var showFiles = searchQ ? self._filterFiles(self.state.files, searchQ.value) : self.state.files;
    var processing = showFiles.filter(function(f) { return f.status === "processing"; });
    var done = showFiles.filter(function(f) { return ["completed","skipped","error","not_fitting"].indexOf(f.status) >= 0; });
    function fileCards(arr, showSkip) {
      return arr.map(function(f) {
        var engines = {}; try { engines = JSON.parse(f.engines); } catch(e) {}
        var badges = Object.entries(engines).map(function(e) {
          var name = e[0], r = e[1];
          var cls = r.success ? 'pass' : (r.skipped ? 'skip' : 'fail');
          var label = r.success ? 'OK' : (r.skipped ? 'SK' : 'FAIL');
          var dur = r.duration ? ' ' + (r.duration/1000).toFixed(1) + 's' : '';
          return '<span class="engine-badge ' + cls + '">' + label + ' ' + name + dur + '</span>';
        }).join('');
        var statusLabel = f.status === 'not_fitting' ? 'NF' : f.status === 'error' ? 'FAIL' : f.status === 'skipped' ? 'SK' : 'OK';
        var skipBtn = showSkip ? '<button class="btn btn-sm btn-danger" onclick="client.skipFile(\'' + f.file_path.replace(/'/g,'\\\'') + '\')">Skip</button>' : '';
        return '<div class="file-card ' + f.status + '"><div class="file-header"><div class="file-name"><span class="status-tag ' + f.status + '">' + statusLabel + '</span> ' + f.file_path.split('/').pop() + '</div>' + skipBtn + '</div><div class="engine-badges">' + badges + '</div></div>';
      }).join('');
    }
    // Show filters
    var filterEl = document.getElementById('runFilters');
    if (filterEl) filterEl.style.display = run.status === 'running' ? 'flex' : 'none';
    // Update ETA
    var etaEl = document.getElementById('etaText');
    if (etaEl && self.state.avgTimePerFile > 0 && run.total_files) {
      var remaining = run.total_files - (run.completed+run.skipped+run.failed+run.not_fitting);
      etaEl.textContent = 'ETA: ' + self._formatETA(remaining * self.state.avgTimePerFile / 6);
      etaEl.className = 'eta-text ' + (remaining * self.state.avgTimePerFile / 1000 > 3600 ? 'slow' : 'fast');
    }
    container.innerHTML =
      '<div class="run-progress"><div class="run-stats-row"><span>OK ' + (run.completed||0) + '</span><span>SK ' + (run.skipped||0) + '</span><span>FAIL ' + (run.failed||0) + '</span><span>NF ' + (run.not_fitting||0) + '</span><span>Total: ' + (run.total_files||0).toLocaleString() + '</span></div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="text-sm text-muted">' + (run.completed_engines||0) + ' / ' + (run.total_engines||0) + ' engines (' + pct + '%)</div></div>' +
      '<h4>Processing (' + processing.length + ')</h4>' + (fileCards(processing, true) || '<p class="text-muted text-sm">None</p>') +
      '<h4 style="margin-top:20px">Completed (' + done.length + ')</h4>' + (fileCards(done, false) || '<p class="text-muted text-sm">None</p>');
  }
  renderHistory(runs) {
    var self = this;
    // Hide empty runs (0 files, nothing processed) — accidental/no-op starts that just clutter history
    runs = (runs || []).filter(function(run) {
      return (run.total_files || 0) > 0 || (run.completed + run.skipped + run.failed + (run.not_fitting||0)) > 0;
    });
    var html = runs.map(function(run) {
      var dur = run.end_time ? Math.round((run.end_time - run.start_time)/1000) + 's' : '-';
      var stats = { ffsubsync:{pass:0,fail:0}, autosubsync:{pass:0,fail:0}, alass:{pass:0,fail:0} };
      try {
        var es = JSON.parse(run.engine_stats || '{}');
        Object.keys(stats).forEach(function(k) {
          if (es[k]) { stats[k].pass = es[k].pass || 0; stats[k].fail = es[k].fail || 0; }
        });
      } catch(er) {}
      function engCell(s) {
        if (s.pass + s.fail === 0) return '<td>-</td>';
        return '<td>' + (s.pass>0?'<span style="color:#10b981">'+s.pass+'</span>':'') + (s.pass>0&&s.fail>0?'/':'') + (s.fail>0?'<span style="color:#ef4444">'+s.fail+'</span>':'') + '</td>';
      }
      function click(n, cat) { return n>0 ? '<span class="stat-clickable" onclick="client.showFileList(\''+run.id+'\',\''+cat+'\')">'+n+'</span>' : n; }
      return '<tr><td>' + new Date(run.start_time).toLocaleString() + '</td>' +
        '<td><span class="status-badge ' + run.status + '">' + run.status + '</span></td>' +
        '<td>' + (run.total_files||0).toLocaleString() + '</td>' +
        '<td>' + click(run.completed,'completed') + '</td>' +
        '<td>' + click(run.skipped,'skipped') + '</td>' +
        '<td>' + click(run.failed,'failed') + '</td>' +
        '<td>' + click(run.not_fitting||0,'not_fitting') + '</td>' +
        engCell(stats.ffsubsync) + engCell(stats.autosubsync) + engCell(stats.alass) +
        '<td>' + dur + '</td>' +
        '<td><button class="btn btn-sm btn-secondary" onclick="client.viewLogs(\''+run.id+'\')">Logs</button></td></tr>';
    }).join('');
    document.getElementById('historyBody').innerHTML = html || '<tr><td colspan="12" class="text-muted">No runs yet</td></tr>';
  }
  renderFolders(folders, parent) {
    var self = this;
    var container = document.getElementById('folderList');
    if (!folders || folders.length === 0) {
      container.innerHTML = '<p class="text-muted">No folder data yet.</p>';
      return;
    }
    // Breadcrumb
    var breadcrumb = '';
    if (parent) {
      var parts = parent.split('/').filter(function(p) { return p; });
      var path = '';
      breadcrumb = '<div class="folder-breadcrumb"><span class="breadcrumb-item" onclick="client.navigateFolder(null)">Root</span>';
      for (var i = 0; i < parts.length; i++) {
        path += '/' + parts[i];
        breadcrumb += ' <span class="breadcrumb-sep">/</span> <span class="breadcrumb-item" data-folder="' + path + '">' + parts[i] + '</span>';
      }
      breadcrumb += '</div>';
    }
    container.innerHTML = breadcrumb + folders.map(function(f) {
      var clickable = f.hasChildren ? ' class="folder-clickable" data-folder="' + f.fullPath + '"' : '';
      return '<div class="folder-row"' + clickable + '><span class="folder-icon"></span><span class="folder-name">' + f.name + '</span><div class="folder-bar"><div class="folder-bar-fill" style="width:' + f.progress + '%"></div></div><div class="folder-numbers"><span>OK ' + f.synced.toLocaleString() + '</span><span>Pend ' + f.pending.toLocaleString() + '</span></div></div>';
    }).join('');
  }
  navigateFolder(path) {
    this.folderPath = path;
    this.fetchFolders(path);
  }
  render() {
    this.renderConfig();
    if (this.activePage === 'dashboard' || this.activePage === 'run') this.renderRun();
    this.updateButtons();
    this.updateNavVisibility();
  }
  updateButtons() {
    var stop = document.getElementById('stopRun'), start = document.getElementById('startRun'), custom = document.getElementById('startCustom'), dry = document.getElementById('dryRun');
    if (this.state.isRunning) { stop.classList.remove('hidden'); start.classList.add('hidden'); custom.classList.add('hidden'); if (dry) dry.classList.add('hidden'); }
    else { stop.classList.add('hidden'); start.classList.remove('hidden'); custom.classList.remove('hidden'); if (dry) dry.classList.remove('hidden'); }
    var badge = document.getElementById('dryRunBadge');
    if (badge) badge.classList.toggle('hidden', !(this.state.isRunning && this.state.dryRun));
  }
  updateNavVisibility() {
    var navRun = document.getElementById('navRun');
    if (this.state.isRunning) {
      navRun.classList.remove('hidden');
    } else {
      navRun.classList.add('hidden');
      if (this.activePage === 'run') this.navigate('dashboard');
    }
  }
  async startRun(paths, dryRun) {
    try {
      var payload = {};
      if (paths && paths.length > 0) payload.paths = paths;
      if (dryRun) payload.dryRun = true;
      this.state.dryRun = !!dryRun;
      // Show placeholder immediately — server creates run before scanning
      // and WebSocket run:started fires with real data
      this.state.isRunning = true;
      this.state.currentRun = { status: 'running', total_files: 0, completed: 0, skipped: 0, failed: 0, not_fitting: 0, total_engines: 0, completed_engines: 0, start_time: Date.now(), id: 'pending' };
      this.navigate('run');
      this.render();
      await fetch('/api/run/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    } catch(e) { alert('Failed: ' + e.message); }
  }
  async stopRun() { if (!confirm('Stop run?')) return; try { await fetch('/api/run/stop', { method:'POST' }); } catch(e) {} }
  async skipFile(fp) { try { await fetch('/api/file/skip', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({filePath:fp}) }); } catch(e) {} }
  async viewLogs(runId) {
    var r = await fetch('/api/runs/' + runId + '/logs'); var d = await r.json();
    document.getElementById('logsContent').textContent = d.logs || 'No logs';
    document.getElementById('logsModal').classList.remove('hidden');
  }
  _filterHistory(runs, query) {
    if (!query) return runs;
    var q = query.toLowerCase();
    return runs.filter(function(r) {
      return new Date(r.start_time).toLocaleString().toLowerCase().indexOf(q) >= 0 ||
        r.status.toLowerCase().indexOf(q) >= 0 ||
        String(r.total_files||0).indexOf(q) >= 0;
    });
  }
  async showFileList(runId, cat) {
    var map = { completed: 'completed', skipped: 'skipped', failed: 'error', not_fitting: 'not_fitting' };
    try {
      var r = await fetch('/api/runs/' + runId + '/files?status=' + map[cat]);
      var d = await r.json();
      document.getElementById('fileListTitle').textContent = cat + ' (' + d.total + ')';
      document.getElementById('fileListContent').innerHTML = d.files.length === 0 ? '<p class="text-muted">None</p>' : d.files.map(function(f) { return '<div style="padding:4px 0;font-size:13px;border-bottom:1px solid var(--border);cursor:pointer" data-file="' + f.file_path + '">' + f.file_path.split('/').pop() + '</div>'; }).join('');
      document.getElementById('fileListModal').classList.remove('hidden');
    } catch(e) {}
  }
  async fetchSettings() {
    try {
      var r = await fetch('/api/settings'); var s = await r.json();
      document.getElementById('setMaxShift').value = s.maxSubtitleShiftMs;
      document.getElementById('setAgreementThreshold').value = s.engineAgreementThresholdMs || 5000;
      document.getElementById('setNotFittingThreshold').value = s.notFittingDeleteThreshold || 3;
      document.getElementById('setRetryThreshold').value = s.syncRetryThresholdMs;
      document.getElementById('setMaxRetries').value = s.syncMaxRetries;
      document.getElementById('setDefaultEngine').value = s.defaultEngine || 'alass';
      document.getElementById('setFallbackEngine').value = s.fallbackEngine || 'ffsubsync';
      document.getElementById('setDryRun').checked = s.dryRun;
      document.getElementById('setAlassTimeout').value = (s.engineTimeouts && s.engineTimeouts.alass) || 300000;
      document.getElementById('setFfsubsyncTimeout').value = (s.engineTimeouts && s.engineTimeouts.ffsubsync) || 300000;
      document.getElementById('setAutosubsyncTimeout').value = (s.engineTimeouts && s.engineTimeouts.autosubsync) || 300000;
      document.getElementById('setMaxWorkers').value = s.maxConcurrentTasks || 1;
      document.getElementById('setTheme').value = s.theme;
      document.getElementById('setCron').value = s.cronSchedule;
      document.getElementById('setEngines').value = s.includeEngines;
    } catch(e) {}
  }
  async saveSettings() {
    var data = {
      max_subtitle_shift_ms: document.getElementById('setMaxShift').value,
      sync_retry_threshold_ms: document.getElementById('setRetryThreshold').value,
      sync_max_retries: document.getElementById('setMaxRetries').value,
      default_engine: document.getElementById('setDefaultEngine').value,
      fallback_engine: document.getElementById('setFallbackEngine').value,
      dry_run: document.getElementById('setDryRun').checked ? 'true' : 'false',
      engine_timeout_alass: document.getElementById('setAlassTimeout').value,
      engine_timeout_ffsubsync: document.getElementById('setFfsubsyncTimeout').value,
      engine_timeout_autosubsync: document.getElementById('setAutosubsyncTimeout').value,
      max_concurrent_tasks: document.getElementById('setMaxWorkers').value,
      engine_agreement_threshold_ms: document.getElementById('setAgreementThreshold').value,
      not_fitting_delete_threshold: document.getElementById('setNotFittingThreshold').value,
      theme: document.getElementById('setTheme').value,
    };
    try {
      await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
      var el = document.getElementById('settingsSaved'); el.classList.remove('hidden');
      setTimeout(function(){ el.classList.add('hidden'); }, 2000);
      if (data.theme !== document.documentElement.getAttribute('data-theme')) {
        document.documentElement.setAttribute('data-theme', data.theme);
        localStorage.setItem('subsyncarr-theme', data.theme);
        this.updateThemeButton();
      }
    } catch(e) { alert('Failed to save: ' + e.message); }
  }
  async viewMediaDetail(filePath) {
    try {
      var r = await fetch('/api/media/' + encodeURIComponent(filePath));
      var d = await r.json();
      var html = '<div class="media-detail-section"><h4>File</h4><p class="media-path">' + d.filePath + '</p></div>';

      // Failure tracking
      if (d.failureTracking && d.failureTracking.length > 0) {
        html += '<div class="media-detail-section"><h4>Engine Status</h4>';
        html += d.failureTracking.map(function(ft) {
          var status = ft.last_success_time ? '<span class="status-badge completed">OK</span>' : (ft.is_skipped ? '<span class="status-badge cancelled">SKIPPED</span>' : '<span class="status-badge running">PENDING</span>');
          var lastSuccess = ft.last_success_time ? new Date(ft.last_success_time).toLocaleString() : 'Never';
          var lastFailure = ft.last_failure_time ? new Date(ft.last_failure_time).toLocaleString() : 'Never';
          return '<div class="engine-detail-row"><span class="engine-name">' + ft.engine + '</span> ' + status +
            '<div class="engine-detail-meta">Failures: ' + ft.consecutive_failures + ' | Last OK: ' + lastSuccess + ' | Last Fail: ' + lastFailure + '</div></div>';
        }).join('');
        html += '</div>';
      }

      // Sync history
      if (d.syncHistory && d.syncHistory.length > 0) {
        html += '<div class="media-detail-section"><h4>Sync History</h4>';
        html += '<div class="sync-timeline">';
        html += d.syncHistory.map(function(sh) {
          var date = new Date(sh.runStartTime).toLocaleString();
          var statusCls = sh.fileStatus === 'completed' ? 'completed' : sh.fileStatus === 'error' ? 'error' : sh.fileStatus;
          var engineDetails = Object.entries(sh.engines).map(function(e) {
            var name = e[0], r = e[1];
            var offset = r.offsetMs !== undefined ? ' (offset: ' + r.offsetMs + 'ms)' : '';
            var dur = r.duration ? ' ' + (r.duration/1000).toFixed(1) + 's' : '';
            var cls = r.success ? 'pass' : 'fail';
            return '<span class="engine-badge ' + cls + '">' + name + ': ' + (r.success ? 'OK' : 'FAIL') + offset + dur + '</span>';
          }).join(' ');
          return '<div class="timeline-entry"><div class="timeline-date">' + date + '</div><div class="timeline-status"><span class="status-badge ' + statusCls + '">' + sh.fileStatus + '</span></div><div class="timeline-engines">' + engineDetails + '</div></div>';
        }).join('');
        html += '</div></div>';
      }

      // Waveform placeholder (visual representation of sync offsets)
      if (d.syncHistory && d.syncHistory.length > 0) {
        html += '<div class="media-detail-section"><h4>Offset Visualization</h4>';
        html += '<div class="offset-chart">';
        var offsets = [];
        d.syncHistory.forEach(function(sh) {
          Object.entries(sh.engines).forEach(function(e) {
            if (e[1].offsetMs !== undefined) offsets.push({ engine: e[0], offset: e[1].offsetMs, date: new Date(sh.runStartTime).toLocaleDateString() });
          });
        });
        if (offsets.length > 0) {
          var maxAbs = Math.max.apply(null, offsets.map(function(o) { return Math.abs(o.offset); }));
          html += offsets.map(function(o) {
            var pct = maxAbs > 0 ? Math.min(100, Math.abs(o.offset) / maxAbs * 100) : 0;
            var dir = o.offset >= 0 ? 'right' : 'left';
            var color = Math.abs(o.offset) > 30000 ? 'var(--error)' : Math.abs(o.offset) > 5000 ? 'var(--warning)' : 'var(--success)';
            return '<div class="offset-bar-row"><span class="offset-label">' + o.engine + ' ' + o.date + '</span><div class="offset-bar-track"><div class="offset-bar ' + dir + '" style="width:' + pct + '%;background:' + color + '"></div></div><span class="offset-value">' + (o.offset/1000).toFixed(1) + 's</span></div>';
          }).join('');
        } else {
          html += '<p class="text-muted">No offset data available</p>';
        }
        html += '</div></div>';
      }

      document.getElementById('mediaDetailTitle').textContent = d.filePath.split('/').pop();
      document.getElementById('mediaDetailContent').innerHTML = html || '<p class="text-muted">No data</p>';
      document.getElementById('mediaDetailModal').classList.remove('hidden');
    } catch(e) { alert('Failed to load: ' + e.message); }
  }
  _formatETA(ms) {
    if (ms < 60000) return Math.round(ms/1000) + 's';
    if (ms < 3600000) return Math.round(ms/60000) + 'm';
    return (ms/3600000).toFixed(1) + 'h';
  }
  _filterFiles(files, query) {
    if (!query) return files;
    var q = query.toLowerCase();
    return files.filter(function(f) {
      var name = f.file_path.split('/').pop().toLowerCase();
      return name.indexOf(q) >= 0 || f.status.indexOf(q) >= 0;
    });
  }
  toggleSidebar() {
    var sb = document.getElementById('sidebar');
    var ov = document.getElementById('sidebarOverlay');
    sb.classList.toggle('open');
    if (ov) ov.classList.toggle('show');
  }
  _startScanPoll() {
    if (this._scanPoll) return;
    var self = this;
    this._scanPoll = setInterval(function() {
      if (!self.state.isRunning || !self.state.currentRun || self.state.currentRun.total_files > 0) {
        self._stopScanPoll();
        return;
      }
      fetch('/api/status?brief=true').then(function(r) { return r.json(); }).then(function(d) {
        if (d.scanProgress) {
          self.state.scanProgress = d.scanProgress;
          self.renderRun();
        }
      }).catch(function() {});
    }, 500);
  }
  _stopScanPoll() {
    if (this._scanPoll) { clearInterval(this._scanPoll); this._scanPoll = null; }
  }
  setupEvents() {
    var self = this;
    document.getElementById('themeToggle').addEventListener('click', function() { self.toggleTheme(); });
    document.querySelectorAll('.nav-item').forEach(function(btn) { btn.addEventListener('click', function() { self.navigate(btn.dataset.page); }); });
    document.getElementById('startRun').addEventListener('click', function() { self.startRun(null); });
    document.getElementById('startCustom').addEventListener('click', function() { document.getElementById('customPathModal').classList.remove('hidden'); });
    var dryBtn = document.getElementById('dryRun');
    if (dryBtn) dryBtn.addEventListener('click', function() { if (confirm('Start a dry run? Engines will run but no files are written or deleted.')) self.startRun(null, true); });
    document.getElementById('stopRun').addEventListener('click', function() { self.stopRun(); });
    document.getElementById('closeModal').addEventListener('click', function() { document.getElementById('customPathModal').classList.add('hidden'); });
    document.getElementById('cancelCustom').addEventListener('click', function() { document.getElementById('customPathModal').classList.add('hidden'); });
    document.getElementById('submitCustom').addEventListener('click', function() {
      var paths = document.getElementById('customPaths').value.split('\\n').map(function(p){return p.trim()}).filter(function(p){return p;});
      var dryEl = document.getElementById('customDryRun');
      var dry = dryEl ? dryEl.checked : false;
      document.getElementById('customPathModal').classList.add('hidden'); document.getElementById('customPaths').value = ''; if (dryEl) dryEl.checked = false; self.startRun(paths, dry);
    });
    document.getElementById('closeLogsModal').addEventListener('click', function() { document.getElementById('logsModal').classList.add('hidden'); });
    document.getElementById('closeLogsButton').addEventListener('click', function() { document.getElementById('logsModal').classList.add('hidden'); });
    document.getElementById('copyLogs').addEventListener('click', function() {
      navigator.clipboard.writeText(document.getElementById('logsContent').textContent);
      var btn = document.getElementById('copyLogs'); btn.textContent = 'Copied!'; setTimeout(function(){btn.textContent='Copy'},2000);
    });
    document.getElementById('closeFileListModal').addEventListener('click', function() { document.getElementById('fileListModal').classList.add('hidden'); });
    document.getElementById('closeFileListButton').addEventListener('click', function() { document.getElementById('fileListModal').classList.add('hidden'); });
    ['customPathModal','logsModal','fileListModal'].forEach(function(id) {
      document.getElementById(id).addEventListener('click', function(e) { if (e.target.id === id) document.getElementById(id).classList.add('hidden'); });
    });
    document.getElementById('saveSettings').addEventListener('click', function() { self.saveSettings(); });
    document.getElementById('closeMediaDetailModal').addEventListener('click', function() { document.getElementById('mediaDetailModal').classList.add('hidden'); });
    document.getElementById('closeMediaDetailButton').addEventListener('click', function() { document.getElementById('mediaDetailModal').classList.add('hidden'); });
    document.getElementById('mediaDetailModal').addEventListener('click', function(e) { if (e.target.id === 'mediaDetailModal') document.getElementById('mediaDetailModal').classList.add('hidden'); });
    // Delegated click handlers for dynamically created elements
    document.getElementById('folderList').addEventListener('click', function(e) {
      var el = e.target.closest('[data-folder]');
      if (el) { self.navigateFolder(el.getAttribute('data-folder')); }
    });
    document.getElementById('fileListContent').addEventListener('click', function(e) {
      var el = e.target.closest('[data-file]');
      if (el) { self.viewMediaDetail(el.getAttribute('data-file')); }
    });
    // Mobile sidebar toggle
    document.getElementById('hamburgerBtn').addEventListener('click', function() { self.toggleSidebar(); });
    // Search inputs
    document.getElementById('runSearch').addEventListener('input', function() { self.render(); });
    // Sidebar overlay click-to-close
    var overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.addEventListener('click', function() { self.toggleSidebar(); });
    // History search
    var historySearch = document.getElementById('historySearch');
    if (historySearch) historySearch.addEventListener('input', function() {
      var runs = Object.values(self.historyCache).sort(function(a,b){ return b.start_time - a.start_time; });
      self.renderHistory(self._filterHistory(runs, this.value));
    });
    setInterval(function() { if (self.activePage === 'dashboard') self.fetchStats(); }, 15000);
  }
}
var client;
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function() { client = new SubsyncarrPlusClient(); }); }
else { client = new SubsyncarrPlusClient(); }