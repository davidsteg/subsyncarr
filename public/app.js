class SubsyncarrPlusClient {
  constructor() {
    this.ws = null;
    this.state = { currentRun: null, files: [], isRunning: false, scanProgress: null };
    this.historyCache = {};
    this.initialized = false;
    this.activePage = 'dashboard';
    this.config = null;
    this.initTheme();
    this.initWebSocket();
    this.setupEvents();
    this.fetchInitialState();
    this.fetchConfig();
    this.fetchVersion();
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
    document.querySelector('[data-page="' + page + '"]').classList.add('active');
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    document.getElementById('page-' + page).classList.add('active');
    if (page === 'folders') this.fetchFolders();
    if (page === 'dashboard') { this.fetchStats(); this.fetchConfig(); }
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
        if (!this.initialized) this.fetchInitialState(); else this.render();
        break;
      case 'run:started':
        this.state.currentRun = msg.data; this.state.isRunning = true; this.state.files = [];
        this.navigate('run'); this.render();
        break;
      case 'run:completed': case 'run:cancelled':
        this.state.currentRun = msg.data; this.state.isRunning = false;
        this.render(); this.fetchHistory();
        break;
      case 'file:updated':
        if (msg.data.run) this.state.currentRun = msg.data.run;
        break;
      case 'files:cleared':
        this.state.currentRun = msg.data.currentRun; this.state.files = msg.data.files;
        this.render();
        break;
    }
  }
  async fetchInitialState() {
    var r = await fetch('/api/status'); var d = await r.json();
    this.state.currentRun = d.currentRun; this.state.isRunning = d.isRunning;
    this.state.files = d.files || []; this.state.scanProgress = d.scanProgress;
    this.initialized = true; this.render(); this.fetchHistory();
  }
  async fetchHistory() {
    var r = await fetch('/api/history?include_files=true'); var data = await r.json();
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
  async fetchFolders() { try { var r = await fetch('/api/folders'); this.renderFolders(await r.json()); } catch(e) {} }
  renderConfig() {
    var c = this.config;
    var dot = document.getElementById('dashStatusDot');
    var txt = document.getElementById('dashStatusText');
    var sch = document.getElementById('dashSchedule');
    var sidebar = document.getElementById('sidebarStatus');
    if (c && c.isConfigured) {
      dot.className = 'status-dot'; if (this.state.isRunning) dot.classList.add('running');
      txt.textContent = 'Watching: ' + c.paths.join(', '); sidebar.textContent = '\u25CF Active';
    } else {
      dot.className = 'status-dot off'; txt.textContent = 'No paths configured'; sidebar.textContent = '\u25CB Idle';
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
      return '<div class="lang-chip"><div class="lang-code">' + l.lang.toUpperCase() + '</div><div class="lang-count">' + l.count.toLocaleString() + '</div></div>';
    }).join('');
    document.getElementById('langGrid').innerHTML = langHtml || '<p class="text-muted">No language data</p>';
  }
  renderRun() {
    var run = this.state.currentRun;
    var container = document.getElementById('runContent');
    if (!run) {
      container.innerHTML = '<p class="text-muted text-sm">No run in progress.</p>';
      document.getElementById('runStatusBadge').textContent = 'IDLE';
      document.getElementById('runStatusBadge').className = 'status-badge'; return;
    }
    var pct = run.total_engines > 0 ? Math.round((run.completed_engines / run.total_engines) * 100) : 0;
    document.getElementById('runStatusBadge').textContent = run.status === 'running' ? 'RUNNING' : run.status.toUpperCase();
    document.getElementById('runStatusBadge').className = 'status-badge ' + run.status;
    var processing = this.state.files.filter(function(f) { return f.status === 'processing'; });
    var done = this.state.files.filter(function(f) { return ['completed','skipped','error','not_fitting'].indexOf(f.status) >= 0; });
    var self = this;
    function fileCards(arr, showSkip) {
      return arr.map(function(f) {
        var engines = {}; try { engines = JSON.parse(f.engines); } catch(e) {}
        var badges = Object.entries(engines).map(function(e) {
          var name = e[0], r = e[1];
          var cls = r.success ? 'pass' : (r.skipped ? 'skip' : 'fail');
          var icon = r.success ? '\u2713' : (r.skipped ? '\u2298' : '\u2717');
          var dur = r.duration ? ' ' + (r.duration/1000).toFixed(1) + 's' : '';
          return '<span class="engine-badge ' + cls + '">' + icon + ' ' + name + dur + '</span>';
        }).join('');
        var label = f.status === 'not_fitting' ? '\u26A0' : f.status === 'error' ? '\u2717' : f.status === 'skipped' ? '\u2298' : '\u2713';
        var skipBtn = showSkip ? '<button class="btn btn-sm btn-danger" onclick="client.skipFile(\'' + f.file_path.replace(/'/g,'\\\'') + '\')">Skip</button>' : '';
        return '<div class="file-card ' + f.status + '"><div class="file-header"><div class="file-name">' + label + ' ' + f.file_path.split('/').pop() + '</div>' + skipBtn + '</div><div class="engine-badges">' + badges + '</div></div>';
      }).join('');
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
    var html = runs.map(function(run) {
      var dur = run.end_time ? Math.round((run.end_time - run.start_time)/1000) + 's' : '-';
      var stats = { ffsubsync:{pass:0,fail:0}, autosubsync:{pass:0,fail:0}, alass:{pass:0,fail:0} };
      (run.files || []).forEach(function(f) {
        try { var e = JSON.parse(f.engines); Object.entries(e).forEach(function(x) { if (stats[x[0]]) x[1].success ? stats[x[0]].pass++ : stats[x[0]].fail++; }); } catch(er) {}
      });
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
  renderFolders(folders) {
    if (!folders || folders.length === 0) { document.getElementById('folderList').innerHTML = '<p class="text-muted">No folder data yet.</p>'; return; }
    document.getElementById('folderList').innerHTML = folders.map(function(f) {
      return '<div class="folder-row"><span style="font-size:18px">F</span><span class="folder-name">' + f.name + '</span><div class="folder-bar"><div class="folder-bar-fill" style="width:' + f.progress + '%"></div></div><div class="folder-numbers"><span>OK ' + f.synced.toLocaleString() + '</span><span>Pend ' + f.pending.toLocaleString() + '</span></div></div>';
    }).join('');
  }
  render() { this.renderConfig(); if (this.activePage === 'dashboard' || this.activePage === 'run') this.renderRun(); this.updateButtons(); }
  updateButtons() {
    var stop = document.getElementById('stopRun'), start = document.getElementById('startRun'), custom = document.getElementById('startCustom');
    if (this.state.isRunning) { stop.classList.remove('hidden'); start.classList.add('hidden'); custom.classList.add('hidden'); }
    else { stop.classList.add('hidden'); start.classList.remove('hidden'); custom.classList.remove('hidden'); }
  }
  async startRun(paths) {
    try { var body = paths && paths.length > 0 ? JSON.stringify({ paths: paths }) : '{}';
      await fetch('/api/run/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: body }); this.navigate('run'); }
    catch(e) { alert('Failed: ' + e.message); }
  }
  async stopRun() { if (!confirm('Stop run?')) return; try { await fetch('/api/run/stop', { method:'POST' }); } catch(e) {} }
  async skipFile(fp) { try { await fetch('/api/file/skip', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({filePath:fp}) }); } catch(e) {} }
  async viewLogs(runId) {
    var r = await fetch('/api/runs/' + runId + '/logs'); var d = await r.json();
    document.getElementById('logsContent').textContent = d.logs || 'No logs';
    document.getElementById('logsModal').classList.remove('hidden');
  }
  showFileList(runId, cat) {
    var run = this.historyCache[runId]; if (!run || !run.files) return;
    var map = { completed: 'completed', skipped: 'skipped', failed: 'error', not_fitting: 'not_fitting' };
    var files = run.files.filter(function(f) { return f.status === map[cat]; });
    document.getElementById('fileListTitle').textContent = cat + ' (' + files.length + ')';
    document.getElementById('fileListContent').innerHTML = files.length === 0 ? '<p class="text-muted">None</p>' : files.map(function(f) { return '<div style="padding:4px 0;font-size:13px;border-bottom:1px solid var(--border)">' + f.file_path.split('/').pop() + '</div>'; }).join('');
    document.getElementById('fileListModal').classList.remove('hidden');
  }
  setupEvents() {
    var self = this;
    document.getElementById('themeToggle').addEventListener('click', function() { self.toggleTheme(); });
    document.querySelectorAll('.nav-item').forEach(function(btn) { btn.addEventListener('click', function() { self.navigate(btn.dataset.page); }); });
    document.getElementById('startRun').addEventListener('click', function() { self.startRun(null); });
    document.getElementById('startCustom').addEventListener('click', function() { document.getElementById('customPathModal').classList.remove('hidden'); });
    document.getElementById('stopRun').addEventListener('click', function() { self.stopRun(); });
    document.getElementById('closeModal').addEventListener('click', function() { document.getElementById('customPathModal').classList.add('hidden'); });
    document.getElementById('cancelCustom').addEventListener('click', function() { document.getElementById('customPathModal').classList.add('hidden'); });
    document.getElementById('submitCustom').addEventListener('click', function() {
      var paths = document.getElementById('customPaths').value.split('\\n').map(function(p){return p.trim()}).filter(function(p){return p;});
      document.getElementById('customPathModal').classList.add('hidden'); document.getElementById('customPaths').value = ''; self.startRun(paths);
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
    setInterval(function() { if (self.activePage === 'dashboard') self.fetchStats(); }, 15000);
  }
}
var client;
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function() { client = new SubsyncarrPlusClient(); }); }
else { client = new SubsyncarrPlusClient(); }
