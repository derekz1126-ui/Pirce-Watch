// Entirely synthetic fixtures. These are not retailer observations or live quotes.
export const DEMO_META = {
  sourceMode: 'demo',
  notice: '演示数据 · 所有价格、店铺与优惠均为虚构，不代表平台实价',
  timezone: 'Asia/Shanghai',
  asOf: '2026-11-11T18:00:00+08:00',
  windowStart: '2026-08-14',
  windowEnd: '2026-11-11',
  samplesPerObservedDay: 4,
};

const endDay = Date.UTC(2026, 10, 11);
const hours = ['09', '12', '15', '18'];

function makeHistory(current, initial, low, seed) {
  const samples = [];
  for (let day = 0; day < 90; day++) {
    // Deliberate collection gaps remain absent instead of being filled forward.
    if ([17, 18, 42, 65, 30 + seed % 5].includes(day)) continue;
    const date = new Date(endDay - (89 - day) * 86400000).toISOString().slice(0, 10);
    for (let slot = 0; slot < hours.length; slot++) {
      const trend = initial + (current - initial) * day / 89;
      const wave = Math.sin((day + seed) / 4.2) * current * 0.012;
      const jitter = (((day * 17 + slot * 23 + seed * 11) % 31) - 15) * Math.max(1, current / 1600);
      let price = Math.max(low + 19, Math.round((trend + wave + jitter) / 10) * 10 - 1);
      if (day === 79) price = low + [49, 29, 0, 39][slot];
      if (day === 89) price = current + [30, 10, 20, 0][slot];
      samples.push({ timestamp: `${date}T${hours[slot]}:00:00+08:00`, price });
    }
  }
  return samples;
}

function makeProduct(spec, index) {
  const offers = [
    { id: `${spec.id}-jd`, platform: 'jd', shop: '京东 · 品牌自营示例店', labelPrice: spec.price + 200, coupon: 200, shipping: 0,
      conditions: ['模拟店铺券 ¥200', '普通账户可领（演示假设）', '单件购买，不叠加地区补贴'], eligible: true },
    { id: `${spec.id}-tmall`, platform: 'tmall', shop: '天猫 · 品牌旗舰示例店', labelPrice: spec.price + 180, coupon: 150, shipping: 0,
      conditions: ['模拟店铺券 ¥150', '普通账户可领（演示假设）', '单件购买，不叠加地区补贴'], eligible: true },
    { id: `${spec.id}-taobao`, platform: 'taobao', shop: '淘宝 · 硬件示例商家', labelPrice: spec.price, coupon: 0, shipping: 20,
      conditions: ['无额外优惠券', '运费 ¥20 已计入', '单件购买，演示店铺'], eligible: true },
  ];
  if (index === 0) offers.push({
    id: `${spec.id}-new-user`, platform: 'jd', shop: '京东 · 新客优惠示例',
    labelPrice: spec.price, coupon: 400, shipping: 0,
    conditions: ['仅限新用户首单', '当前演示账户不满足条件', '不参与可用最低价比较'], eligible: false,
  });
  const histories = Object.fromEntries(offers.map((offer, offerIndex) => {
    const current = offer.labelPrice - offer.coupon + offer.shipping;
    const delta = current - spec.price;
    return [offer.id, makeHistory(current, spec.initial + delta, spec.low + delta, index * 7 + offerIndex)];
  }));
  const { price, initial, low, ...product } = spec;
  return { ...product, offers, histories, sourceMode: 'demo' };
}

export const PRODUCTS = [
  { id: 'amd-9800x3d', name: 'AMD Ryzen 7 9800X3D', subtitle: '盒装 · 8 核 16 线程 · AM5', category: '处理器', brand: 'AMD', kind: 'cpu',
    tags: ['游戏装机', 'AM5', '盒装'], price: 2899, initial: 3399, low: 2799 },
  { id: 'msi-5070ti', name: '微星 RTX 5070 Ti 16G', subtitle: 'VENTUS 3X OC · 16GB GDDR7', category: '显卡', brand: 'MSI', kind: 'gpu',
    tags: ['16GB', '三风扇', '独立显卡'], price: 6999, initial: 7799, low: 6599 },
  { id: 'samsung-990pro', name: '三星 990 PRO 2TB', subtitle: 'M.2 2280 · PCIe 4.0 ×4 · 无散热片', category: '固态硬盘', brand: 'Samsung', kind: 'ssd',
    tags: ['2TB', 'PCIe 4.0', 'M.2'], price: 1199, initial: 1499, low: 1099 },
  { id: 'gskill-ddr5', name: '芝奇 幻锋戟 DDR5 32GB', subtitle: '16GB ×2 · 6000MT/s · CL30 · 黑色', category: '内存', brand: 'G.SKILL', kind: 'ram',
    tags: ['32GB 套装', 'DDR5', '6000 CL30'], price: 849, initial: 1199, low: 799 },
  { id: 'msi-b850', name: '微星 B850M MORTAR WIFI', subtitle: '迫击炮 · mATX · AM5 · Wi-Fi', category: '主板', brand: 'MSI', kind: 'board',
    tags: ['AM5', 'mATX', 'Wi-Fi'], price: 1399, initial: 1699, low: 1299 },
  { id: 'lg-27oled', name: 'LG 27GS95QE OLED', subtitle: '27 英寸 · 2560×1440 · 240Hz', category: '显示器', brand: 'LG', kind: 'monitor',
    tags: ['OLED', '2K', '240Hz'], price: 4299, initial: 5999, low: 3999 },
  { id: 'intel-265k', name: 'Intel Core Ultra 7 265K', subtitle: '盒装 · 20 核 20 线程 · LGA1851', category: '处理器', brand: 'Intel', kind: 'cpu',
    tags: ['盒装', 'LGA1851', '带核显'], price: 1899, initial: 2499, low: 1799 },
  { id: 'asus-5060ti', name: '华硕 RTX 5060 Ti 16G', subtitle: 'DUAL OC · 16GB GDDR7 · 双风扇', category: '显卡', brand: 'ASUS', kind: 'gpu',
    tags: ['16GB', '双风扇', '独立显卡'], price: 2999, initial: 3499, low: 2799 },
].map(makeProduct);
