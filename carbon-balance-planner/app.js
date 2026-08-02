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
  var ASSET_VERSION = 'v34';
  var state = {
    height: 24,
    green: 40,
    walk: 45,
    activeScenario: 'baseline',
    scenarios: {
      baseline: { height: 24, green: 40, walk: 45 },
      garden:   { height: 18, green: 55, walk: 60 },
      balance:  { height: 30, green: 50, walk: 55 }
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
    coolRefGreen: 40,
    coolDistanceDecay: 350   // 降温效应随距离衰减（m）
  };

  // --- 冷岛缓冲区生成 ---
  // 为每个园林生成圆形冷岛影响区多边形（半径约350m）
  function generateColdIslandBuffer(lon, lat, radiusM) {
    var numPoints = 36;
    var coords = [];
    var cosLat = Math.cos(lat * Math.PI / 180);
    for (var i = 0; i < numPoints; i++) {
      var angle = (i / numPoints) * Math.PI * 2;
      var dx = radiusM * Math.cos(angle);
      var dy = radiusM * Math.sin(angle);
      coords.push([lon + dx / (111320 * cosLat), lat + dy / 111320]);
    }
    coords.push(coords[0]); // 闭合环
    return { type: 'Polygon', coordinates: [coords] };
  }

  // --- Carbon Balance Calculation ---
  var W = { height: 0.45, green: 0.45, walk: 0.10 };

  function calcPath1Score(h) {
  // 以18m为理想基准（苏州古城典型檐口高度），60m为最差
  return Math.round(Math.max(0, Math.min(100, 100 - (h - 18) / 42 * 100)));
}

  function calcPath2Score(g) {
    return Math.round(Math.max(0, Math.min(100, (g - 20) / 50 * 100)));
  }

  function calcPath3Score(w) {
    return Math.round(Math.max(0, Math.min(100, (w - 20) / 70 * 100)));
  }

  // 园林冷岛效应因子：已激活园林冷岛强度之和 / 全部园林冷岛强度之和
  function getColdIslandFactor() {
    var totalColdIsland = 0, activeColdIsland = 0;
    state.gardens.forEach(function(garden) {
      var ci = Math.abs(garden.cool_delta || 0);
      totalColdIsland += ci;
      if (state.activeGardens[garden.name]) activeColdIsland += ci;
    });
    return totalColdIsland > 0 ? activeColdIsland / totalColdIsland : 1;
  }

  function calcTotalScore(h, g, w) {
    var p1 = calcPath1Score(h);
    var p2 = calcPath2Score(g);
    var p3 = calcPath3Score(w);
    // 冷岛效应×园林保留状态：全部保留=系数1，全部移除=系数0.85
    var coldIslandFactor = getColdIslandFactor();
    var p2Adjusted = Math.round(p2 * (0.85 + 0.15 * coldIslandFactor));
    var activeCarbon = getActiveCarbonTotal();
    var fullCarbon = getFullCarbonTotal();
    var carbonFactor = fullCarbon > 0 ? (activeCarbon / fullCarbon) : 1;
    // 园林保留比例影响综合得分：全部保留时系数=1，全部移除时系数=0.85
    var carbonMultiplier = 0.85 + 0.15 * carbonFactor;
    var total = Math.round((p1 * W.height + p2Adjusted * W.green + p3 * W.walk) * carbonMultiplier);
    return { total: total, p1: p1, p2: p2Adjusted, p3: p3 };
  }

  // 固定场景得分（不计园林开关，用于情景对比图）
  function calcFixedScore(h, g, w) {
    var p1 = calcPath1Score(h);
    var p2 = calcPath2Score(g);
    var p3 = calcPath3Score(w);
    var total = Math.round(p1 * W.height + p2 * W.green + p3 * W.walk);
    return { total: total, p1: p1, p2: p2, p3: p3 };
  }

  function getGrade(score) {
  if (score >= 65) return { grade: 'A', text: 'A · 优秀', cls: 'grade-A' };
  if (score >= 50) return { grade: 'B', text: 'B · 良好', cls: 'grade-B' };
  if (score >= 35) return { grade: 'C', text: 'C · 一般', cls: 'grade-C' };
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

    parts.push('低碳综合指数' + balance + '，综合建筑高度、绿地覆盖、慢行替代与绿地保留状态计算');

    if (total >= 65) {
    parts.push('低碳规划综合得分' + total + '分，属于优秀水平，三条路径的协同效应显著。');
  } else if (total >= 50) {
    parts.push('低碳规划综合得分' + total + '分，还有优化空间，建议在保持建筑高度约束的同时，进一步提升绿地覆盖率。');
  } else if (total >= 35) {
    parts.push('低碳规划综合得分' + total + '分，处于一般水平，建议加强绿地建设和建筑高度管控。');
  } else {
    parts.push('低碳规划综合得分' + total + '分，需改善，建议收紧建筑高度约束并大幅提升绿地覆盖率。');
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
    if (result.total < 35) scoreValue.classList.add('danger');
  else if (result.total < 50) scoreValue.classList.add('warning');

    scoreGrade.textContent = grade.text;
    scoreGrade.className = 'score-grade ' + grade.cls;

    path1Score.textContent = result.p1;
    path2Score.textContent = result.p2;
    path3Score.textContent = result.p3;
    bar1.style.width = result.p1 + '%';
    bar2.style.width = result.p2 + '%';
    bar3.style.width = result.p3 + '%';

    path1Score.className = 'path-score' + (result.p1 < 35 ? ' danger' : result.p1 < 50 ? ' warning' : '');
  path2Score.className = 'path-score' + (result.p2 < 35 ? ' danger' : result.p2 < 50 ? ' warning' : '');
  path3Score.className = 'path-score' + (result.p3 < 35 ? ' danger' : result.p3 < 50 ? ' warning' : '');

    narrativeText.textContent = generateNarrative(state.height, state.green, state.walk, result);

    var activeCarbon = getActiveCarbonTotal();
    var fullCarbon = getFullCarbonTotal();
    carbonTotalEl.textContent = fullCarbon.toFixed(2) + ' tCO₂/yr';
    carbonRemovedEl.textContent = activeCarbon.toFixed(2) + ' tCO₂/yr';
    // 顶部"古典园林总碳汇"卡片应显示全部八园的理论总碳汇，不受移除状态影响
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
    updateCompareChart(calcTotalScore(24, 40, 45));
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
    // 固定场景使用calcFixedScore，不受园林开关影响
    var baseline = calcFixedScore(24, 40, 45);
    var garden = calcFixedScore(18, 55, 60);
    var balance = calcFixedScore(30, 50, 55);

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
        data: ['现状', '生态园林', '平衡发展', '当前'],
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
                'https://t2.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=fdca189eef5b2c96af2ccfa48ec0a61c',
                'https://t3.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=fdca189eef5b2c96af2ccfa48ec0a61c'
              ],
              tileSize: 256,
              attribution: '© <a href="https://www.tianditu.gov.cn" target="_blank">天地图</a>'
            },
            'tianditu-cva': {
              type: 'raster',
              tiles: [
                'https://t0.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t1.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=a213949ecad632af1d729bdcdce04767',
                'https://t2.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=fdca189eef5b2c96af2ccfa48ec0a61c',
                'https://t3.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=fdca189eef5b2c96af2ccfa48ec0a61c'
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
      sourceData.gardens = data; phase1Done(err, '古典园林');
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
                paint: { 'raster-opacity': 0.25, 'raster-fade-duration': 0, 'raster-saturation': 0.55, 'raster-contrast': 0.55 }
              });
            }
            // 确保古典园林图层始终置顶
            if (map.getLayer('cold-island-overlay')) map.moveLayer('cold-island-overlay', 'gardens-fill');
            if (map.getLayer('gardens-fill')) map.moveLayer('gardens-fill');
            if (map.getLayer('gardens-line')) map.moveLayer('gardens-line');
            updateTemperatureLayer();
          }
        }
      }, 15000);

      // Load contour data (isotherm lines) - 坐标已在WGS84
      // 使用MapLibre内置URL加载，避免JSON.parse阻塞主线程
      if (!map.getSource('contours')) {
        map.addSource('contours', {
          type: 'geojson',
          data: dataBasePath + 'lst_contours_2degC.json?_cb=' + ASSET_VERSION
        });
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
              32, '#3A6EA5',
              36, '#5A8EB5',
                  40, '#90B090',
                  44, '#D4C840',
                  48, '#E08030',
                  52, '#D04028',
                  56, '#B82820'
                ],
                'line-width': [
                  'interpolate', ['linear'], ['get', 't'],
                  32, 2.8,
                  36, 2.5,
                  40, 2.0,
                  44, 1.7,
                  48, 1.4,
                  52, 1.2,
                  56, 1.0
                ],
                'line-opacity': 0.92
              }
            });
          }
          updateContourLayer();
          updateLayerVisibility();

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

  // GCJ-02 → WGS-84 坐标转换（温度栅格bounds为GCJ-02，天地图底图需WGS-84）
  // 使用迭代法求逆变换：先WGS84→GCJ-02，再反向偏移
  function gcj02ToWgs84(lng, lat) {
    var a = 6378245.0;
    var ee = 0.00669342162296594323;
    function _transformLat(x, y) {
      var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
      ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
      ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
      return ret;
    }
    function _transformLng(x, y) {
      var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
      ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
      ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
      return ret;
    }
    function _delta(lon, lat) {
      var dLat = _transformLat(lon - 105.0, lat - 35.0);
      var dLng = _transformLng(lon - 105.0, lat - 35.0);
      var radLat = lat / 180.0 * Math.PI;
      var magic = Math.sin(radLat);
      magic = 1 - ee * magic * magic;
      var sqrtMagic = Math.sqrt(magic);
      dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
      dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
      return [dLng, dLat];
    }
    // 逆变换：WGS84 = GCJ-02 - delta(GCJ-02)
    var d = _delta(lng, lat);
    return [lng - d[0], lat - d[1]];
  }

  function addImageSource(name, url, bounds) {
    if (!map.getSource(name)) {
      // 温度栅格Bounds为GCJ-02，天地图底图需WGS-84；逆变换后补30m微调
      var sw = gcj02ToWgs84(bounds.southWest[0], bounds.southWest[1]);
      var ne = gcj02ToWgs84(bounds.northEast[0], bounds.northEast[1]);
      var nw = gcj02ToWgs84(bounds.southWest[0], bounds.northEast[1]);
      var se = gcj02ToWgs84(bounds.northEast[0], bounds.southWest[1]);
      // 微调：补30m西南偏移（苏州纬度下 ≈ 0.00032°经度, 0.00027°纬度）
      var FINE_LON = 0.00064;  // 累计西向60m
      var FINE_LAT = 0.00194;  // 南向215m
      sw[0] -= FINE_LON; ne[0] -= FINE_LON;
      nw[0] -= FINE_LON; se[0] -= FINE_LON;
      sw[1] -= FINE_LAT; ne[1] -= FINE_LAT;
      nw[1] -= FINE_LAT; se[1] -= FINE_LAT;
      map.addSource(name, {
        type: 'image',
        url: url,
        coordinates: [
          [nw[0], nw[1]],
          [ne[0], ne[1]],
          [se[0], se[1]],
          [sw[0], sw[1]]
        ]
      });
    }
  }

  function buildAllLayers() {
    // ============================================================
    // Layer order (bottom → top): 底图 → 边界 → 古城轮廓 → 3D建筑
    //   → 慢行网络 → 地表温度(25%透明) → 等温线 → 古典园林
    // ============================================================

    // --- Layer 1: Boundary (bottom) ---
    addGeoJSONSource('boundary', sourceData.boundary);
    map.addLayer({
      id: 'boundary-fill',
      type: 'fill',
      source: 'boundary',
      paint: { 'fill-color': '#4A6741', 'fill-opacity': 0.05 }
    });
    map.addLayer({
      id: 'boundary-line',
      type: 'line',
      source: 'boundary',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#4A6741', 'line-width': 2.5, 'line-dasharray': [4, 3], 'line-opacity': 0.7 }
    });

    // --- Layer 2: Old city (outline only, no fill) ---
    addGeoJSONSource('oldCity', sourceData.oldCity);
    map.addLayer({
      id: 'oldCity-line',
      type: 'line',
      source: 'oldCity',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#8B6E5A', 'line-width': 2.5, 'line-dasharray': [4, 3], 'line-opacity': 0.8 }
    });

    // --- Layer 3: 3D Buildings ---
    var buildingPlaceholder = sourceData.buildings || { type: 'FeatureCollection', features: [] };
    addGeoJSONSource('buildings', buildingPlaceholder);

    // 14色渐变: 低→高 #FEF7D0 → #46053F
    var buildingColorRamp = [
      'interpolate', ['linear'], ['get', 'height'],
      5,  '#FEF7D0',
      8,  '#FAE6C4',
      11, '#F6D8BA',
      14, '#EFBFA7',
      17, '#E8A494',
      20, '#E38E84',
      23, '#DD7C76',
      24, '#CD5F65',
      27, '#BD5160',
      30, '#A23B59',
      33, '#82264F',
      36, '#711D49',
      40, '#570E40',
      43, '#46053F'
    ];

    // 古城内建筑
    map.addLayer({
      id: 'buildings-3d-inner',
      type: 'fill-extrusion',
      source: 'buildings',
      filter: ['==', ['get', 'inOldCity'], true],
      minzoom: 11,
      paint: {
        'fill-extrusion-color': buildingColorRamp,
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85,
        'fill-extrusion-vertical-gradient': true
      }
    });

    // 古城外建筑
    map.addLayer({
      id: 'buildings-3d-outer',
      type: 'fill-extrusion',
      source: 'buildings',
      filter: ['!=', ['get', 'inOldCity'], true],
      minzoom: 11,
      paint: {
        'fill-extrusion-color': buildingColorRamp,
        'fill-extrusion-height': ['*', ['get', 'height'], 1.3],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.7,
        'fill-extrusion-vertical-gradient': true
      }
    });

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

    // --- Layer 4: Slow travel network ---
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

    // --- Layer 5: Temperature raster (25% opacity) ---
    // 使用预着色PNG + raster-hue-rotate实现色温动态调整
    if (sourceData.lstBounds) {
      addImageSource('temperature-overlay', dataBasePath + 'lst_temperature.png?_cb=' + ASSET_VERSION, sourceData.lstBounds);
      map.addLayer({
        id: 'temperature-layer',
        type: 'raster',
        source: 'temperature-overlay',
        paint: {
          'raster-opacity': 0.25,
          'raster-fade-duration': 0,
          'raster-saturation': 0.55,
          'raster-contrast': 0.55
        }
      });
    }

    // --- Layer 6: Isotherm contours ---
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
            32, '#3A6EA5',
            36, '#5A8EB5',
            40, '#90B090',
            44, '#D4C840',
            48, '#E08030',
            52, '#D04028',
            56, '#B82820'
          ],
          'line-width': [
            'interpolate', ['linear'], ['get', 't'],
            32, 2.8,
            36, 2.5,
            40, 2.0,
            44, 1.7,
            48, 1.4,
            52, 1.2,
            56, 1.0
          ],
          'line-opacity': 0.92
        }
      });
    }

    // --- Layer 7: Gardens (top) ---
    state.gardens = sourceData.gardens.features.map(function(f) {
      return {
        name: f.properties.name,
        area_ha: f.properties.area_ha,
        area_m2: f.properties.area_m2,
        carbon_ton: f.properties.carbon_ton,
        npp_kgC_m2: f.properties.npp_kgC_m2,
        world_heritage: f.properties.world_heritage,
        cool_delta: f.properties.cool_delta,
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

    // --- 冷岛叠加层：园林关闭时在对应位置显示暖色覆盖 ---
    // 生成每个园林的冷岛缓冲区多边形（半径和颜色深度正比于冷岛强度）
    var maxCoolDelta = Math.max.apply(null, state.gardens.map(function(g) { return Math.max(0, g.cool_delta || 0); }));
    state.coldIslandBuffers = {};
    state.gardens.forEach(function(g) {
      var cd = Math.max(0, g.cool_delta || 0);
      if (cd > 0 && maxCoolDelta > 0) {
        var ratio = cd / maxCoolDelta;
        var radius = LIT.coolDistanceDecay * (0.4 + 0.6 * ratio);
        state.coldIslandBuffers[g.name] = generateColdIslandBuffer(g.lon, g.lat, radius);
      } else {
        state.coldIslandBuffers[g.name] = null;
      }
    });
    // 初始全部园林开启，冷岛叠加层为空
    map.addSource('cold-island-overlay-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'cold-island-overlay',
      type: 'fill',
      source: 'cold-island-overlay-source',
      paint: {
        'fill-color': '#E05030',
        'fill-opacity': ['*', 0.28, ['/', ['get', 'cool_delta'], maxCoolDelta || 1]],
        'fill-outline-color': 'transparent'
      }
    });
    // 确保冷岛覆盖层在温度图层之上、园林填充层之下
    if (map.getLayer('gardens-fill')) map.moveLayer('cold-island-overlay', 'gardens-fill');

    map.on('click', 'gardens-fill', function(e) {
      if (!e.features || !e.features.length) return;
      var name = e.features[0].properties.name;
      var garden = state.gardens.find(function(g) { return g.name === name; });
      if (garden) openGardenCard(garden);
    });
    map.on('mouseenter', 'gardens-fill', function() { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'gardens-fill', function() { map.getCanvas().style.cursor = ''; });

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
    var maxRadius = 400 + Math.pow(state.walk / 90, 1.8) * 1400;
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
    // 等温线按温度阈值差异化响应绿地覆盖率 + 园林冷岛效应
    // 绿地覆盖率↑ / 园林保留 → 低温等温线更明显，高温等温线消退
    // 绿地覆盖率↓ / 园林移除 → 高温等温线更明显，低温等温线消退
    if (!map.getLayer('temperature-contours')) return;
    var g = state.green;
    var baseline = 40;
    var greenRatio = (g - baseline) / baseline;

    // 园林冷岛效应：移除园林→冷岛消失→等温线应偏向高温
    var totalColdIsland = 0, activeColdIsland = 0;
    state.gardens.forEach(function(garden) {
      var ci = Math.abs(garden.cool_delta || 0);
      totalColdIsland += ci;
      if (state.activeGardens[garden.name]) activeColdIsland += ci;
    });
    var coldIslandRatio = totalColdIsland > 0 ? activeColdIsland / totalColdIsland : 1;
    // 冷岛比率越低(移除越多园林) → 效果等同于绿地覆盖率降低
    var coldFactor = (coldIslandRatio - 1) * 0.6; // 范围: -0.6 ~ 0
    var combinedRatio = greenRatio + coldFactor;

    // 计算各温度阈值对应的线宽和透明度
    // 绿地多→低温线加粗加亮，高温线变细变淡
    // 绿地少→高温线加粗加亮，低温线变细变淡
    var t32w = 2.8 * (1.0 + combinedRatio * 1.5);   // 32°C: 绿地多→更粗
    var t36w = 2.5 * (1.0 + combinedRatio * 1.2);
    var t40w = 2.0 * (1.0 + combinedRatio * 0.8);
    var t44w = 1.7 * (1.0 - combinedRatio * 0.5);   // 中间温度基本不变
    var t48w = 1.4 * (1.0 - combinedRatio * 1.0);
    var t52w = 1.2 * (1.0 - combinedRatio * 1.3);
    var t56w = 1.0 * (1.0 - combinedRatio * 1.5);   // 56°C: 绿地多→更细

    var t32o = 0.92 * (1.0 + combinedRatio * 0.8);  // 32°C: 绿地多→更亮
    var t36o = 0.92 * (1.0 + combinedRatio * 0.6);
    var t40o = 0.92 * (1.0 + combinedRatio * 0.3);
    var t44o = 0.92;
    var t48o = 0.92 * (1.0 - combinedRatio * 0.5);
    var t52o = 0.92 * (1.0 - combinedRatio * 0.7);
    var t56o = 0.92 * (1.0 - combinedRatio * 0.8);  // 56°C: 绿地多→更淡

    // 钳制到合理范围
    var clampW = function(v) { return Math.max(0.3, Math.min(5.0, v)); };
    var clampO = function(v) { return Math.max(0.15, Math.min(1.0, v)); };

    map.setPaintProperty('temperature-contours', 'line-width', [
      'interpolate', ['linear'], ['get', 't'],
      32, clampW(t32w), 36, clampW(t36w), 40, clampW(t40w),
      44, clampW(t44w), 48, clampW(t48w), 52, clampW(t52w), 56, clampW(t56w)
    ]);

    map.setPaintProperty('temperature-contours', 'line-opacity', [
      'interpolate', ['linear'], ['get', 't'],
      32, clampO(t32o), 36, clampO(t36o), 40, clampO(t40o),
      44, clampO(t44o), 48, clampO(t48o), 52, clampO(t52o), 56, clampO(t56o)
    ]);
  }

  function updateBuildings() {
    if (!map.getLayer('buildings-3d-inner')) return;
    // 高度约束滑块：统一缩放古城内所有建筑
    // 基准24m → scaleFactor = state.height / 24
    // 滑块调到12m → 所有建筑缩放到50%
    // 滑块调到36m → 所有建筑放大到150%
    var scaleFactor = state.height / 24;
    map.setPaintProperty('buildings-3d-inner', 'fill-extrusion-height', [
      '*', ['get', 'height'], scaleFactor
    ]);
    map.setPaintProperty('buildings-3d-outer', 'fill-extrusion-height', [
      '*', ['get', 'height'], 1.3
    ]);
  }

  function updateTemperatureLayer() {
    // 绿地覆盖率影响色温 + 园林冷岛效应
    // 绿地覆盖率↓ → 偏红(升温), 绿地覆盖率↑ → 偏蓝(降温)
    // 园林移除 → 冷岛消失 → 偏红(升温)
    if (!map.getLayer('temperature-layer')) return;
    var g = state.green;
    var baseline = 40;
    var greenRatio = (g - baseline) / baseline;

    // 绿地覆盖率调节：反向（用户要求）
    var hueRotate = greenRatio * 30;

    // 园林冷岛效应：移除园林→升温
    var totalColdIsland = 0, activeColdIsland = 0;
    state.gardens.forEach(function(garden) {
      var ci = Math.abs(garden.cool_delta || 0);
      totalColdIsland += ci;
      if (state.activeGardens[garden.name]) activeColdIsland += ci;
    });
    var coldIslandRatio = totalColdIsland > 0 ? activeColdIsland / totalColdIsland : 1;
    // 冷岛比率越低(移除越多园林) → 越偏红
    hueRotate += (1 - coldIslandRatio) * 25;

    hueRotate = Math.max(-35, Math.min(35, hueRotate));

    map.setPaintProperty('temperature-layer', 'raster-hue-rotate', hueRotate);
    map.setPaintProperty('temperature-layer', 'raster-opacity', 0.25);
    map.setPaintProperty('temperature-layer', 'raster-saturation', 0.55);
    map.setPaintProperty('temperature-layer', 'raster-contrast', 0.55);
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

    // 冷岛叠加层：关闭的园林 → 显示暖色覆盖
    updateColdIslandOverlay();
  }

  function updateColdIslandOverlay() {
    if (!map.getSource('cold-island-overlay-source')) return;
    var features = [];
    state.gardens.forEach(function(g) {
      if (!state.activeGardens[g.name] && g.cool_delta > 0 && state.coldIslandBuffers[g.name]) {
        features.push({
          type: 'Feature',
          properties: { name: g.name, cool_delta: g.cool_delta },
          geometry: state.coldIslandBuffers[g.name]
        });
      }
    });
    map.getSource('cold-island-overlay-source').setData({
      type: 'FeatureCollection',
      features: features
    });
  }

  function updateLayerVisibility() {
    var v = state.layerVisible;
    var layers = {
      'boundary-line': v.boundary,
      'boundary-fill': v.boundary,
      'oldCity-line': v.oldcity,
      'gardens-fill': v.gardens,
      'gardens-line': v.gardens,
      'temperature-layer': v.temperature,
      'temperature-contours': v.contours,
      'cold-island-overlay': v.temperature,
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
    if (params.g) state.green = Math.max(20, Math.min(70, parseInt(params.g) || 40));
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
