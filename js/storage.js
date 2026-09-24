/*
 * storage.js —— 本地保存层
 * 负责状态的读写、入柜 / 释放 / 补证 / 修改重排队等数据变更与 localStorage 持久化。
 * 不操作 DOM，不做界面判断（温区匹配等规则由 rules.js 提供）。
 */
(function () {
  'use strict';

  var KEY = 'cold-dispatch-state-v1';

  function freshState() {
    var now = Date.now();
    return {
      seededAt: now,
      cabinets: Rules.defaultCabinets(),
      cargoes: Rules.seedCargoes(now)
    };
  }

  function isValid(state) {
    return state &&
      Array.isArray(state.cabinets) && state.cabinets.length === 3 &&
      Array.isArray(state.cargoes) && state.cargoes.length === 6 &&
      state.cargoes.every(function (c) {
        return c.id && Rules.ZONE_MAP[c.zone] &&
          typeof c.volume === 'number' &&
          typeof c.cutoffAt === 'number' &&
          typeof c.certified === 'boolean' &&
          (c.status === 'queued' || c.status === 'placed');
      });
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* 存储不可用时退化为内存态，页面仍可使用 */
    }
  }

  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) return null;
    try {
      var state = JSON.parse(raw);
      return isValid(state) ? state : null;
    } catch (e) {
      return null;
    }
  }

  function Store() {
    this.state = load() || freshState();
    this.persist();
  }

  Store.prototype.persist = function () {
    save(this.state);
  };

  Store.prototype.reset = function () {
    this.state = freshState();
    this.persist();
  };

  Store.prototype.getCargo = function (id) {
    return this.state.cargoes.filter(function (c) { return c.id === id; })[0] || null;
  };

  Store.prototype.getCabinet = function (id) {
    return this.state.cabinets.filter(function (g) { return g.id === id; })[0] || null;
  };

  // 入柜：写货物状态并挂到柜内货单
  Store.prototype.placeCargo = function (cargoId, cabinetId) {
    var cargo = this.getCargo(cargoId);
    var cab = this.getCabinet(cabinetId);
    if (!cargo || !cab) return false;
    cargo.status = 'placed';
    cargo.cabinetId = cabinetId;
    if (cab.cargoIds.indexOf(cargoId) === -1) cab.cargoIds.push(cargoId);
    this.persist();
    return true;
  };

  // 批量应用调度计划
  Store.prototype.applyAssignments = function (assignments) {
    var done = [];
    var self = this;
    assignments.forEach(function (a) {
      if (self.placeCargo(a.cargoId, a.cabinetId)) {
        done.push(a);
      }
    });
    return done;
  };

  // 释放柜位并回到排队
  Store.prototype.releaseCargo = function (cargoId) {
    var cargo = this.getCargo(cargoId);
    if (!cargo) return null;
    var prevCabinet = cargo.cabinetId;
    if (prevCabinet) {
      var cab = this.getCabinet(prevCabinet);
      if (cab) {
        cab.cargoIds = cab.cargoIds.filter(function (id) { return id !== cargoId; });
      }
    }
    cargo.status = 'queued';
    cargo.cabinetId = null;
    this.persist();
    return prevCabinet;
  };

  // 补齐冷处理证明（补齐后仍为排队，等下一轮调度入柜）
  Store.prototype.completeCertification = function (cargoId) {
    var cargo = this.getCargo(cargoId);
    if (!cargo || cargo.certified) return false;
    cargo.certified = true;
    this.persist();
    return true;
  };

  /*
   * 修改温区 / 体积：释放原柜位并重新排队。
   * 返回 { releasedFrom: 原柜位id或null, changed: bool }
   */
  Store.prototype.updateCargoSpec = function (cargoId, nextZone, nextVolume) {
    var cargo = this.getCargo(cargoId);
    if (!cargo) return null;
    var releasedFrom = cargo.status === 'placed' ? cargo.cabinetId : null;

    var changed = cargo.zone !== nextZone || cargo.volume !== nextVolume;

    if (releasedFrom) {
      var cab = this.getCabinet(releasedFrom);
      if (cab) {
        cab.cargoIds = cab.cargoIds.filter(function (id) { return id !== cargoId; });
      }
    }
    cargo.zone = nextZone;
    cargo.volume = nextVolume;
    cargo.status = 'queued';       // 改温区或体积 → 重新排队
    cargo.cabinetId = null;       // 释放原柜位
    this.persist();
    return { releasedFrom: releasedFrom, changed: changed };
  };

  window.Store = Store;
})();
