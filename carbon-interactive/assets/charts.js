// assets/charts.js — 典型工业镇与古城季度碳排放交互图表
// 数据来自 assets/data.js（与 chart_quarterly.py 完全一致）
(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = '#FFFFFF';

  var fontFamily = '"Noto Serif SC","Source Han Serif SC","STSong","SimSun",serif';

  // ===== X轴标签：仅Q1显示，单行"2019年第一季度" =====
  var num2cn = {'1':'一','2':'二','3':'三','4':'四'};
  var xLabels = QUARTERS.map(function(q) {
    var m = q.match(/^(\d{4})年(.)季度$/);
    if (m && m[2] === '一') {
      return m[1] + '年第一季度';
    }
    return '';
  });

  // ===== 通用 tooltip =====
  function makeTooltip(unit) {
    return {
      trigger: 'axis',
      appendToBody: true,
      backgroundColor: bg2,
      borderColor: rule,
      borderWidth: 1,
      textStyle: { color: ink, fontSize: 13, fontFamily: fontFamily },
      formatter: function(params) {
        var title = '<strong>' + params[0].axisValue + '</strong>';
        var items = params.map(function(p) {
          var dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + p.color + ';margin-right:6px;"></span>';
          return dot + p.seriesName + '：<strong>' + Number(p.value).toFixed(1) + '</strong> ' + unit;
        });
        return title + '<br/>' + items.join('<br/>');
      }
    };
  }

  var gridCommon = { left: '5%', right: '8%', top: 50, bottom: 60 };

  // ===== 工业镇 endLabel 偏移（避免重叠） =====
  var indEndOffsets = {
    "碧溪": [8, 8],
    "塘桥": [8, -8],
    "南丰": [8, 12],
    "金港": [8, -12]
  };

  // ===== 图表1：工业镇 =====
  var chartInd = echarts.init(document.getElementById('chart-industrial'), null, { renderer: 'svg' });

  var indSeries = IND_NAMES.map(function(name, i) {
    var off = indEndOffsets[name] || [8, 0];
    return {
      name: name,
      type: 'line',
      data: IND_DATA[name],
      lineStyle: { width: 2, type: 'dashed' },
      itemStyle: { color: IND_COLORS[i] },
      symbol: 'none',
      z: 2,
      endLabel: {
        show: true,
        formatter: name,
        offset: off,
        color: IND_COLORS[i],
        fontWeight: 'bold',
        fontSize: 11,
        fontFamily: fontFamily
      }
    };
  });

  indSeries.push({
    name: '均值',
    type: 'line',
    data: IND_MEAN,
    lineStyle: { width: 3.5, color: accent },
    itemStyle: { color: accent },
    symbol: 'diamond',
    symbolSize: 9,
    z: 5,
    label: {
      show: true,
      position: 'top',
      formatter: function(p) { return Number(p.value).toFixed(0); },
      fontSize: 9,
      color: accent,
      fontWeight: 'bold',
      fontFamily: fontFamily,
      distance: 10
    }
  });

  chartInd.setOption({
    animation: false,
    tooltip: makeTooltip('tCO₂'),
    grid: gridCommon,
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLine: { lineStyle: { color: rule } },
      axisTick: {
        show: true,
        lineStyle: { color: rule }
      },
      axisLabel: {
        color: ink,
        fontSize: 11,
        fontFamily: fontFamily,
        interval: 0,
        rotate: 0
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      name: 'tCO₂/季度',
      nameLocation: 'middle',
      nameGap: 40,
      nameTextStyle: { color: accent, fontSize: 12, fontWeight: 'bold', fontFamily: fontFamily },
      min: 0,
      max: 850,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: rule, type: 'dashed', opacity: 0.4 } },
      axisLabel: { color: muted, fontSize: 10, fontFamily: fontFamily }
    },
    series: indSeries,
    legend: {
      show: true,
      bottom: 8,
      textStyle: { color: ink, fontSize: 11, fontFamily: fontFamily },
      itemWidth: 20,
      itemHeight: 10,
      itemGap: 14
    }
  });

  // ===== 图表2：古城 =====
  var chartGar = echarts.init(document.getElementById('chart-garden'), null, { renderer: 'svg' });

  var garEndOffsets = {
    "双塔": [8, 6],
    "沧浪": [8, -6]
  };

  var garSeries = GAR_NAMES.map(function(name, i) {
    var off = garEndOffsets[name] || [8, 0];
    return {
      name: name,
      type: 'line',
      data: GAR_DATA[name],
      lineStyle: { width: 1.8, type: 'dashed' },
      itemStyle: { color: GAR_COLORS[i] },
      symbol: 'none',
      z: 2,
      endLabel: {
        show: true,
        formatter: name,
        offset: off,
        color: GAR_COLORS[i],
        fontSize: 11,
        fontFamily: fontFamily
      }
    };
  });

  garSeries.push({
    name: '均值',
    type: 'line',
    data: GAR_MEAN,
    lineStyle: { width: 3.5, color: accent2 },
    itemStyle: { color: accent2 },
    symbol: 'square',
    symbolSize: 9,
    z: 5,
    label: {
      show: true,
      position: 'top',
      formatter: function(p) { return Number(p.value).toFixed(1); },
      fontSize: 9,
      color: accent2,
      fontWeight: 'bold',
      fontFamily: fontFamily,
      distance: 10
    }
  });

  chartGar.setOption({
    animation: false,
    tooltip: makeTooltip('tCO₂'),
    grid: gridCommon,
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLine: { lineStyle: { color: rule } },
      axisTick: {
        show: true,
        lineStyle: { color: rule }
      },
      axisLabel: {
        color: ink,
        fontSize: 11,
        fontFamily: fontFamily,
        interval: 0,
        rotate: 0
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      name: 'tCO₂/季度',
      nameLocation: 'middle',
      nameGap: 40,
      nameTextStyle: { color: accent2, fontSize: 12, fontWeight: 'bold', fontFamily: fontFamily },
      min: 0,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: rule, type: 'dashed', opacity: 0.4 } },
      axisLabel: { color: muted, fontSize: 10, fontFamily: fontFamily }
    },
    series: garSeries,
    legend: {
      show: true,
      bottom: 8,
      textStyle: { color: ink, fontSize: 11, fontFamily: fontFamily },
      itemWidth: 20,
      itemHeight: 10,
      itemGap: 14
    }
  });

  // ===== 响应式 =====
  window.addEventListener('resize', function() {
    chartInd.resize();
    chartGar.resize();
  });
})();