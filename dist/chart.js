import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
} from './vendor/lightweight-charts.js';

const DAY = 86_400_000;
const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 2,
});
const priceFormat = { type: 'custom', minMove: 0.01, formatter: value => money.format(value) };

const palettes = {
  dark: { background: '#11141b', grid: '#212631', text: '#9ca3b5', crosshair: '#5d687e',
    rise: '#f07880', fall: '#41c7a1', average: '#b0a1f6', target: '#c3ef64' },
  light: { background: '#ffffff', grid: '#e9edf2', text: '#647084', crosshair: '#9aa4b4',
    rise: '#d75463', fall: '#168968', average: '#8770c8', target: '#718e16' },
};

function dayTime(time) {
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 10);
  if (time && typeof time === 'object') {
    return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
  }
  return null;
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}

function prepareCandles(candles) {
  const unique = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    if (!candle || !validDay(candle.time)) continue;
    const values = [candle.open, candle.high, candle.low, candle.close];
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) continue;
    if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)) continue;
    unique.set(candle.time, { ...candle });
  }
  return [...unique.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function nextPeriod(stamp, period) {
  if (period !== 'month') return stamp + (period === 'week' ? 7 : 1) * DAY;
  const date = new Date(stamp);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.getTime();
}

function calendarData(rows, period = 'day') {
  if (!rows.length) return [];
  const byDay = new Map(rows.map(row => [row.time, row]));
  const start = Date.parse(`${rows[0].time}T00:00:00Z`);
  const end = Date.parse(`${rows.at(-1).time}T00:00:00Z`);
  const points = [];
  for (let stamp = start; stamp <= end; stamp = nextPeriod(stamp, period)) {
    const time = new Date(stamp).toISOString().slice(0, 10);
    const row = byDay.get(time);
    points.push(row ? { time, open: row.open, high: row.high, low: row.low, close: row.close } : { time });
  }
  return points;
}

// Native line plots connect whitespace. Separate runs make missing periods real visual gaps.
function consecutiveRuns(points, period = 'day') {
  const runs = [];
  for (const point of points) {
    const previous = runs.at(-1)?.at(-1);
    if (!previous || Date.parse(point.time) !== nextPeriod(Date.parse(previous.time), period)) runs.push([]);
    runs.at(-1).push(point);
  }
  return runs;
}

export function createPriceChart(container, { onHover } = {}) {
  let rows = [];
  let rowsByDay = new Map();
  let lines = [];
  let averages = [];
  let targetLine = null;
  let targetSeries = null;
  let activeTarget = null;
  let currentRange = 90;
  let dataKey = null;
  let destroyed = false;

  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: palettes.dark.background },
      textColor: palettes.dark.text,
      fontSize: 12,
      fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif',
      attributionLogo: true,
      panes: { separatorColor: palettes.dark.grid, separatorHoverColor: '#3d4657', enableResize: false },
    },
    grid: { vertLines: { color: palettes.dark.grid }, horzLines: { color: palettes.dark.grid } },
    rightPriceScale: { borderVisible: false, minimumWidth: 82, scaleMargins: { top: 0.12, bottom: 0.12 } },
    leftPriceScale: { visible: false },
    timeScale: {
      borderVisible: false, timeVisible: false, secondsVisible: false,
      rightOffset: 3, barSpacing: 9, minBarSpacing: 2, ignoreWhitespaceIndices: false,
      lockVisibleTimeRangeOnResize: true,
    },
    localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' },
    crosshair: {
      mode: 0,
      vertLine: { color: palettes.dark.crosshair, labelBackgroundColor: '#303746', style: 2 },
      horzLine: { color: palettes.dark.crosshair, labelBackgroundColor: '#303746', style: 2 },
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    kineticScroll: { mouse: true, touch: true },
  });

  const includeTarget = original => {
    const info = original();
    if (info && activeTarget !== null) {
      info.priceRange.minValue = Math.min(info.priceRange.minValue, activeTarget);
      info.priceRange.maxValue = Math.max(info.priceRange.maxValue, activeTarget);
    }
    return info;
  };

  const candles = chart.addSeries(CandlestickSeries, {
    upColor: palettes.dark.rise, downColor: palettes.dark.fall,
    wickUpColor: palettes.dark.rise, wickDownColor: palettes.dark.fall,
    borderVisible: false, priceFormat, priceLineVisible: false,
    autoscaleInfoProvider: includeTarget,
  });
  const hover = event => {
    if (typeof onHover !== 'function') return;
    const inside = event.point && event.point.x >= 0 && event.point.y >= 0
      && event.point.x <= container.clientWidth && event.point.y <= container.clientHeight;
    onHover(inside && event.time ? (rowsByDay.get(dayTime(event.time)) ?? null) : null);
  };
  chart.subscribeCrosshairMove(hover);

  function clearTarget() {
    if (targetLine && targetSeries) targetSeries.removePriceLine(targetLine);
    targetLine = null;
    targetSeries = null;
  }

  function setRange(range) {
    if (destroyed) return;
    if (range !== 'all' && (!Number.isFinite(Number(range)) || Number(range) <= 0)) return;
    currentRange = range === 'all' ? 'all' : Math.max(1, Math.floor(Number(range)));
    if (!rows.length) return;
    if (currentRange === 'all' || rows.length === 1) {
      chart.timeScale().fitContent();
      return;
    }
    const latest = rows.at(-1).time;
    const from = new Date(Date.parse(`${latest}T00:00:00Z`) - (currentRange - 1) * DAY).toISOString().slice(0, 10);
    chart.timeScale().setVisibleRange({ from: from < rows[0].time ? rows[0].time : from, to: latest });
  }

  function addRuns(points, options, period = 'day') {
    const runs = consecutiveRuns(points, period);
    return runs.map((run, index) => {
      const series = chart.addSeries(LineSeries, {
        priceFormat, priceLineVisible: false, lineWidth: 2, title: '',
        pointMarkersVisible: true, pointMarkersRadius: 2,
        lastValueVisible: index === runs.length - 1,
        ...options,
      });
      series.setData(run);
      return series;
    });
  }

  function update({ candles: input = [], samples, mode = 'candles', period = 'day', target = null, showAverage = true, theme = 'dark' } = {}) {
    if (destroyed) return;
    // The supplied aggregation is authoritative in both modes; raw samples are not re-aggregated here.
    void samples;
    rows = prepareCandles(input);
    rowsByDay = new Map(rows.map(row => [row.time, row]));
    const nextKey = `${period}|${rows.map(row => `${row.time}/${row.open}/${row.high}/${row.low}/${row.close}/${row.count}`).join('|')}`;
    const changed = nextKey !== dataKey;
    dataKey = nextKey;
    const color = palettes[theme] ?? palettes.dark;
    const isLine = mode === 'line';
    activeTarget = typeof target === 'number' && Number.isFinite(target) && target > 0 ? target : null;

    clearTarget();
    for (const series of [...lines, ...averages]) chart.removeSeries(series);
    lines = [];
    averages = [];
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: color.background }, textColor: color.text,
        panes: { separatorColor: color.grid, separatorHoverColor: color.crosshair } },
      grid: { vertLines: { color: color.grid }, horzLines: { color: color.grid } },
      crosshair: {
        vertLine: { color: color.crosshair, labelBackgroundColor: theme === 'light' ? '#78859a' : '#303746' },
        horzLine: { color: color.crosshair, labelBackgroundColor: theme === 'light' ? '#78859a' : '#303746' },
      },
    });
    candles.applyOptions({ visible: !isLine, upColor: color.rise, downColor: color.fall,
      wickUpColor: color.rise, wickDownColor: color.fall });
    const calendar = calendarData(rows, period);
    candles.setData(calendar);
    if (isLine) {
      lines = addRuns(rows.map(row => ({ time: row.time, value: row.close })), {
        color: color.fall, autoscaleInfoProvider: includeTarget,
      }, period);
    }
    if (showAverage) {
      // MA7 means seven observed period closes; missing days, weeks or months stay absent.
      let sum = 0;
      const points = [];
      rows.forEach((row, index) => {
        sum += row.close;
        if (index >= 7) sum -= rows[index - 7].close;
        if (index >= 6) points.push({ time: row.time, value: sum / 7 });
      });
      averages = addRuns(points, { color: color.average, lineWidth: 1,
        pointMarkersVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, period);
    }
    if (activeTarget !== null && rows.length) {
      targetSeries = isLine ? lines.at(-1) : candles;
      if (targetSeries) targetLine = targetSeries.createPriceLine({
        price: activeTarget, color: color.target, lineWidth: 1, lineStyle: 1,
        axisLabelVisible: true, title: '目标价', axisLabelTextColor: theme === 'light' ? '#ffffff' : '#17210b',
      });
    }
    if (changed) setRange(currentRange);
    if (typeof onHover === 'function') onHover(null);
  }

  return {
    update,
    setRange,
    fit() { setRange('all'); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      chart.unsubscribeCrosshairMove(hover);
      chart.remove();
    },
  };
}
