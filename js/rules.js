/*
 * rules.js —— 判断规则层（纯函数）
 * 只负责温区、截港、容积、挑柜的业务判断，不依赖 DOM，也不读写 localStorage。
 */
(function () {
  'use strict';

  var HOUR = 3600 * 1000;
  var URGENT_WINDOW = 2 * HOUR; // 截港不足两小时视为急货

  // 温区定义（三个温区柜）
  var ZONES = [
    { key: 'frozen', name: '冷冻', range: '-25℃ ~ -18℃' },
    { key: 'chill', name: '冷藏', range: '0℃ ~ 4℃' },
    { key: 'cool', name: '恒温', range: '8℃ ~ 15℃' }
  ];
  var ZONE_MAP = {};
  ZONES.forEach(function (z) { ZONE_MAP[z.key] = z; });

  function zoneName(key) {
    return ZONE_MAP[key] ? ZONE_MAP[key].name : key;
  }

  // 空仓库预置：三个温区柜
  function defaultCabinets() {
    return [
      { id: 'F1', zone: 'frozen', capacity: 30, cargoIds: [] },
      { id: 'C1', zone: 'chill', capacity: 30, cargoIds: [] },
      { id: 'M1', zone: 'cool', capacity: 30, cargoIds: [] }
    ];
  }

  // 预置六票货物（baseTime 为参考当前时刻）
  // 冷处理状态：certified = true 表示证明齐全；false 表示缺冷处理证明，需排队
  function seedCargoes(baseTime) {
    return [
      makeCargo('BL-2601', 'frozen', 18, baseTime + 1.2 * HOUR, true),
      makeCargo('BL-2602', 'chill', 20, baseTime + 5 * HOUR, true),
      makeCargo('BL-2603', 'chill', 16, baseTime + 0.8 * HOUR, false),
      makeCargo('BL-2604', 'cool', 14, baseTime + 3 * HOUR, true),
      makeCargo('BL-2605', 'frozen', 14, baseTime + 26 * HOUR, false),
      makeCargo('BL-2606', 'chill', 12, baseTime + 1.5 * HOUR, true)
    ];
  }

  function makeCargo(id, zone, volume, cutoffAt, certified) {
    return {
      id: id,
      zone: zone,
      volume: volume,
      cutoffAt: cutoffAt,
      certified: certified,
      status: 'queued', // queued 排队中 / placed 已入柜
      cabinetId: null
    };
  }

  /* ---------- 基础工具 ---------- */

  function msUntil(cargo, now) {
    return cargo.cutoffAt - now;
  }

  // 急货：截港不足两小时；返回 'overdue' | 'urgent' | 'normal'
  function urgency(cargo, now) {
    var diff = msUntil(cargo, now);
    if (diff < 0) return 'overdue';
    if (diff < URGENT_WINDOW) return 'urgent';
    return 'normal';
  }

  // 缺冷处理证明的货物必须先排队，补齐后才能入柜
  function canEnterCabin(cargo) {
    return cargo.certified === true;
  }

  function cabinetUsed(cab, cargoById) {
    return cab.cargoIds.reduce(function (sum, id) {
      return sum + (cargoById[id] ? cargoById[id].volume : 0);
    }, 0);
  }

  function cabinetFree(cab, cargoById) {
    return cab.capacity - cabinetUsed(cab, cargoById);
  }

  // 入柜条件：同温区 + 留足容积
  function cabinetFits(cab, cargo, cargoById) {
    return cab.zone === cargo.zone && cabinetFree(cab, cargoById) >= cargo.volume;
  }

  function eligibleCabinets(cargo, cabinets, cargoById) {
    return cabinets.filter(function (cab) {
      return cabinetFits(cab, cargo, cargoById);
    });
  }

  // 挑柜：可选柜中取剩余容积最接近货物体积者（最佳适配，为大票急货保留整柜空间）
  function pickCabinet(cargo, cabinets, cargoById) {
    var fits = eligibleCabinets(cargo, cabinets, cargoById);
    if (!fits.length) return null;
    fits.sort(function (a, b) {
      return cabinetFree(a, cargoById) - cabinetFree(b, cargoById);
    });
    return fits[0];
  }

  // 调度排序优先级：已截港 > 急货（截港不足 2h）> 普通货；同级按截港时刻升序
  var URGENCY_RANK = { overdue: 0, urgent: 1, normal: 2 };
  function sortByPriority(list, now) {
    return list.slice().sort(function (a, b) {
      var rank = URGENCY_RANK[urgency(a, now)] - URGENCY_RANK[urgency(b, now)];
      if (rank !== 0) return rank;
      return a.cutoffAt - b.cutoffAt;
    });
  }

  /* ---------- 调度主算法（纯函数，返回变更计划，不改动入参） ---------- */

  function indexCargoes(cargoes) {
    var map = {};
    cargoes.forEach(function (c) { map[c.id] = c; });
    return map;
  }

  /*
   * planDispatch：跑一轮自动调度
   * 规则：
   *  - 已入柜的不挪（只对 status === 'queued' 的货物做分配）
   *  - 缺冷处理证明的继续排队，跳过
   *  - 急货（截港 < 2h）优先挑柜
   *  - 同温区且容积充足才入柜
   * 返回 [{ cargoId, cabinetId }]
   */
  function planDispatch(cargoes, cabinets, now) {
    var cargoById = indexCargoes(cargoes);
    // 以当前占用为基础做工作副本，分配时即时累计，保证同轮不重复占位
    var usedById = {};
    cabinets.forEach(function (cab) { usedById[cab.id] = cabinetUsed(cab, cargoById); });

    var waiting = sortByPriority(
      cargoes.filter(function (c) { return c.status === 'queued'; }),
      now
    );

    var assignments = [];
    waiting.forEach(function (cargo) {
      if (!canEnterCabin(cargo)) return; // 缺证明，排队等待
      var fits = cabinets
        .filter(function (cab) {
          return cab.zone === cargo.zone &&
            cab.capacity - usedById[cab.id] >= cargo.volume;
        })
        .sort(function (a, b) {
          // 最佳适配
          return (a.capacity - usedById[a.id]) - (b.capacity - usedById[b.id]);
        });
      if (!fits.length) return; // 同温区无空位，继续等待
      var cab = fits[0];
      usedById[cab.id] += cargo.volume;
      assignments.push({ cargoId: cargo.id, cabinetId: cab.id });
    });
    return assignments;
  }

  // 单票手动入柜：同样只看当前状态，返回目标柜或 null
  function planPlaceOne(cargo, cabinets, cargoes) {
    if (cargo.status !== 'queued') return null;
    if (!canEnterCabin(cargo)) return null;
    var cargoById = indexCargoes(cargoes);
    return pickCabinet(cargo, cabinets, cargoById);
  }

  window.Rules = {
    HOUR: HOUR,
    URGENT_WINDOW: URGENT_WINDOW,
    ZONES: ZONES,
    ZONE_MAP: ZONE_MAP,
    zoneName: zoneName,
    defaultCabinets: defaultCabinets,
    seedCargoes: seedCargoes,
    makeCargo: makeCargo,
    msUntil: msUntil,
    urgency: urgency,
    canEnterCabin: canEnterCabin,
    cabinetUsed: cabinetUsed,
    cabinetFree: cabinetFree,
    cabinetFits: cabinetFits,
    eligibleCabinets: eligibleCabinets,
    pickCabinet: pickCabinet,
    sortByPriority: sortByPriority,
    planDispatch: planDispatch,
    planPlaceOne: planPlaceOne,
    indexCargoes: indexCargoes
  };
})();
