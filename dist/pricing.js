// All calculations stay within one SKU and one offer's observation stream.
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const chinaDay = timestamp => new Date(Date.parse(timestamp) + 8 * 3600000).toISOString().slice(0, 10);
const ordered = samples => (samples || []).filter(sample =>
  Number.isFinite(sample.price) && sample.price >= 0 && Number.isFinite(Date.parse(sample.timestamp))
).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

export function effectivePrice(offer) {
  if (!offer?.eligible) return null;
  const amounts = [offer.labelPrice, offer.coupon ?? 0, offer.shipping ?? 0];
  if (amounts.some(value => !Number.isFinite(value) || value < 0)) return null;
  const price = amounts[0] - amounts[1] + amounts[2];
  return price >= 0 ? round(price) : null;
}

// Ineligible offers remain visible at the end, but cannot win the ranking.
export function getOffers(product) {
  return (product?.offers || []).slice().sort((a, b) =>
    (effectivePrice(a) ?? Infinity) - (effectivePrice(b) ?? Infinity)
  );
}

export function getOffer(product, offerId) {
  const selected = product?.offers?.find(offer => offer.id === offerId);
  if (selected && effectivePrice(selected) !== null) return selected;
  return getOffers(product).find(offer => effectivePrice(offer) !== null) || null;
}

export function getHistory(product, offerId) {
  const offer = getOffer(product, offerId);
  return offer ? product.histories?.[offer.id] || [] : [];
}

export function aggregateCandles(samples, period = 'day') {
  if (!['day', 'week', 'month'].includes(period)) throw new RangeError('Unsupported candle period');
  const buckets = new Map();
  for (const sample of ordered(samples)) {
    let time = chinaDay(sample.timestamp);
    if (period === 'week') {
      const day = new Date(`${time}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
      time = day.toISOString().slice(0, 10);
    } else if (period === 'month') time = `${time.slice(0, 7)}-01`;
    const candle = buckets.get(time);
    if (candle) {
      candle.high = Math.max(candle.high, sample.price);
      candle.low = Math.min(candle.low, sample.price);
      candle.close = sample.price;
      candle.count += 1;
    } else buckets.set(time, { time, open: sample.price, high: sample.price, low: sample.price, close: sample.price, count: 1 });
  }
  // Missing calendar days have no bucket: no interpolation or invented OHLC.
  return [...buckets.values()];
}

export function summarize(samples) {
  const values = ordered(samples);
  if (!values.length) return {
    current: null, low: null, high: null, average: null, percentile: null,
    change: null, changePercent: null, sampleCount: 0, dayCount: 0, start: null, end: null,
  };
  const prices = values.map(sample => sample.price);
  const current = prices.at(-1);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const days = aggregateCandles(values);
  const previous = days.length > 1 ? days.at(-2).close : null;
  // Empirical observation rank, not a linear min/max position. Flat streams rank 0.
  const percentile = current === low ? 0 : current === high ? 100
    : round(prices.filter(price => price < current).length / prices.length * 100);
  return {
    current, low, high, average: round(prices.reduce((sum, price) => sum + price, 0) / prices.length),
    percentile, change: previous === null ? null : round(current - previous),
    changePercent: previous === null || previous === 0 ? null : round((current - previous) / previous * 100),
    sampleCount: values.length, dayCount: days.length,
    start: values[0].timestamp, end: values.at(-1).timestamp,
  };
}

export function evaluatePrice(samples, target) {
  const stats = summarize(samples);
  if (stats.current === null) return { label: '记录不足', description: '还没有可比较的价格记录。', tone: 'neutral' };
  if (Number.isFinite(target) && target > 0 && stats.current <= target) return {
    label: '已达到目标价', description: '当前记录价已达到你设置的目标；请核对优惠条件。只比较已有记录，不预测后续价格。', tone: 'positive',
  };
  if (stats.dayCount < 7) return {
    label: '记录不足', description: '至少需要 7 个不同日期的价格记录，才能判断历史价格位置；目前只展示已有记录，不预测后续价格。', tone: 'neutral',
  };
  if (stats.current <= stats.low * 1.02) return {
    label: '接近记录低价', description: '当前价距这段记录中的最低价不超过 2%。这只是历史比较，不预测后续价格。', tone: 'positive',
  };
  if (stats.percentile <= 20) return {
    label: '处于低价区间', description: '当前价位于这段记录的较低 20% 区间。仅依据已有样本，不预测后续价格。', tone: 'positive',
  };
  if (stats.percentile >= 80) return {
    label: '处于较高价区间', description: '当前价高于或等于这段记录中较多的观测价。可以结合预算判断，记录不能预测下一次降价。', tone: 'warning',
  };
  return { label: '处于常见价格区间', description: '当前价处于这段记录的中间区间。仅作历史对照，不构成涨跌预测。', tone: 'neutral' };
}
