import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCTS } from './fixtures.demo.js';
import { effectivePrice, getOffer, getOffers, getHistory, aggregateCandles, summarize, evaluatePrice } from '../dist/pricing.js';

const point = (day, price, hour = '18') => ({ timestamp: `${day}T${hour}:00:00+08:00`, price });

test('unavailable coupons never become an available lowest price', () => {
  const product = { offers: [
    { id: 'locked', labelPrice: 100, coupon: 90, shipping: 0, eligible: false },
    { id: 'shipping', labelPrice: 100, coupon: 20, shipping: 15, eligible: true },
    { id: 'best', labelPrice: 100, coupon: 10, shipping: 0, eligible: true },
  ] };
  assert.equal(effectivePrice(product.offers[0]), null);
  assert.equal(effectivePrice(product.offers[1]), 95);
  assert.deepEqual(getOffers(product).map(offer => offer.id), ['best', 'shipping', 'locked']);
  assert.equal(getOffer(product).id, 'best');
  assert.equal(getOffer(product, 'locked').id, 'best');
});

test('selected offers retain separate price streams', () => {
  const product = { offers: [
    { id: 'a', labelPrice: 100, coupon: 0, shipping: 0, eligible: true },
    { id: 'b', labelPrice: 10, coupon: 0, shipping: 0, eligible: true },
  ], histories: { a: [point('2026-11-10', 100)], b: [point('2026-11-10', 10)] } };
  assert.deepEqual(getHistory(product, 'a'), [point('2026-11-10', 100)]);
  assert.equal(summarize(getHistory(product, 'a')).current, 100);
  assert.equal(summarize(getHistory(product, 'b')).current, 10);
});

test('daily candles use all actual observations in China time and preserve missing days', () => {
  const samples = [point('2026-11-09', 92, '18'), point('2026-11-09', 100, '09'),
    point('2026-11-09', 110, '12'), point('2026-11-09', 80, '15'), point('2026-11-11', 95)];
  assert.deepEqual(aggregateCandles(samples), [
    { time: '2026-11-09', open: 100, high: 110, low: 80, close: 92, count: 4 },
    { time: '2026-11-11', open: 95, high: 95, low: 95, close: 95, count: 1 },
  ]);
  assert.equal(aggregateCandles([{ timestamp: '2026-11-10T17:00:00Z', price: 12 }])[0].time, '2026-11-11');
});

test('weekly candles start on Monday across month boundaries', () => {
  assert.deepEqual(aggregateCandles([
    point('2026-08-31', 100), point('2026-09-01', 110),
    point('2026-09-06', 90), point('2026-09-07', 95),
  ], 'week'), [
    { time: '2026-08-31', open: 100, high: 110, low: 90, close: 90, count: 3 },
    { time: '2026-09-07', open: 95, high: 95, low: 95, close: 95, count: 1 },
  ]);
});

test('monthly candles use China-time month boundaries, chronological OHLC and retain missing months', () => {
  assert.deepEqual(aggregateCandles([
    { timestamp: '2027-01-31T16:00:00Z', price: 95 },
    { timestamp: '2026-12-31T16:00:00Z', price: 110 },
    { timestamp: '2026-12-31T15:59:59Z', price: 100 },
    { timestamp: '2027-01-15T09:00:00+08:00', price: 80 },
    { timestamp: '2027-01-31T15:59:59Z', price: 90 },
    { timestamp: '2027-04-01T00:00:00+08:00', price: 85 },
  ], 'month'), [
    { time: '2026-12-01', open: 100, high: 100, low: 100, close: 100, count: 1 },
    { time: '2027-01-01', open: 110, high: 110, low: 80, close: 90, count: 3 },
    { time: '2027-02-01', open: 95, high: 95, low: 95, close: 95, count: 1 },
    { time: '2027-04-01', open: 85, high: 85, low: 85, close: 85, count: 1 },
  ]);
});

test('summary ranks observations and compares the prior observed day close', () => {
  assert.deepEqual(summarize([
    point('2026-11-09', 120, '09'), point('2026-11-09', 80),
    point('2026-11-11', 100, '09'), point('2026-11-11', 110),
  ]), {
    current: 110, low: 80, high: 120, average: 102.5, percentile: 50,
    change: 30, changePercent: 37.5, sampleCount: 4, dayCount: 2,
    start: '2026-11-09T09:00:00+08:00', end: '2026-11-11T18:00:00+08:00',
  });
  assert.equal(summarize([point('2026-11-11', 20)]).change, null);
  assert.equal(summarize([]).current, null);
  assert.equal(evaluatePrice([point('2026-11-10', 200), point('2026-11-11', 100)], 110).tone, 'positive');
});

test('a historical low judgment requires seven distinct observed days, but target hits do not', () => {
  const oneDay = [point('2026-11-11', 200, '09'), point('2026-11-11', 100)];
  assert.deepEqual(evaluatePrice(oneDay).label, '记录不足');
  assert.equal(evaluatePrice(oneDay).tone, 'neutral');
  assert.equal(evaluatePrice(oneDay, 110).tone, 'positive');
  const sixDays = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'].map((day, i) => point(day, 200 - i * 10));
  assert.equal(evaluatePrice(sixDays).label, '记录不足');
  assert.equal(evaluatePrice([point('2026-11-05', 210), ...sixDays]).tone, 'positive');
});

test('demo histories use bounded distinct streams, real gaps, and four samples per observed day', () => {
  const latestAllowed = Date.parse('2026-11-11T18:00:00+08:00');
  assert.ok(PRODUCTS.length >= 8);
  for (const product of PRODUCTS) {
    assert.equal(product.sourceMode, 'demo');
    const histories = product.offers.map(offer => product.histories[offer.id]);
    assert.equal(new Set(histories).size, product.offers.length);
    for (const offer of product.offers) {
      const samples = product.histories[offer.id];
      assert.ok(samples.length > 300 && samples.length < 360);
      assert.ok(samples.every(sample => Date.parse(sample.timestamp) <= latestAllowed));
      const days = aggregateCandles(samples);
      assert.ok(days.every(day => day.count === 4));
      assert.ok(days.some((day, index) => index && Date.parse(day.time) - Date.parse(days[index - 1].time) > 86400000));
      if (offer.eligible) assert.equal(samples.at(-1).price, effectivePrice(offer));
    }
  }
  assert.equal(summarize(getHistory(PRODUCTS[0], PRODUCTS[0].offers[0].id)).low, 2799);
  assert.equal(summarize(getHistory(PRODUCTS[0], PRODUCTS[0].offers[0].id)).current, 2899);
});
