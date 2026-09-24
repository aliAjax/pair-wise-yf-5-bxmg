/*
 * app.js —— 页面交互层
 * 负责渲染与事件；业务判断调用 Rules，状态与本地保存调用 Store。
 */
(function () {
  'use strict';

  var store = new Store();
  var filter = 'all';
  var logs = [];
  var editingId = null;
  var toastTimer = null;

  var el = {
    clock: document.getElementById('clock'),
    tabs: document.getElementById('zone-tabs'),
    grid: document.getElementById('cabinet-grid'),
    tbody: document.getElementById('cargo-tbody'),
    summary: document.getElementById('queue-summary'),
    logList: document.getElementById('log-list'),
    dialog: document.getElementById('edit-dialog'),
    editForm: document.getElementById('edit-form'),
    editCargoId: document.getElementById('edit-cargo-id'),
    editZone: document.getElementById('edit-zone'),
    editVolume: document.getElementById('edit-volume')
  };

  /* ---------- 工具 ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtClock(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtCutoff(t) {
    var d = new Date(t);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtRemaining(diff) {
    var abs = Math.abs(diff);
    var mins = Math.round(abs / 60000);
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    var txt = h > 0 ? h + '小时' + (m > 0 ? m + '分' : '') : m + '分';
    return diff < 0 ? '已截港 ' + txt : '剩 ' + txt;
  }

  function addLog(text) {
    logs.unshift({ t: Date.now(), text: text });
    if (logs.length > 50) logs.length = 50;
  }

  function toast(msg) {
    var box = document.getElementById('toast');
    box.textContent = msg;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('show'); }, 2200);
  }

  /* ---------- 调度动作 ---------- */

  // 跑一轮自动调度：已入柜不挪、缺证明跳过、急货优先（规则在 Rules.planDispatch）
  function runAutoDispatch(showToast) {
    var now = Date.now();
    var plan = Rules.planDispatch(store.state.cargoes, store.state.cabinets, now);
    var done = store.applyAssignments(plan);
    done.forEach(function (a) {
      addLog('货号 <b>' + esc(a.cargoId) + '</b> 入柜 <b>' + esc(a.cabinetId) + '</b>');
    });
    if (showToast) {
      toast(done.length ? '本轮新入柜 ' + done.length + ' 票' : '本轮无满足条件的新入柜');
    }
    render();
    return done;
  }

  function actionCompleteCert(id) {
    var cargo = store.getCargo(id);
    if (!cargo) return;
    store.completeCertification(id);
    addLog('货号 <b>' + esc(id) + '</b> 冷处理证明已补齐，重新参与调度');
    runAutoDispatch(false); // 补齐后自动尝试入柜
  }

  function actionPlaceOne(id) {
    var cargo = store.getCargo(id);
    if (!cargo) return;
    if (!Rules.canEnterCabin(cargo)) {
      toast('缺冷处理证明，不能入柜');
      return;
    }
    var cab = Rules.planPlaceOne(cargo, store.state.cabinets, store.state.cargoes);
    if (!cab) {
      toast('同温区暂无足够容积的柜位');
      return;
    }
    store.placeCargo(id, cab.id);
    addLog('手动调度：货号 <b>' + esc(id) + '</b> 入柜 <b>' + esc(cab.id) + '</b>');
    toast(id + ' 已入柜 ' + cab.id);
    render();
  }

  function openEdit(id) {
    var cargo = store.getCargo(id);
    if (!cargo) return;
    editingId = id;
    el.editCargoId.textContent = id;
    el.editZone.value = cargo.zone;
    el.editVolume.value = cargo.volume;
    el.dialog.showModal();
  }

  function saveEdit() {
    if (!editingId) return;
    var nextZone = el.editZone.value;
    var nextVolume = Math.round(parseFloat(el.editVolume.value) * 10) / 10;
    if (!Rules.ZONE_MAP[nextZone]) { toast('温区无效'); return; }
    if (!(nextVolume > 0)) { toast('体积须大于 0'); return; }

    var cargo = store.getCargo(editingId);
    var res = store.updateCargoSpec(editingId, nextZone, nextVolume);
    if (!res) return;

    if (res.releasedFrom) {
      addLog('货号 <b>' + esc(editingId) + '</b> 改单：释放原柜位 <b>' +
        esc(res.releasedFrom) + '</b>，重新排队');
    } else if (res.changed) {
      addLog('货号 <b>' + esc(editingId) + '</b> 修改温区/体积，重新排队');
    }
    el.dialog.close();
    editingId = null;
    runAutoDispatch(false);
  }

  function doReset() {
    if (!window.confirm('确定恢复为预置的三个温区柜与六票货物？当前本地数据将被清空。')) return;
    store.reset();
    logs = [];
    addLog('已恢复预置数据（空仓库 + 六票货），执行初始调度');
    runAutoDispatch(false);
  }

  /* ---------- 渲染 ---------- */

  function visibleCargoes() {
    return filter === 'all'
      ? store.state.cargoes
      : store.state.cargoes.filter(function (c) { return c.zone === filter; });
  }

  function pendingInZone(zoneKey) {
    return store.state.cargoes.filter(function (c) {
      return c.zone === zoneKey && c.status === 'queued';
    });
  }

  function renderTabs() {
    var html = '<button class="zone-tab' + (filter === 'all' ? ' active' : '') +
      '" data-zone="all">全部温区</button>';
    html += Rules.ZONES.map(function (z) {
      var n = pendingInZone(z.key).length;
      return '<button class="zone-tab' + (filter === z.key ? ' active' : '') +
        '" data-zone="' + z.key + '">' +
        esc(z.name) + ' · 待处理 ' + n + '</button>';
    }).join('');
    el.tabs.innerHTML = html;
  }

  function occupancyClass(ratio) {
    if (ratio >= 1) return 'full';
    if (ratio >= 0.8) return 'warn';
    return '';
  }

  function renderCabinets() {
    var byId = Rules.indexCargoes(store.state.cargoes);
    var cabs = filter === 'all'
      ? store.state.cabinets
      : store.state.cabinets.filter(function (g) { return g.zone === filter; });

    el.grid.innerHTML = cabs.map(function (cab) {
      var used = Rules.cabinetUsed(cab, byId);
      var free = cab.capacity - used;
      var ratio = cab.capacity ? used / cab.capacity : 0;
      var zone = Rules.ZONE_MAP[cab.zone];
      var pending = pendingInZone(cab.zone).length;
      var chips = cab.cargoIds.length
        ? cab.cargoIds.map(function (id) {
          var c = byId[id];
          return '<span class="cab-chip">' + esc(id) + ' · ' + c.volume + 'm³</span>';
        }).join('')
        : '<span class="cab-empty">空柜</span>';
      return '<div class="cab-card">' +
        '<div class="cab-top">' +
          '<span class="cab-name">柜 ' + esc(cab.id) + '</span>' +
          '<span class="zone-badge zone-' + cab.zone + '">' + esc(zone.name) + '</span>' +
        '</div>' +
        '<div class="cab-meta">' + esc(zone.range) + ' · 本温区待处理 ' + pending + ' 票</div>' +
        '<div class="occ-bar"><div class="occ-fill ' + occupancyClass(ratio) +
          '" style="width:' + Math.min(100, ratio * 100).toFixed(1) + '%"></div></div>' +
        '<div class="occ-text"><span>已用 ' + used.toFixed(1) + ' / ' + cab.capacity + ' m³</span>' +
          '<span>余 ' + free.toFixed(1) + ' m³</span></div>' +
        '<div class="cab-items">' + chips + '</div>' +
      '</div>';
    }).join('');
  }

  function urgencyPill(cargo, now) {
    var u = Rules.urgency(cargo, now);
    if (u === 'overdue') return '<span class="pill overdue">已截港</span>';
    if (u === 'urgent') return '<span class="pill urgent">急 · 不足2小时</span>';
    return '<span class="pill normal">普通</span>';
  }

  function statusCell(cargo) {
    if (cargo.status === 'placed') {
      return '<span class="pill placed">在柜 ' + esc(cargo.cabinetId) + '</span>';
    }
    if (!Rules.canEnterCabin(cargo)) {
      return '<span class="pill hold">缺冷处理证明 · 排队</span>';
    }
    return '<span class="pill queue">排队待柜</span>';
  }

  function actionButtons(cargo) {
    if (cargo.status === 'placed') {
      return '<button class="btn mini" data-action="edit" data-id="' + esc(cargo.id) +
        '">改温区/体积</button>';
    }
    var btns = '';
    if (!cargo.certified) {
      btns += '<button class="btn mini primary" data-action="cert" data-id="' +
        esc(cargo.id) + '">补齐证明</button>';
    } else {
      btns += '<button class="btn mini primary" data-action="place" data-id="' +
        esc(cargo.id) + '">手动入柜</button>';
    }
    btns += '<button class="btn mini" data-action="edit" data-id="' +
      esc(cargo.id) + '">改温区/体积</button>';
    return btns;
  }

  function renderCargoes() {
    var now = Date.now();
    var rows = Rules.sortByPriority(visibleCargoes(), now);
    el.tbody.innerHTML = rows.map(function (c) {
      var diff = Rules.msUntil(c, now);
      return '<tr>' +
        '<td><b>' + esc(c.id) + '</b></td>' +
        '<td><span class="zone-badge zone-' + c.zone + '">' +
          esc(Rules.zoneName(c.zone)) + '</span></td>' +
        '<td>' + c.volume.toFixed(1) + '</td>' +
        '<td>' + fmtCutoff(c.cutoffAt) +
          '<div class="cab-meta">' + fmtRemaining(diff) + ' ' + urgencyPill(c, now) + '</div></td>' +
        '<td>' + (c.certified
          ? '<span class="cert-yes">✓ 齐全</span>'
          : '<span class="cert-no">✗ 缺证明</span>') + '</td>' +
        '<td>' + statusCell(c) + '</td>' +
        '<td class="ta-right"><div class="row-actions">' + actionButtons(c) + '</div></td>' +
      '</tr>';
    }).join('');

    var pending = store.state.cargoes.filter(function (c) {
      return c.status === 'queued' && (filter === 'all' || c.zone === filter);
    });
    var noCert = pending.filter(function (c) { return !c.certified; }).length;
    el.summary.textContent = '待处理 ' + pending.length + ' 票（其中缺冷处理证明 ' + noCert + ' 票）';
  }

  function renderLogs() {
    el.logList.innerHTML = logs.map(function (l) {
      return '<li><span class="log-time">' + fmtClock(l.t).slice(5) + '</span>' + l.text + '</li>';
    }).join('') || '<li class="cab-empty">暂无调度记录</li>';
  }

  function render() {
    renderTabs();
    renderCabinets();
    renderCargoes();
    renderLogs();
  }

  /* ---------- 事件 ---------- */

  el.tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.zone-tab');
    if (!btn) return;
    filter = btn.dataset.zone;
    render();
  });

  el.tbody.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    var action = btn.dataset.action;
    if (action === 'cert') actionCompleteCert(id);
    else if (action === 'place') actionPlaceOne(id);
    else if (action === 'edit') openEdit(id);
  });

  document.getElementById('btn-dispatch').addEventListener('click', function () {
    runAutoDispatch(true);
  });
  document.getElementById('btn-reset').addEventListener('click', doReset);
  document.getElementById('edit-save').addEventListener('click', saveEdit);
  el.editForm.addEventListener('submit', function (e) {
    e.preventDefault(); // 回车提交也走保存校验，避免直接关窗丢失修改
    saveEdit();
  });
  document.getElementById('edit-cancel').addEventListener('click', function () {
    editingId = null;
    el.dialog.close();
  });
  el.dialog.addEventListener('close', function () { editingId = null; });

  // 时钟每秒走；截港倒计时每 20 秒整体刷新
  setInterval(function () {
    el.clock.textContent = fmtClock(Date.now());
  }, 1000);
  setInterval(render, 20000);

  /* ---------- 启动 ---------- */

  // 预置温区下拉
  el.editZone.innerHTML = Rules.ZONES.map(function (z) {
    return '<option value="' + z.key + '">' + esc(z.name) + '（' + esc(z.range) + '）</option>';
  }).join('');

  el.clock.textContent = fmtClock(Date.now());
  addLog('调度台就绪，执行一轮自动调度（急货优先、缺证明排队）');
  runAutoDispatch(false);
})();
