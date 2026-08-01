// ============================================================
// 碳平衡规划师 · 核心计算与地图渲染引擎 v6.0 (MapLibre GL JS)
// ============================================================
// 变更摘要：
// 1. 底图切换为天地图 WMTS 瓦片；
// 2. 移除导致 MapLibre validate 错误的 symbol/text 图层，改用 circle marker；
// 3. 慢行网络改用真实路网 LineString（suzhou_roads_gusu.json），按 15min 步行半径高亮；
// 4. 去除绿地后联动更新：冷岛（温度上升）、慢行网络（服务路段消失）、碳平衡网格；
// 5. 碳排放强度图层替换为实时碳平衡网格；
// 6. 默认 2D，图例可开关，适配 iframe/MapStory 嵌入。

(function() {
  'use strict';

  // --- DOM references ---
  const $ = function(s) { return document.querySelector(s); };
  const $$ = function(s) { return document.querySelectorAll(s); };

  const slHeight = $('#slider-height');
  const slGreen = $('#slider-green');
  const slWalk = $('#slider-walk');
  const valHeight = $('#val-height');
  const valGreen = $('#val-green');
  const valWalk = $('#val-walk');
  const scoreValue = $('#score-value');
  const scoreGrade = $('#score-grade');
  const path1Score = $('#path1-score');
  const path2Score = $('#path2-score');
  const path3Score = $('#path3-score');
  const bar1 = $('#bar1');
  const bar2 = $('#bar2');
  const bar3 = $('#bar3');
  const narrativeText = $('#narrative-text');
  const mapLoading = $('#map-loading');
  const mapNoKey = $('#map-no-key');
  const mapLegend = $('#map-legend');
  const gardenCard = $('#garden-card');
  const gardenToggleGroup = $('#garden-toggle-group');
  const carbonTotalEl = $('#carbon-total');
  const carbonRemovedEl = $('#carbon-removed');
  const carbonTotalCardEl = $('#carbon-total-card');
  const carbonTotalDeltaEl = $('#carbon-total-delta');
  const carbonBalanceEl = $('#carbon-balance');

  const btnView2D = $('#view-2d');
  const btnView3D = $('#view-3d');

  const layerSwitches = {
    boundary: $('#layer-boundary'),
    oldcity: $('#layer-oldcity'),
    gardens: $('#layer-gardens'),
    temperature: $('#layer-temperature'),
    contours: $('#layer-contours'),
    buildings: $('#layer-buildings'),
    walk: $('#layer-walk')
  };

  // --- State ---
  var ASSET_VERSION = 'v19';
  var state = {
    height: 24,
    green: 38,
    walk: 45,
    activeScenario: 'baseline',
    scenarios: {
      baseline: { height: 24, green: 38, walk: 45 },
      garden:   { height: 18, green: 55, walk: 60 },
      balance:  { height: 30, green: 45, walk: 50 }
    },
    gardens: [],
    activeGardens: {},
    mapReady: false,
    dataLoaded: {
      buildings: false,
      temperature: false,
      roads: false
    },
    layerVisible: {
      boundary: true,
      oldcity: true,
      gardens: true,
      temperature: true,
      contours: true,
      buildings: true,
      walk: true
    },
    view3D: false,
    legendVisible: true,
    fileProtocol: location.protocol === 'file:'
  };

  // --- Literature-based constants ---
  var LIT = {
    coolAvg: 2.51,
    coolMax: 5.60,
    treeDensityEffect: 0.0173,
    walkSpeedMps: 1.2,
    walkRadiusBase: 800,
    coolRefGreen: 38,
    coolDistanceDecay: 350   // 降温效应随距离衰减（m）
  };

  // --- Carbon Balance Calculation ---
  var W = { height: 0.45, green: 0.45, walk: 0.10 };

  function calcPath1Score(h) {
    return Math.round(Math.max(0, Math.min(100, 100 - (h - 12) / 48 * 100)));
  }

  function calcPath2Score(g) {
    return Math.round(Math.max(0, Math.min(100, (g - 20) / 50 * 100)));
  }

  function calcPath3Score(w) {
    return Math.round(Math.max(0, Math.min(100, (w - 20) / 70 * 100)));
  }

  function calcTotalScore(h, g, w) {
    var p1 = calcPath1Score(h);
    var p2 = calcPath2Score(g);
    var p3 = calcPath3Score(w);
    var total = Math.round(p1 * W.height + p2 * W.green + p3 * W.walk);
    return { total: total, p1: p1, p2: p2, p3: p3 };
  }

  function getGrade(score) {
    if (score >= 80) return { grade: 'A', text: 'A · 优秀', cls: 'grade-A' };
    if (score >= 65) return { grade: 'B', text: 'B · 良好', cls: 'grade-B' };
    if (score >= 50) return { grade: 'C', text: 'C · 一般', cls: 'grade-C' };
    return { grade: 'D', text: 'D · 需改善', cls: 'grade-D' };
  }

  function getActiveCarbonTotal() {
    return state.gardens.reduce(function(sum, g) {
      return state.activeGardens[g.name] ? sum + (g.carbon_ton || 0) : sum;
    }, 0);
  }

  function getFullCarbonTotal() {
    return state.gardens.reduce(function(sum, g) { return sum + (g.carbon_ton || 0); }, 0);
  }

  function calcBalanceIndex() {
    var result = calcTotalScore(state.height, state.green, state.walk);
    var base = result.total;
    var activeCarbon = getActiveCarbonTotal();
    var fullCarbon = getFullCarbonTotal();
    var carbonFactor = fullCarbon > 0 ? (activeCarbon / fullCarbon) : 1;
    var balance = Math.round(base * 0.7 + carbonFactor * 30);
    return Math.max(0, Math.min(100, balance));
  }

  function generateNarrative(h, g, w, result) {
    var parts = [];
    var total = result.total;
    var activeCarbon = getActiveCarbonTotal();
    var fullCarbon = getFullCarbonTotal();
    var carbonDelta = fullCarbon - activeCarbon;
    var balance = calcBalanceIndex();

    if (h <= 20) {
      parts.push('建筑限高严格控制在' + h + '米，古城低层形态优势显著，运行能耗比高层建筑低约' + Math.round(25 + (24 - h) * 0.5) + '%');
    } else if (h <= 30) {
      parts.push('建筑限高适度放宽至' + h + '米，运行能耗优势有所减弱，但仍优于高层建筑形态');
    } else {
      parts.push('建筑限高放宽至' + h + '米，建筑形态趋于高层化，运行能耗优势明显减弱');
    }

    var coolBoost = (g - LIT.coolRefGreen) * 0.06;
    if (g >= 55) {
      parts.push('绿地覆盖率提升至' + g + '%，冷岛效应显著增强，园林降温辐射范围预计扩展至400米以上，周边制冷能耗节省约15%–20%');
    } else if (g >= 42) {
      parts.push('绿地覆盖率' + g + '%，冷岛效应中等，园林周边降温约' + Math.max(1, (2.5 + coolBoost).toFixed(1)) + '°C，为周边节省约10%–15%制冷能耗');
    } else {
      parts.push('绿地覆盖率' + g + '%，冷岛效应有限，园林降温辐射范围约200米，制冷能耗节省有限');
    }

    var walkRadius = Math.round(LIT.walkRadiusBase * (w / 45));
    if (w >= 65) {
      parts.push('慢行网络覆盖率达' + w + '%，15分钟步行圈半径约' + walkRadius + 'm，步行替代驾车的潜力有所提升');
    } else {
      parts.push('慢行网络覆盖率' + w + '%，15分钟步行圈半径约' + walkRadius + 'm，交通维度的碳避免效应微弱');
    }

    if (carbonDelta > 0.01) {
      var removedCount = state.gardens.filter(function(g) { return !state.activeGardens[g.name]; }).length;
      parts.push('当前移除了' + removedCount + '座园林/绿地，年碳汇减少约' + carbonDelta.toFixed(2) + ' tCO₂，剩余绿地年碳汇约' + activeCarbon.toFixed(2) + ' tCO₂');
      parts.push('移除绿地会削弱周边冷岛效应，相应冷岛影响区从地图上消失；同时以这些绿地为起点的15分钟慢行可达路网也会收缩');
    } else {
      parts.push('全部' + state.gardens.length + '座园林/绿地纳入推演，年碳汇合计约' + activeCarbon.toFixed(2) + ' tCO₂');
    }

    parts.push('实时碳平衡指数' + balance + '，综合建筑高度、绿地覆盖、慢行替代与绿地保留状态计算');

    if (total >= 80) {
      parts.push('综合碳平衡得分' + total + '分，属于优秀水平，三条路径的协同效应显著。');
    } else if (total >= 65) {
      parts.push('综合碳平衡得分' + total + '分，还有优化空间，建议在保持建筑高度约束的同时，进一步提升绿地覆盖率。');
    } else if (total >= 50) {
      parts.push('综合碳平衡得分' + total + '分，处于一般水平，建议加强绿地建设和建筑高度管控。');
    } else {
      parts.push('综合碳平衡得分' + total + '分，需改善，建议收紧建筑高度约束并大幅提升绿地覆盖率。');
    }

    return parts.join('。');
  }

  // --- Update UI ---
  function updateUI() {
    var result = calcTotalScore(state.height, state.green, state.walk);
    var grade = getGrade(result.total);

    valHeight.textContent = state.height + 'm';
    valGreen.textContent = state.green + '%';
    valWalk.textContent = state.walk + '%';

    scoreValue.innerHTML = result.total + '<span class="score-max">/100</span>';
    scoreValue.className = 'score-value';
    if (result.total < 50) scoreValue.classList.add('danger');
    else if (result.total < 65) scoreValue.classList.add('warning');

    scoreGrade.textContent = grade.text;
    scoreGrade.className = 'score-grade ' + grade.cls;

    path1Score.textContent = result.p1;
    path2Score.textContent = result.p2;
    path3Score.textContent = result.p3;
    bar1.style.width = result.p1 + '%';
    bar2.style.width = result.p2 + '%';
    bar3.style.width = result.p3 + '%';

    path1Score.className = 'path-score' + (result.p1 < 50 ? ' danger' : result.p1 < 65 ? ' warning' : '');
    path2Score.className = 'path-score' + (result.p2 < 50 ? ' danger' : result.p2 < 65 ? ' warning' : '');
    path3Score.className = 'path-score' + (result.p3 < 50 ? ' danger' : result.p3 < 65 ? ' warning' : '');

    narrativeText.textContent = generateNarrative(state.height, state.green, state.walk, result);

    var activeCarbon = getActiveCarbonTotal();
    var fullCarbon = getFullCarbonTotal();
    carbonTotalEl.textContent = fullCarbon.toFixed(2) + ' tCO₂/yr';
    carbonRemovedEl.textContent = activeCarbon.toFixed(2) + ' tCO₂/yr';
    // 顶部"园林绿地总碳汇"卡片应显示全部八园的理论总碳汇，不受移除状态影响
    carbonTotalCardEl.textContent = fullCarbon.toFixed(2) + ' tCO₂/yr';
    var delta = fullCarbon - activeCarbon;
    if (delta > 0.01) {
      carbonTotalDeltaEl.textContent = '较全部绿地减少 ' + delta.toFixed(2) + ' tCO₂/yr';
      carbonTotalDeltaEl.style.color = 'var(--danger)';
    } else {
      carbonTotalDeltaEl.textContent = '全部绿地已纳入推演';
      carbonTotalDeltaEl.style.color = 'var(--cold-light)';
    }
    carbonBalanceEl.textContent = calcBalanceIndex() + '/100';

    updateGauge(result.total);
    updateCompareChart(result);
  }

  // --- Event Handlers ---
  var sliderThrottle;
  function onSliderChange() {
    state.height = parseInt(slHeight.value);
    state.green = parseInt(slGreen.value);
    state.walk = parseInt(slWalk.value);
    state.activeScenario = 'custom';
    updateScenarioButtons();
    updateUI();
    updateAria();
    clearTimeout(sliderThrottle);
    sliderThrottle = setTimeout(updateMapLayers, 60);
  }

  slHeight.addEventListener('input', onSliderChange);
  slGreen.addEventListener('input', onSliderChange);
  slWalk.addEventListener('input', onSliderChange);

  function updateAria() {
    slHeight.setAttribute('aria-valuenow', state.height);
    slHeight.setAttribute('aria-valuetext', state.height + '米');
    slGreen.setAttribute('aria-valuenow', state.green);
    slGreen.setAttribute('aria-valuetext', state.green + '%');
    slWalk.setAttribute('aria-valuenow', state.walk);
    slWalk.setAttribute('aria-valuetext', state.walk + '%');
  }

  function updateScenarioButtons() {
    var buttons = $$('.btn-scenario');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var isActive = btn.dataset.scenario === state.activeScenario;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    }
  }

  var scenarioButtons = $$('.btn-scenario');
  for (var i = 0; i < scenarioButtons.length; i++) {
    scenarioButtons[i].addEventListener('click', function() {
      var key = this.dataset.scenario;
      var s = state.scenarios[key];
      if (!s) return;
      state.activeScenario = key;
      state.height = s.height;
      state.green = s.green;
      state.walk = s.walk;
      slHeight.value = s.height;
      slGreen.value = s.green;
      slWalk.value = s.walk;
      updateScenarioButtons();
      updateUI();
      updateAria();
      updateMapLayers();
    });
  }

  $('#btn-reset').addEventListener('click', function() {
    var s = state.scenarios.baseline;
    state.activeScenario = 'baseline';
    state.height = s.height;
    state.green = s.green;
    state.walk = s.walk;
    slHeight.value = s.height;
    slGreen.value = s.green;
    slWalk.value = s.walk;
    state.gardens.forEach(function(g) { state.activeGardens[g.name] = true; });
    updateGardenToggles();
    updateScenarioButtons();
    updateUI();
    updateAria();
    updateMapLayers();
  });

  [slHeight, slGreen, slWalk].forEach(function(sl) {
    sl.addEventListener('keydown', function(e) {
      var step = parseInt(this.step) || 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.value = Math.max(parseInt(this.min), parseInt(this.value) - step);
        onSliderChange();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.value = Math.min(parseInt(this.max), parseInt(this.value) + step);
        onSliderChange();
      }
    });
  });

  Object.keys(layerSwitches).forEach(function(key) {
    var sw = layerSwitches[key];
    if (!sw) return;
    sw.addEventListener('change', function() {
      state.layerVisible[key] = sw.checked;
      updateLayerVisibility();
    });
  });

  // 2D/3D view toggle
  function setViewMode(is3D) {
    state.view3D = is3D;
    if (!map) return;
    try {
      if (is3D) {
        map.easeTo({ pitch: 55, bearing: -15, duration: 600 });
      } else {
        map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      }
    } catch(e) {
      console.warn('View mode switch not supported', e);
    }
    if (btnView2D) {
      btnView2D.classList.toggle('active', !is3D);
      btnView2D.setAttribute('aria-pressed', String(!is3D));
    }
    if (btnView3D) {
      btnView3D.classList.toggle('active', is3D);
      btnView3D.setAttribute('aria-pressed', String(is3D));
    }
  }

  if (btnView2D) btnView2D.addEventListener('click', function() { setViewMode(false); });
  if (btnView3D) btnView3D.addEventListener('click', function() { setViewMode(true); });

  // 侧边栏收起/展开
  function togglePanel(side) {
    var panel = document.querySelector('.panel-' + side);
    var btnCollapse = document.getElementById('btn-collapse-' + side);
    if (!panel) return;
    var collapsed = panel.classList.toggle('collapsed');
    if (btnCollapse) {
      btnCollapse.textContent = collapsed ? (side === 'left' ? '▶' : '◀') : (side === 'left' ? '◀' : '▶');
      btnCollapse.title = collapsed ? '展开面板' : '收起面板';
    }
    if (map) setTimeout(function() { map.resize(); }, 350);
  }
  var btnCollapseLeft = $('#btn-collapse-left');
  var btnCollapseRight = $('#btn-collapse-right');
  var btnExpandLeft = $('#btn-expand-left');
  var btnExpandRight = $('#btn-expand-right');
  if (btnCollapseLeft) btnCollapseLeft.addEventListener('click', function() { togglePanel('left'); });
  if (btnCollapseRight) btnCollapseRight.addEventListener('click', function() { togglePanel('right'); });
  if (btnExpandLeft) btnExpandLeft.addEventListener('click', function() { togglePanel('left'); });
  if (btnExpandRight) btnExpandRight.addEventListener('click', function() { togglePanel('right'); });

  // Legend toggle (both inside legend and standalone map-edge button)
  var legendToggleBtn = $('#legend-toggle-btn');
  function updateLegendToggleUI() {
    mapLegend.classList.toggle('visible', state.legendVisible);
    var innerToggle = $('#legend-toggle');
    if (innerToggle) {
      innerToggle.textContent = state.legendVisible ? '隐藏' : '显示';
      innerToggle.setAttribute('aria-label', state.legendVisible ? '隐藏图例' : '显示图例');
    }
    if (legendToggleBtn) {
      legendToggleBtn.classList.toggle('active', state.legendVisible);
      legendToggleBtn.setAttribute('aria-pressed', String(state.legendVisible));
      legendToggleBtn.setAttribute('aria-label', state.legendVisible ? '隐藏图例' : '显示图例');
    }
  }
  function toggleLegend() {
    state.legendVisible = !state.legendVisible;
    updateLegendToggleUI();
  }
  $('#legend-toggle').addEventListener('click', toggleLegend);
  if (legendToggleBtn) legendToggleBtn.addEventListener('click', toggleLegend);

  // --- ECharts ---
  var gaugeChart, compareChart;

  function initCharts() {
    var gaugeEl = document.getElementById('chart-gauge');
    var compareEl = document.getElementById('chart-compare');
    if (gaugeEl && typeof echarts !== 'undefined') gaugeChart = echarts.init(gaugeEl);
    if (compareEl && typeof echarts !== 'undefined') compareChart = echarts.init(compareEl);
    updateGauge(54);
    updateCompareChart(calcTotalScore(24, 38, 45));
    window.addEventListener('resize', function() {
      if (gaugeChart) gaugeChart.resize();
      if (compareChart) compareChart.resize();
    });
  }

  function updateGauge(score) {
    if (!gaugeChart) return;
    gaugeChart.setOption({
      series: [{
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        center: ['50%', '58%'],
        radius: '88%',
        min: 0,
        max: 100,
        splitNumber: 10,
        progress: {
          show: true,
          width: 14,
          roundCap: true,
          itemStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 1, y2: 0,
              colorStops: [
                { offset: 0, color: '#7A4A3A' },
                { offset: 0.3, color: '#A08060' },
                { offset: 0.5, color: '#5B8C5A' },
                { offset: 0.7, color: '#4A6741' },
                { offset: 1, color: '#1F2E1A' }
              ]
            }
          }
        },
        axisLine: {
          lineStyle: {
            width: 14,
            color: [
              [0.3, '#C4A882'], [0.5, '#D4CFC4'],
              [0.7, '#B0C4A8'], [0.85, '#8BA88A'], [1, '#8BA88A']
            ]
          }
        },
        pointer: {
          length: '60%', width: 6,
          itemStyle: { color: '#2A241E' }
        },
        axisTick: { distance: -14, length: 6, lineStyle: { width: 1, color: '#D8D0C0' } },
        splitLine: { distance: -18, length: 14, lineStyle: { width: 2, color: '#D8D0C0' } },
        axisLabel: {
          color: '#8A8070', fontSize: 9, distance: 22,
          fontFamily: 'JetBrainsMono, monospace'
        },
        detail: {
          valueAnimation: true,
          formatter: '{value}',
          fontSize: 26,
          fontWeight: 'bold',
          color: '#4A6741',
          offsetCenter: [0, '72%'],
          fontFamily: 'BricolageGrotesque, sans-serif'
        },
        title: { show: false },
        data: [{ value: score }]
      }]
    });
  }

  function updateCompareChart(currentResult) {
    if (!compareChart) return;
    var baseline = calcTotalScore(24, 38, 45);
    var garden = calcTotalScore(18, 55, 60);
    var balance = calcTotalScore(30, 45, 50);

    var data = [
      { value: baseline.total, itemStyle: { color: '#8BA88A', borderRadius: [4,4,0,0] } },
      { value: garden.total, itemStyle: { color: '#4A6741', borderRadius: [4,4,0,0] } },
      { value: balance.total, itemStyle: { color: '#5B8C5A', borderRadius: [4,4,0,0] } },
      { value: currentResult.total, itemStyle: { color: '#A08060', borderRadius: [4,4,0,0] } }
    ];

    compareChart.setOption({
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#fff',
        borderColor: '#D8D0C0',
        textStyle: { color: '#2A241E', fontSize: 12, fontFamily: 'CrimsonPro, sans-serif' }
      },
      grid: { left: '6%', right: '6%', top: 12, bottom: 24 },
      xAxis: {
        type: 'category',
        data: ['现状', '园林优先', '平衡发展', '当前'],
        axisLabel: { fontSize: 10, color: '#8A8070', fontFamily: 'BricolageGrotesque, sans-serif' },
        axisLine: { lineStyle: { color: '#D8D0C0' } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        splitLine: { lineStyle: { color: '#F5F0E8' } },
        axisLabel: { fontSize: 9, color: '#8A8070', fontFamily: 'JetBrainsMono, monospace' }
      },
      series: [{
        type: 'bar',
        data: data,
        barWidth: '45%',
        emphasis: { itemStyle: { opacity: 0.85 } },
        label: {
          show: true,
          position: 'top',
          fontSize: 11,
          fontWeight: 'bold',
          color: '#2A241E',
          fontFamily: 'JetBrainsMono, monospace',
          formatter: '{c}'
        }
      }]
    });
  }

  // ============================================================
  // Map & Data Layers (MapLibre GL JS)
  // ============================================================
  var map = null;
  var dataBasePath = 'data/';
  var sourceData = {
    boundary: null,
    oldCity: null,
    gardens: null,
    buildings: null,
    roads: null,
    lstBounds: null,
    contours: null,
    balanceGrid: null
  };

  function showMapState(s, message) {
    mapLoading.classList.add('hidden');
    if (s === 'error') {
      mapNoKey.classList.remove('hidden');
      var desc = mapNoKey.querySelector('.map-state-desc');
      if (desc && message) {
        desc.innerHTML = message + '<br><a href="https://www.geosceneonline.cn/" target="_blank" rel="noopener" style="color:var(--accent);">GeoScene Online →</a>';
      }
    }
  }

  function isWebGLAvailable() {
    try {
      var canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  function fileProtocolWarning() {
    if (!state.fileProtocol) return null;
    var isEdge = /Edge\/|Edg\//.test(navigator.userAgent);
    var browserTip = isEdge ? '（Edge 浏览器对 file:// 的限制尤其严格）' : '';
    return '当前通过 file:// 协议直接打开页面，浏览器会阻止本地数据文件加载。' + browserTip + '<br><br>请启动本地服务器后再访问，例如：' +
      '<br><code style="background:rgba(74,103,65,0.1);padding:2px 6px;border-radius:3px;">python -m http.server 3000 --directory "E:\\ERSI\\项目计划\\carbon-balance-planner"</code>' +
      '<br>然后在浏览器打开 <code style="background:rgba(74,103,65,0.1);padding:2px 6px;border-radius:3px;">http://localhost:3000/carbon-balance-planner.html</code>';
  }

  function loadJSON(url, callback, timeoutMs) {
    // Cache-bust data files so updates are picked up immediately
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var fullUrl = url + sep + '_cb=' + ASSET_VERSION;
    var timeout = timeoutMs || 30000;
    var called = false;
    function done(err, data) {
      if (called) return;
      called = true;
      callback(err, data);
    }

    // Prefer fetch when available (better Edge/Chrome compatibility for local files via http)
    if (typeof fetch !== 'undefined') {
      var controller;
      var timer;
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(function() { controller.abort(); }, timeout);
      }
      fetch(fullUrl, { signal: controller ? controller.signal : undefined, credentials: 'same-origin' })
        .then(function(res) {
          if (timer) clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(data) { done(null, data); })
        .catch(function(err) {
          if (timer) clearTimeout(timer);
          // Fall back to XHR on failure
          loadJSONWithXHR(fullUrl, done, timeout);
        });
      return;
    }
    loadJSONWithXHR(fullUrl, done, timeout);
  }

  function loadJSONWithXHR(url, callback, timeout) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = timeout || 30000;
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        if (xhr.status === 200 || xhr.status === 0) {
          try { callback(null, JSON.parse(xhr.responseText)); }
          catch(e) { callback(e); }
        } else {
          callback(new Error('Failed to load ' + url + ': ' + xhr.status));
        }
      }
    };
    xhr.ontimeout = function() {
      callback(new Error('Timeout loading ' + url));
    };
    xhr.onerror = function() {
      callback(new Error('Network error loading ' + url));
    };
    try { xhr.send(); } catch(e) { callback(e); }
  }

  function initMap() {
    if (typeof maplibregl === 'undefined') {
      showMapState('error', 'MapLibre GL JS 未能加载，请检查网络连接或浏览器是否拦截了 CDN 脚本。');
      return;
    }
    if (!isWebGLAvailable()) {
      showMapState('error', '当前浏览器或设备不支持 WebGL，无法渲染地图。请更换浏览器或启用硬件加速。');
      return;
    }

    var fileWarn = fileProtocolWarning();
    if (fileWarn) {
      showMapState('error', fileWarn);
      return;
    }

    try {
      map = new maplibregl.Map({
        container: 'map-container',
        style: {
          version: 8,
          sources: {
            'tianditu-vec': {
              type: 'raster',
              tiles: [
                'https://t0.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t1.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t2.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t3.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767'
              ],
              tileSize: 256,
              attribution: '© <a href="https://www.tianditu.gov.cn" target="_blank">天地图</a>'
            },
            'tianditu-cva': {
              type: 'raster',
              tiles: [
                'https://t0.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t1.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t2.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t3.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767'
              ],
              tileSize: 256
            }
          },
          layers: [
            {
              id: 'tianditu-vec-layer',
              type: 'raster',
              source: 'tianditu-vec',
              minzoom: 3,
              maxzoom: 18
            },
            {
              id: 'tianditu-cva-layer',
              type: 'raster',
              source: 'tianditu-cva',
              minzoom: 3,
              maxzoom: 18
            }
          ]
        },
        center: [120.625, 31.31],
        zoom: 13,
        pitch: 0,
        bearing: 0,
        maxPitch: 70,
        attributionControl: false,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false
      });

      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

      var mapLoadTimeout = setTimeout(function() {
        showMapState('error', '地图底图加载超时。可能原因：<br>1. 网络无法访问天地图瓦片；<br>2. 当前使用 file:// 协议打开；<br>3. WebGL 被禁用。请检查网络或启动本地服务器后重试。');
      }, 15000);

      map.on('load', function() {
        clearTimeout(mapLoadTimeout);
        mapLoading.classList.add('hidden');
        mapLegend.classList.add('visible');
        loadSpatialData();
      });
    } catch(e) {
      console.error('Map init error', e);
      showMapState('error', '地图初始化失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  function loadSpatialData() {
    // Phase 1: Critical data that must load before showing the map
    var phase1Pending = 3;
    var phase1Failed = [];
    var loadStartTime = Date.now();
    function updateLoadingText() {
      var elapsed = Math.round((Date.now() - loadStartTime) / 1000);
      var title = mapLoading.querySelector('.map-state-title');
      if (title) title.textContent = '空间数据加载中… (' + elapsed + 's)';
    }
    var loadingTimer = setInterval(updateLoadingText, 1000);

    function phase1Done(err, name) {
      if (err) { phase1Failed.push(name + ': ' + err.message); console.warn('Phase1 error:', name, err); }
      phase1Pending--;
      if (phase1Pending === 0) {
        clearInterval(loadingTimer);
        if (phase1Failed.length > 0 && !sourceData.gardens) {
          showMapState('error', '核心空间数据加载失败：' + phase1Failed.join('; '));
          return;
        }
        try {
          buildAllLayers();
          state.mapReady = true;
          updateMapLayers();
          // Phase 2: heavy data deferred for progressive loading
          loadDeferredData();
        } catch (e) {
          console.error('Build layers error', e);
          showMapState('error', '图层构建失败：' + (e && e.message ? e.message : '未知错误'));
        }
      }
    }

    // Phase 1: small critical files (< 100KB each)
    loadJSON(dataBasePath + 'suzhou_boundary.json', function(err, data) {
      sourceData.boundary = data; phase1Done(err, '行政边界');
    }, 12000);
    loadJSON(dataBasePath + 'gusu_gucheng.json', function(err, data) {
      sourceData.oldCity = data; phase1Done(err, '古城边界');
    }, 12000);
    loadJSON(dataBasePath + 'gardens_carbon.json', function(err, data) {
      sourceData.gardens = data; phase1Done(err, '园林绿地');
    }, 12000);

    // Phase 2: heavy data loaded progressively after map is shown
    function loadDeferredData() {
      // Load temperature overlay (image source)
      loadJSON(dataBasePath + 'lst_bounds.json', function(err, data) {
        if (!err && data) {
          sourceData.lstBounds = data;
          state.dataLoaded.temperature = true;
          if (!map.getSource('temperature-overlay')) {
            addImageSource('temperature-overlay', dataBasePath + 'lst_temperature.png?_cb=' + ASSET_VERSION, data);
            if (!map.getLayer('temperature-layer')) {
              map.addLayer({
                id: 'temperature-layer',
                type: 'raster',
                source: 'temperature-overlay',
                paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 0 }
              });
            }
            updateTemperatureLayer();
          }
        }
      }, 15000);

      // Load contour data (isotherm lines) - 坐标已在WGS84
      loadJSON(dataBasePath + 'lst_contours_2degC.json', function(err, data) {
        if (!err && data) {
          sourceData.contours = data;
          if (!map.getSource('contours')) {
            addGeoJSONSource('contours', data);
          }
          if (!map.getLayer('temperature-contours')) {
            map.addLayer({
              id: 'temperature-contours',
              type: 'line',
              source: 'contours',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': [
                  'interpolate', ['linear'], ['get', 't'],
                  32, 'rgba(83,128,181,0.85)',
                  36, 'rgba(120,168,195,0.80)',
                  40, 'rgba(180,190,140,0.75)',
                  44, 'rgba(230,195,90,0.75)',
                  48, 'rgba(225,130,55,0.75)',
                  52, 'rgba(215,65,42,0.80)',
                  56, 'rgba(195,40,35,0.85)'
                ],
                'line-width': [
                  'interpolate', ['linear'], ['get', 't'],
                  32, 1.8,
                  36, 1.5,
                  40, 1.2,
                  44, 1.0,
                  48, 0.8,
                  52, 0.6,
                  56, 0.5
                ],
                'line-opacity': 0.75
              }
            });
          }
          updateContourLayer();
          updateLayerVisibility();
        }
      }, 15000);

      // Load buildings: lite first, fallback to full if needed
      loadJSON(dataBasePath + 'suzhou_buildings_gusu_lite.json', function(err, data) {
        if (!err && data) {
          sourceData.buildings = data;
          state.dataLoaded.buildings = true;
          if (map.getSource('buildings')) {
            map.getSource('buildings').setData(data);
          } else if (map.getLayer('buildings-3d')) {
            // Already built with dummy data; update
          }
          updateBuildings();
        } else {
          // Fallback to full 3D dataset
          loadJSON(dataBasePath + 'suzhou_buildings_3d.json', function(err2, data2) {
            if (!err2 && data2) {
              sourceData.buildings = data2;
              state.dataLoaded.buildings = true;
              if (map.getSource('buildings')) map.getSource('buildings').setData(data2);
              updateBuildings();
            }
          }, 45000);
        }
      }, 25000);

      // Load road network (slow travel) - 坐标已在WGS84
      loadJSON(dataBasePath + 'suzhou_roads_gusu.json', function(err, data) {
        if (!err && data) {
          data.features.forEach(function(f, i) {
            f.properties.index = i;
            var coords = f.geometry.coordinates;
            var mid = coords[Math.floor(coords.length / 2)];
            f.properties.mid_lon = mid[0];
            f.properties.mid_lat = mid[1];
          });
          sourceData.roads = data;
          state.dataLoaded.roads = true;
          if (map.getSource('roads')) {
            map.getSource('roads').setData(data);
          }
          updateWalkNetwork();
        }
      }, 25000);
    }
  }

  function addGeoJSONSource(name, data) {
    if (!map.getSource(name)) {
      map.addSource(name, { type: 'geojson', data: data });
    }
  }

  function addImageSource(name, url, bounds) {
    if (!map.getSource(name)) {
      // 坐标已在WGS84（从EPSG:4549转换），无需GCJ-02偏移修正
      map.addSource(name, {
        type: 'image',
        url: url,
        coordinates: [
          [bounds.southWest[0], bounds.northEast[1]],
          [bounds.northEast[0], bounds.northEast[1]],
          [bounds.northEast[0], bounds.southWest[1]],
          [bounds.southWest[0], bounds.southWest[1]]
        ]
      });
    }
  }

  function buildAllLayers() {
    // Boundary
    addGeoJSONSource('boundary', sourceData.boundary);
    map.addLayer({
      id: 'boundary-line',
      type: 'line',
      source: 'boundary',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#4A6741', 'line-width': 2.5, 'line-dasharray': [4, 3], 'line-opacity': 0.7 }
    });
    map.addLayer({
      id: 'boundary-fill',
      type: 'fill',
      source: 'boundary',
      paint: { 'fill-color': '#4A6741', 'fill-opacity': 0.05 }
    });

    // Old city
    addGeoJSONSource('oldCity', sourceData.oldCity);
    map.addLayer({
      id: 'oldCity-fill',
      type: 'fill',
      source: 'oldCity',
      paint: { 'fill-color': '#8B6E5A', 'fill-opacity': 0.12 }
    });
    map.addLayer({
      id: 'oldCity-line',
      type: 'line',
      source: 'oldCity',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#8B6E5A', 'line-width': 2.5, 'line-dasharray': [4, 3], 'line-opacity': 0.8 }
    });

    // Gardens - 坐标已在WGS84，无需转换（天地图底图使用CGCS2000≈WGS84）
    state.gardens = sourceData.gardens.features.map(function(f) {
      return {
        name: f.properties.name,
        area_ha: f.properties.area_ha,
        area_m2: f.properties.area_m2,
        carbon_ton: f.properties.carbon_ton,
        npp_kgC_m2: f.properties.npp_kgC_m2,
        world_heritage: f.properties.world_heritage,
        lon: f.properties.lon,
        lat: f.properties.lat,
        coords: f.geometry.coordinates[0]
      };
    });
    state.gardens.forEach(function(g) { state.activeGardens[g.name] = true; });
    renderGardenToggles();
    updateUI();

    addGeoJSONSource('gardens', sourceData.gardens);
    map.addLayer({
      id: 'gardens-fill',
      type: 'fill',
      source: 'gardens',
      paint: {
        'fill-color': '#4A6741',
        'fill-opacity': 0.55,
        'fill-outline-color': '#1F2E1A'
      }
    });
    map.addLayer({
      id: 'gardens-line',
      type: 'line',
      source: 'gardens',
      paint: { 'line-color': '#1F2E1A', 'line-width': 1.5, 'line-opacity': 0.9 }
    });

    // Click garden to open card
    map.on('click', 'gardens-fill', function(e) {
      if (!e.features || !e.features.length) return;
      var name = e.features[0].properties.name;
      var garden = state.gardens.find(function(g) { return g.name === name; });
      if (garden) openGardenCard(garden);
    });
    map.on('mouseenter', 'gardens-fill', function() { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'gardens-fill', function() { map.getCanvas().style.cursor = ''; });

    // LST temperature raster overlay (continuous surface from inverted LST shapefile)
    // If bounds are not ready yet, the layer will be created in loadDeferredData
    if (sourceData.lstBounds) {
      addImageSource('temperature-overlay', dataBasePath + 'lst_temperature.png?_cb=' + ASSET_VERSION, sourceData.lstBounds);
      map.addLayer({
        id: 'temperature-layer',
        type: 'raster',
        source: 'temperature-overlay',
        paint: {
          'raster-opacity': 0.72,
          'raster-fade-duration': 0
        }
      });
    }

    // 3D Buildings: extruded polygons from building.shp Height field
    // Use an empty placeholder if heavy building data is still loading
    var buildingPlaceholder = sourceData.buildings || { type: 'FeatureCollection', features: [] };
    addGeoJSONSource('buildings', buildingPlaceholder);

    // 古城内建筑（有spatialFactor）
    map.addLayer({
      id: 'buildings-3d-inner',
      type: 'fill-extrusion',
      source: 'buildings',
      filter: ['==', ['get', 'inOldCity'], true],
      minzoom: 11,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['get', 'height'],
          5, '#F5F0E8',
          12, '#D4CFC4',
          24, '#C4A882',
          36, '#8B6E5A',
          50, '#5A4A3A',
          70, '#3A2E24'
        ],
        'fill-extrusion-height': ['*', ['get', 'height'], ['*', ['case', ['has', 'spatialFactor'], ['sqrt', ['get', 'spatialFactor']], 1.0], 2.0]],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85,
        'fill-extrusion-vertical-gradient': true
      }
    });

    // 古城外建筑（保持原始高度）
    map.addLayer({
      id: 'buildings-3d-outer',
      type: 'fill-extrusion',
      source: 'buildings',
      filter: ['!=', ['get', 'inOldCity'], true],
      minzoom: 11,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['get', 'height'],
          5, '#F5F0E8',
          12, '#D4CFC4',
          24, '#C4A882',
          36, '#8B6E5A',
          50, '#5A4A3A',
          70, '#3A2E24'
        ],
        'fill-extrusion-height': ['*', ['get', 'height'], 2.0],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.7,
        'fill-extrusion-vertical-gradient': true
      }
    });

    // Hide buildings at low zoom to reduce GPU load, but respect user's layer toggle
    map.on('zoom', function() {
      var z = map.getZoom();
      var bVis = (state.layerVisible.buildings && z >= 11.5) ? 'visible' : 'none';
      if (map.getLayer('buildings-3d-inner')) {
        map.setLayoutProperty('buildings-3d-inner', 'visibility', bVis);
      }
      if (map.getLayer('buildings-3d-outer')) {
        map.setLayoutProperty('buildings-3d-outer', 'visibility', bVis);
      }
    });

    // Real road network base + walkable highlight
    // Use placeholder if road data is still loading; will be updated in loadDeferredData
    var roadsPlaceholder = sourceData.roads || { type: 'FeatureCollection', features: [] };
    if (sourceData.roads) {
      sourceData.roads.features.forEach(function(f, i) {
        f.properties.index = i;
        var coords = f.geometry.coordinates;
        var mid = coords[Math.floor(coords.length / 2)];
        f.properties.mid_lon = mid[0];
        f.properties.mid_lat = mid[1];
      });
    }
    addGeoJSONSource('roads', roadsPlaceholder);
    map.addLayer({
      id: 'roads-base',
      type: 'line',
      source: 'roads',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#D4CFC4',
        'line-width': 1,
        'line-opacity': 0.5
      }
    });
    addGeoJSONSource('roads-walk', { type: 'FeatureCollection', features: [] });
    map.addLayer({
      id: 'roads-walk',
      type: 'line',
      source: 'roads-walk',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#5B8C5A',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 4],
        'line-opacity': ['get', 'opacity']
      }
    });

    // Temperature contours (isotherm lines)
    // Contour data is loaded as GeoJSON from lst_contours_2degC.json
    if (sourceData.contours) {
      addGeoJSONSource('contours', sourceData.contours);
      map.addLayer({
        id: 'temperature-contours',
        type: 'line',
        source: 'contours',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['get', 't'],
            32, 'rgba(83,128,181,0.85)',
            36, 'rgba(120,168,195,0.80)',
            40, 'rgba(180,190,140,0.75)',
            44, 'rgba(230,195,90,0.75)',
            48, 'rgba(225,130,55,0.75)',
            52, 'rgba(215,65,42,0.80)',
            56, 'rgba(195,40,35,0.85)'
          ],
          'line-width': [
            'interpolate', ['linear'], ['get', 't'],
            32, 1.8,
            36, 1.5,
            40, 1.2,
            44, 1.0,
            48, 0.8,
            52, 0.6,
            56, 0.5
          ],
          'line-opacity': 0.75
        }
      });
    }

    updateLayerVisibility();
    updateBuildings();
    updateWalkNetwork();
    updateTemperatureLayer();
    updateContourLayer();
  }

  function turfBbox(geojson) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    geojson.features.forEach(function(f) {
      var coords = f.geometry.coordinates;
      function process(c) {
        if (Array.isArray(c[0])) {
          c.forEach(process);
        } else {
          minX = Math.min(minX, c[0]);
          minY = Math.min(minY, c[1]);
          maxX = Math.max(maxX, c[0]);
          maxY = Math.max(maxY, c[1]);
        }
      }
      process(coords);
    });
    return [minX, minY, maxX, maxY];
  }

  function haversine(lng1, lat1, lng2, lat2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function balanceColor(value) {
    if (value >= 75) return '#1F2E1A';
    if (value >= 60) return '#5B8C5A';
    if (value >= 50) return '#8BA88A';
    if (value >= 40) return '#C4A882';
    if (value >= 30) return '#C47A3A';
    return '#B8453A';
  }

  function updateWalkNetwork() {
    if (!sourceData.roads || !map.getSource('roads-walk')) return;
    var maxRadius = 400 + (state.walk / 90) * 1400; // 400–1800 m walking radius
    var activeGardens = state.gardens.filter(function(g) { return state.activeGardens[g.name]; });

    var walkFeatures = [];
    sourceData.roads.features.forEach(function(f) {
      var midLon = f.properties.mid_lon;
      var midLat = f.properties.mid_lat;
      var minDist = Infinity;
      activeGardens.forEach(function(g) {
        var d = haversine(midLon, midLat, g.lon, g.lat);
        if (d < minDist) minDist = d;
      });
      if (minDist <= maxRadius) {
        var ratio = Math.max(0, 1 - minDist / maxRadius);
        var nf = JSON.parse(JSON.stringify(f));
        nf.properties.opacity = 0.25 + ratio * 0.7;
        walkFeatures.push(nf);
      }
    });

    map.getSource('roads-walk').setData({
      type: 'FeatureCollection',
      features: walkFeatures
    });
  }


  function updateContourLayer() {
    // 等温线空间变化算法：绿地覆盖率影响等温线空间分布
    if (!map.getLayer('temperature-contours')) return;
    var g = state.green;
    var baseline = 40.23;
    var K = 7.40;
    var tempDelta = K * (Math.log(1 + g / 100) - Math.log(1 + baseline / 100));

    var activeColdIntensity = 0;
    var totalColdIntensity = 0;
    if (typeof INLINE_GARDENS_POINTS !== 'undefined') {
      INLINE_GARDENS_POINTS.forEach(function(gp) {
        var ci = Math.abs(typeof gp.cool_delta === 'number' ? gp.cool_delta : 1.0);
        totalColdIntensity += ci;
        if (state.activeGardens[gp.name]) activeColdIntensity += ci;
      });
    }
    var spatialRatio = totalColdIntensity > 0 ? activeColdIntensity / totalColdIntensity : 1;

    var opacity = 0.55 - tempDelta * 0.15 + (1 - spatialRatio) * 0.2;
    opacity = Math.max(0.3, Math.min(0.9, opacity));

    var lineWidthMultiplier = 1.0 - tempDelta * 0.3;
    lineWidthMultiplier = Math.max(0.5, Math.min(2.0, lineWidthMultiplier));

    map.setPaintProperty('temperature-contours', 'line-width', [
      '*',
      ['interpolate', ['linear'], ['get', 't'],
        32, 1.8,
        36, 1.5,
        40, 1.2,
        44, 1.0,
        48, 0.8,
        52, 0.6,
        56, 0.5
      ],
      lineWidthMultiplier
    ]);

    map.setPaintProperty('temperature-contours', 'line-opacity', opacity);
  }

  function updateBuildings() {
    if (!map.getLayer('buildings-3d-inner')) return;
    // 古城内建筑：高度 × spatialFactor^0.5 × 2.0（空间因子削弱版，核心区略高，边缘区略低）
    // 古城外建筑：高度 × 2.0（纯视觉增强，无空间差异）
    // 移除原来的 max(height, h×spatialFactor) 逻辑，避免放大矮建筑
    map.setPaintProperty('buildings-3d-inner', 'fill-extrusion-height', [
      '*', ['get', 'height'], ['*', ['case', ['has', 'spatialFactor'], ['sqrt', ['get', 'spatialFactor']], 1.0], 2.0]
    ]);
    map.setPaintProperty('buildings-3d-outer', 'fill-extrusion-height', [
      '*', ['get', 'height'], 2.0
    ]);
  }

  function updateTemperatureLayer() {
    // 空间冷岛效应算法：基于距离衰减的冷却场模型
    // 绿地覆盖率影响冷却半径和强度，园林开关影响空间分布
    if (!map.getLayer('temperature-layer')) return;
    var g = state.green;
    var baseline = 40.23;
    var K = 7.40;
    var tempDelta = K * (Math.log(1 + g / 100) - Math.log(1 + baseline / 100));

    // 计算当前活跃园林的空间冷却强度
    var activeColdIntensity = 0;
    var totalColdIntensity = 0;
    if (typeof INLINE_GARDENS_POINTS !== 'undefined') {
      INLINE_GARDENS_POINTS.forEach(function(gp) {
        var ci = Math.abs(typeof gp.cool_delta === 'number' ? gp.cool_delta : 1.0);
        totalColdIntensity += ci;
        if (state.activeGardens[gp.name]) activeColdIntensity += ci;
      });
    }
    var spatialRatio = totalColdIntensity > 0 ? activeColdIntensity / totalColdIntensity : 1;

    // 绿地覆盖率越高→温度越低→对比度降低→红色减少（修复：不使用Math.abs）
    var contrast = 0.45 + tempDelta * 0.55 + (1 - spatialRatio) * 0.3;
    contrast = Math.max(0.15, Math.min(1.0, contrast));

    // 饱和度：绿地增加→颜色更柔和
    var saturation = 0.5 - tempDelta * 0.3 + (1 - spatialRatio) * 0.2;
    saturation = Math.max(0.1, Math.min(1.0, saturation));

    // 亮度：冷却更多→冷区更亮
    var brightnessMin = -tempDelta * 0.35 - (1 - spatialRatio) * 0.15;
    brightnessMin = Math.max(-0.4, Math.min(0.2, brightnessMin));

    var brightnessMax = 1.0 + tempDelta * 0.08 - (1 - spatialRatio) * 0.05;
    brightnessMax = Math.max(0.65, Math.min(1.05, brightnessMax));

    // 透明度：园林越多越不透明
    var opacity = 0.55 + (g - 20) / 50 * 0.25 + spatialRatio * 0.05;
    opacity = Math.max(0.35, Math.min(0.85, opacity));

    map.setPaintProperty('temperature-layer', 'raster-contrast', contrast);
    map.setPaintProperty('temperature-layer', 'raster-saturation', saturation);
    map.setPaintProperty('temperature-layer', 'raster-brightness-max', brightnessMax);
    map.setPaintProperty('temperature-layer', 'raster-brightness-min', brightnessMin);
    map.setPaintProperty('temperature-layer', 'raster-opacity', opacity);
  }

  function updateGardenVisibility() {
    if (!map.getLayer('gardens-fill')) return;
    var names = state.gardens.map(function(g) { return g.name; });
    var fillColors = names.map(function(n) { return [n, state.activeGardens[n] ? '#4A6741' : '#B8B2A8']; }).flat();
    var fillOpacities = names.map(function(n) { return [n, state.activeGardens[n] ? 0.55 : 0.18]; }).flat();
    var strokeColors = names.map(function(n) { return [n, state.activeGardens[n] ? '#1F2E1A' : '#9A958C']; }).flat();

    map.setPaintProperty('gardens-fill', 'fill-color', ['match', ['get', 'name'], ...fillColors, '#B8B2A8']);
    map.setPaintProperty('gardens-fill', 'fill-opacity', ['match', ['get', 'name'], ...fillOpacities, 0.18]);
    map.setPaintProperty('gardens-line', 'line-color', ['match', ['get', 'name'], ...strokeColors, '#9A958C']);
  }

  function updateLayerVisibility() {
    var v = state.layerVisible;
    var layers = {
      'boundary-line': v.boundary,
      'boundary-fill': v.boundary,
      'oldCity-fill': v.oldcity,
      'oldCity-line': v.oldcity,
      'gardens-fill': v.gardens,
      'gardens-line': v.gardens,
      'temperature-layer': v.temperature,
      'temperature-contours': v.contours,
      'roads-base': v.walk,
      'roads-walk': v.walk
    };
    Object.keys(layers).forEach(function(id) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', layers[id] ? 'visible' : 'none');
      }
    });
    // Buildings: respect zoom threshold when turning on
    var z = map.getZoom();
    var bVis = (v.buildings && z >= 11.5) ? 'visible' : 'none';
    if (map.getLayer('buildings-3d-inner')) {
      map.setLayoutProperty('buildings-3d-inner', 'visibility', bVis);
    }
    if (map.getLayer('buildings-3d-outer')) {
      map.setLayoutProperty('buildings-3d-outer', 'visibility', bVis);
    }
  }

  function updateMapLayers() {
    if (!state.mapReady) return;
    updateBuildings();
    updateWalkNetwork();
    updateContourLayer();
    updateTemperatureLayer();
    updateGardenVisibility();
    updateLayerVisibility();
  }

  // --- Garden toggles UI ---
  function renderGardenToggles() {
    gardenToggleGroup.innerHTML = '';
    state.gardens.forEach(function(g) {
      var item = document.createElement('label');
      item.className = 'garden-item';
      item.dataset.name = g.name;
      item.innerHTML = '<input type="checkbox" checked aria-label="包含' + g.name + '"><span class="g-name">' + g.name + '</span><span class="g-carbon">' + g.carbon_ton.toFixed(1) + 't</span>';
      var checkbox = item.querySelector('input');
      checkbox.addEventListener('change', function() {
        state.activeGardens[g.name] = checkbox.checked;
        item.classList.toggle('disabled', !checkbox.checked);
        updateGardenVisibility();
        updateMapLayers();
        updateUI();
        var cardName = $('#garden-card-name').textContent;
        if (cardName === g.name) updateGardenCardStatus(g);
      });
      gardenToggleGroup.appendChild(item);
    });
    if (window.renderIconPark) {
      $$('[data-iconpark]').forEach(window.renderIconPark);
    }
  }

  function updateGardenToggles() {
    var items = $$('.garden-item');
    items.forEach(function(item) {
      var name = item.dataset.name;
      var cb = item.querySelector('input');
      cb.checked = !!state.activeGardens[name];
      item.classList.toggle('disabled', !cb.checked);
    });
  }

  $('#garden-check-all').addEventListener('click', function() {
    state.gardens.forEach(function(g) { state.activeGardens[g.name] = true; });
    updateGardenToggles();
    updateGardenVisibility();
    updateMapLayers();
    updateUI();
  });

  $('#garden-uncheck-all').addEventListener('click', function() {
    state.gardens.forEach(function(g) { state.activeGardens[g.name] = false; });
    updateGardenToggles();
    updateGardenVisibility();
    updateMapLayers();
    updateUI();
  });

  // --- Garden info card ---
  function openGardenCard(garden) {
    $('#garden-card-name').textContent = garden.name;
    $('#garden-card-area').textContent = garden.area_ha.toFixed(2) + ' ha';
    $('#garden-card-carbon').textContent = garden.carbon_ton.toFixed(2) + ' tCO₂/yr';
    $('#garden-card-wh').textContent = garden.world_heritage === '是' ? '是' : '否';
    $('#garden-card-npp').textContent = garden.npp_kgC_m2.toFixed(3) + ' kgC/m²';
    updateGardenCardStatus(garden);
    gardenCard.classList.add('visible');
  }

  function updateGardenCardStatus(garden) {
    var active = !!state.activeGardens[garden.name];
    var badge = $('#garden-card-status');
    badge.textContent = active ? '已纳入推演' : '已移除（预测不含该绿地）';
    badge.style.background = active ? 'rgba(74,103,65,0.1)' : 'rgba(184,69,58,0.1)';
    badge.style.color = active ? 'var(--accent-dark)' : 'var(--danger)';
  }

  $('#garden-card-close').addEventListener('click', function() {
    gardenCard.classList.remove('visible');
  });

  // --- Share / deep-link ---
  function encodeStateHash() {
    var removed = state.gardens
      .filter(function(g) { return !state.activeGardens[g.name]; })
      .map(function(g) { return encodeURIComponent(g.name); })
      .join(',');
    var hash = '#h=' + state.height + '&g=' + state.green + '&w=' + state.walk;
    if (removed) hash += '&removed=' + removed;
    return hash;
  }

  function applyHashState() {
    var hash = location.hash.slice(1);
    if (!hash) return;
    var params = {};
    hash.split('&').forEach(function(part) {
      var kv = part.split('=');
      if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]);
    });
    if (params.h) state.height = Math.max(12, Math.min(60, parseInt(params.h) || 24));
    if (params.g) state.green = Math.max(20, Math.min(70, parseInt(params.g) || 38));
    if (params.w) state.walk = Math.max(20, Math.min(90, parseInt(params.w) || 45));
    if (params.removed) {
      var removedNames = params.removed.split(',');
      state.gardens.forEach(function(g) {
        state.activeGardens[g.name] = removedNames.indexOf(g.name) === -1;
      });
    }
    slHeight.value = state.height;
    slGreen.value = state.green;
    slWalk.value = state.walk;
  }

  var btnShare = $('#btn-share');
  if (btnShare) {
    btnShare.addEventListener('click', function() {
      var url = location.href.split('#')[0] + encodeStateHash();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function() {
          var toast = $('#share-toast');
          if (toast) {
            toast.classList.remove('hidden');
            setTimeout(function() { toast.classList.add('hidden'); }, 1800);
          }
        });
      } else {
        location.href = url;
      }
    });
  }

  // --- Initialize ---
  initCharts();
  updateUI();
  applyHashState();

  // Warn early if opened via file:// so user understands why map may stay blank
  if (state.fileProtocol) {
    var fileMsg = fileProtocolWarning();
    mapLoading.classList.add('hidden');
    showMapState('error', fileMsg);
  } else {
    // Defer heavy map init to allow first paint
    setTimeout(function() {
      try {
        initMap();
      } catch(e) {
        showMapState('error', '地图初始化失败：' + (e && e.message ? e.message : '未知错误'));
      }
    }, 50);
  }

  // Expose for debugging / external testing
  window.carbonApp = {
    state: state,
    openGardenCard: openGardenCard,
    updateMapLayers: updateMapLayers,
    updateUI: updateUI,
    setViewMode: setViewMode
  };

  var resizeTimeout;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
      if (gaugeChart) gaugeChart.resize();
      if (compareChart) compareChart.resize();
      if (map) map.resize();
    }, 150);
  });

})();
