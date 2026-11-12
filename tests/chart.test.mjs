import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Stub only the canvas renderer; exercise the chart's actual data/series pipeline.
function chartHarness() {
  const series = [];
  const chart = {
    addSeries(type, options) {
      const item = { type, options, data: [], setData(data) { this.data = JSON.parse(JSON.stringify(data)); }, applyOptions() {}, createPriceLine() {}, removePriceLine() {} };
      series.push(item);
      return item;
    },
    applyOptions() {}, removeSeries() {}, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, remove() {},
    timeScale() { return { fitContent() {}, setVisibleRange() {} }; },
  };
  const source = readFileSync(new URL('../dist/chart.js', import.meta.url), 'utf8')
    .replace(/^import\s*\{[\s\S]*?\}\s*from '\.\/vendor\/lightweight-charts\.js';/, '')
    .replace('export function createPriceChart', 'function createPriceChart');
  const context = vm.createContext({ createChart: () => chart, CandlestickSeries: 'candles', LineSeries: 'line', ColorType: { Solid: 'solid' } });
  vm.runInContext(source, context);
  return { series, api: context.createPriceChart({ clientWidth: 800, clientHeight: 400 }) };
}

const candle = (time, close = 100) => ({ time, open: close, high: close, low: close, close, count: 1 });

test('month charts space calendar months evenly and disconnect price lines across missing months', () => {
  const { series, api } = chartHarness();
  api.update({ candles: [candle('2025-12-01'), candle('2026-01-01'), candle('2026-03-01')], period: 'month', mode: 'line', showAverage: false });
  assert.deepEqual(series[0].data.map(row => row.time), ['2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01']);
  assert.deepEqual(series[0].data[2], { time: '2026-02-01' });
  assert.deepEqual(series.filter(item => item.type === 'line').map(item => item.data.map(row => row.time)), [
    ['2025-12-01', '2026-01-01'], ['2026-03-01'],
  ]);
});

test('monthly MA7 uses seven observed month closes and leaves missing calendar months disconnected', () => {
  const { series, api } = chartHarness();
  const times = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01', '2024-06-01', '2024-07-01', '2024-09-01'];
  api.update({ candles: times.map((time, index) => candle(time, index + 1)), period: 'month', showAverage: true });
  assert.deepEqual(series.filter(item => item.type === 'line').map(item => item.data), [
    [{ time: '2024-07-01', value: 4 }], [{ time: '2024-09-01', value: 5 }],
  ]);
  assert.equal(series[0].data.length, 9);
  assert.deepEqual(series[0].data[7], { time: '2024-08-01' });
});

test('daily and weekly chart gaps retain their existing calendar cadence', () => {
  for (const [period, times, missing] of [
    ['day', ['2026-11-09', '2026-11-10', '2026-11-12'], '2026-11-11'],
    ['week', ['2026-08-31', '2026-09-07', '2026-09-21'], '2026-09-14'],
  ]) {
    const { series, api } = chartHarness();
    api.update({ candles: times.map(time => candle(time)), period, mode: 'line', showAverage: false });
    assert.deepEqual(series[0].data.map(row => row.time), [times[0], times[1], missing, times[2]]);
    assert.deepEqual(series[0].data[2], { time: missing });
    assert.deepEqual(series.filter(item => item.type === 'line').map(item => item.data.map(row => row.time)), [times.slice(0, 2), times.slice(2)]);
  }
});
