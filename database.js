const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const dataDir=process.env.DATA_DIR||process.cwd();
fs.mkdirSync(dataDir,{recursive:true});
const db = new Database(process.env.DB_FILE || path.join(dataDir,'come_sayula.db'));

db.pragma('journal_mode=WAL');
db.pragma('foreign_keys=ON');
db.pragma('busy_timeout=5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',created_at TEXT DEFAULT CURRENT_TIMESTAMP,google_id TEXT);
CREATE TABLE IF NOT EXISTS restaurants(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER UNIQUE NOT NULL,name TEXT NOT NULL,description TEXT,address TEXT,phone TEXT,active INTEGER DEFAULT 1,FOREIGN KEY(owner_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,restaurant_id INTEGER NOT NULL,name TEXT NOT NULL,description TEXT,price REAL NOT NULL,image TEXT,available INTEGER DEFAULT 1,FOREIGN KEY(restaurant_id) REFERENCES restaurants(id));
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,restaurant_id INTEGER NOT NULL,address TEXT NOT NULL,payment_method TEXT NOT NULL,total REAL NOT NULL,status TEXT DEFAULT 'received',created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(customer_id) REFERENCES users(id),FOREIGN KEY(restaurant_id) REFERENCES restaurants(id));
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,product_id INTEGER NOT NULL,product_name TEXT NOT NULL,unit_price REAL NOT NULL,quantity INTEGER NOT NULL,FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS directory_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,category TEXT NOT NULL,description TEXT,address TEXT,phone TEXT,hours TEXT,source_url TEXT NOT NULL,verification_status TEXT NOT NULL DEFAULT 'Pendiente de confirmar',active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS delivery_assignments(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL UNIQUE,delivery_user_id INTEGER,status TEXT NOT NULL DEFAULT 'available',accepted_at TEXT,delivered_at TEXT,latitude REAL,longitude REAL,location_accuracy REAL,location_updated_at TEXT,FOREIGN KEY(order_id) REFERENCES orders(id),FOREIGN KEY(delivery_user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS order_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL UNIQUE,customer_id INTEGER NOT NULL,restaurant_id INTEGER NOT NULL,delivery_user_id INTEGER,restaurant_rating INTEGER NOT NULL CHECK(restaurant_rating BETWEEN 1 AND 5),delivery_rating INTEGER CHECK(delivery_rating BETWEEN 1 AND 5),comment TEXT,tip_amount REAL NOT NULL DEFAULT 0 CHECK(tip_amount>=0 AND tip_amount<=1000),tip_method TEXT NOT NULL DEFAULT 'cash',created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(order_id) REFERENCES orders(id),FOREIGN KEY(customer_id) REFERENCES users(id),FOREIGN KEY(restaurant_id) REFERENCES restaurants(id),FOREIGN KEY(delivery_user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS feedback_reports(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_code TEXT NOT NULL UNIQUE,
    user_id INTEGER,
    user_role TEXT NOT NULL CHECK(user_role IN ('customer','restaurant','delivery')),
    category TEXT NOT NULL CHECK(category IN ('error','suggestion','complaint','praise')),
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    answers_json TEXT NOT NULL,
    comment TEXT,
    screenshot_url TEXT,
    order_id INTEGER,
    anonymous INTEGER NOT NULL DEFAULT 0,
    contact_allowed INTEGER NOT NULL DEFAULT 0,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','reviewing','accepted','resolved')),
    severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('low','normal','high','critical')),
    group_key TEXT NOT NULL,
    admin_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS order_status_history(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_role TEXT NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
`);

function ensureColumn(table, column, definition){
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if(!columns.some(item => item.name === column)){
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

ensureColumn('users','google_id','TEXT');
ensureColumn('users','account_status',"TEXT NOT NULL DEFAULT 'approved'");
ensureColumn('users','email_verified','INTEGER NOT NULL DEFAULT 0');
ensureColumn('users','phone_verified','INTEGER NOT NULL DEFAULT 0');
ensureColumn('users','terms_accepted_at','TEXT');
ensureColumn('users','terms_version','TEXT');
ensureColumn('delivery_assignments','latitude','REAL');
ensureColumn('delivery_assignments','longitude','REAL');
ensureColumn('delivery_assignments','location_accuracy','REAL');
ensureColumn('delivery_assignments','location_updated_at','TEXT');
ensureColumn('restaurants','image','TEXT');
ensureColumn('orders','delivery_latitude','REAL');
ensureColumn('orders','delivery_longitude','REAL');
ensureColumn('restaurants','latitude','REAL');
ensureColumn('restaurants','longitude','REAL');
ensureColumn('restaurants','category',"TEXT NOT NULL DEFAULT 'Otros'");
ensureColumn('restaurants','priority','INTEGER NOT NULL DEFAULT 0');
ensureColumn('restaurants','featured','INTEGER NOT NULL DEFAULT 0');
ensureColumn('restaurants','operational_status',"TEXT NOT NULL DEFAULT 'open'");
ensureColumn('restaurants','prep_minutes','INTEGER NOT NULL DEFAULT 30');
ensureColumn('restaurants','special_hours','TEXT');
ensureColumn('directory_entries','priority','INTEGER NOT NULL DEFAULT 0');
ensureColumn('directory_entries','featured','INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders','subtotal','REAL');
ensureColumn('orders','delivery_fee','REAL');
ensureColumn('orders','distance_km','REAL');
ensureColumn('orders','payment_status',"TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('orders','client_request_id','TEXT');
ensureColumn('orders','estimated_prep_minutes','INTEGER');

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_request
ON orders(customer_id,client_request_id)
WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id,created_at);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id,status);
CREATE INDEX IF NOT EXISTS idx_delivery_user ON delivery_assignments(delivery_user_id,status);
CREATE TABLE IF NOT EXISTS audit_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    ip_address TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_reset_tokens(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rate_limits(
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_locations(
    delivery_user_id INTEGER PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy REAL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(delivery_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_locations_updated
ON delivery_locations(updated_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_reviews_restaurant ON order_reviews(restaurant_id,created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_delivery ON order_reviews(delivery_user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_admin ON feedback_reports(status,severity,created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_group ON feedback_reports(group_key,created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback_reports(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_order_status_history ON order_status_history(order_id,created_at);
`);

module.exports = db;

