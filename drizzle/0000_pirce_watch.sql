CREATE TABLE products (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sku_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  status_message TEXT NOT NULL DEFAULT '等待首次采集',
  price_cents INTEGER CHECK(price_cents IS NULL OR price_cents>0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  last_checked_at TEXT,
  last_success_at TEXT,
  target_cents INTEGER CHECK(target_cents IS NULL OR target_cents>0),
  source TEXT,
  price_kind TEXT,
  source_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  below_target INTEGER NOT NULL DEFAULT 0,
  collection_token TEXT,
  collection_until TEXT,
  UNIQUE(owner,url,spec)
);
--> statement-breakpoint
CREATE TABLE samples (
  id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  timestamp TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents>0),
  currency TEXT NOT NULL,
  source TEXT,
  price_kind TEXT,
  source_url TEXT,
  UNIQUE(product_id,timestamp,price_cents)
);
--> statement-breakpoint
CREATE TABLE alerts (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  timestamp TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents>0),
  target_cents INTEGER NOT NULL CHECK(target_cents>0),
  UNIQUE(product_id,timestamp,price_cents,target_cents)
);
--> statement-breakpoint
CREATE INDEX products_owner ON products(owner,deleted);
--> statement-breakpoint
CREATE INDEX products_due ON products(owner,deleted,enabled,last_checked_at);
--> statement-breakpoint
CREATE INDEX samples_product ON samples(product_id,timestamp);
--> statement-breakpoint
CREATE INDEX alerts_product ON alerts(product_id,timestamp);
