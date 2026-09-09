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
ensureColumn('users','session_version','INTEGER NOT NULL DEFAULT 0');
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
ensureColumn('products','category',"TEXT NOT NULL DEFAULT 'Comida'");
ensureColumn('products','stock_enabled','INTEGER NOT NULL DEFAULT 0');
ensureColumn('products','stock_quantity','INTEGER NOT NULL DEFAULT 0');
ensureColumn('products','low_stock_threshold','INTEGER NOT NULL DEFAULT 5');
ensureColumn('products','variants_json',"TEXT NOT NULL DEFAULT '[]'");
ensureColumn('products','addons_json',"TEXT NOT NULL DEFAULT '[]'");
ensureColumn('products','availability_status',"TEXT NOT NULL DEFAULT 'available'");
ensureColumn('products','unavailable_until','TEXT');
ensureColumn('order_items','options_description','TEXT');
ensureColumn('directory_entries','priority','INTEGER NOT NULL DEFAULT 0');
ensureColumn('directory_entries','featured','INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders','subtotal','REAL');
ensureColumn('orders','delivery_fee','REAL');
ensureColumn('orders','distance_km','REAL');
ensureColumn('orders','payment_status',"TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('orders','client_request_id','TEXT');
ensureColumn('orders','estimated_prep_minutes','INTEGER');
ensureColumn('orders','is_demo','INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders','age_confirmed','INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders','order_timing',"TEXT NOT NULL DEFAULT 'immediate'");
ensureColumn('orders','scheduled_for','TEXT');
ensureColumn('orders','payment_provider','TEXT');
ensureColumn('orders','provider_preference_id','TEXT');
ensureColumn('orders','provider_checkout_url','TEXT');
ensureColumn('orders','provider_payment_id','TEXT');
ensureColumn('orders','payment_expires_at','TEXT');
ensureColumn('orders','accepted_prep_minutes','INTEGER');
ensureColumn('orders','accepted_eta_at','TEXT');
ensureColumn('orders','cancellation_reason','TEXT');
ensureColumn('orders','delivery_pin_hash','TEXT');
ensureColumn('orders','delivery_pin_cipher','TEXT');
ensureColumn('orders','delivery_method',"TEXT NOT NULL DEFAULT 'contact'");

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_request
ON orders(customer_id,client_request_id)
WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id,created_at);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id,status);
CREATE INDEX IF NOT EXISTS idx_orders_scheduled_for ON orders(scheduled_for,status) WHERE scheduled_for IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_provider_preference ON orders(provider_preference_id) WHERE provider_preference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_provider_payment ON orders(provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_user ON delivery_assignments(delivery_user_id,status);
CREATE INDEX IF NOT EXISTS idx_products_availability ON products(restaurant_id,availability_status,unavailable_until);
CREATE TABLE IF NOT EXISTS schema_migrations(
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_substitutions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    original_order_item_id INTEGER NOT NULL,
    replacement_product_id INTEGER NOT NULL,
    proposed_by_user_id INTEGER,
    original_name TEXT NOT NULL,
    replacement_name TEXT NOT NULL,
    original_unit_price REAL NOT NULL,
    replacement_unit_price REAL NOT NULL,
    price_difference REAL NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled')),
    responded_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(original_order_item_id) REFERENCES order_items(id),
    FOREIGN KEY(replacement_product_id) REFERENCES products(id),
    FOREIGN KEY(proposed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_substitutions_one_pending ON order_substitutions(original_order_item_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_substitutions_order ON order_substitutions(order_id,status,created_at);
CREATE TABLE IF NOT EXISTS delivery_proofs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE,
    delivery_user_id INTEGER NOT NULL,
    proof_type TEXT NOT NULL CHECK(proof_type IN ('contact','no_contact')),
    photo_path TEXT,
    latitude REAL,
    longitude REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    delete_after TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(delivery_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_proofs_retention ON delivery_proofs(delete_after);
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
CREATE TABLE IF NOT EXISTS order_issues(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    reporter_user_id INTEGER,
    reporter_role TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    admin_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(reporter_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_order_issues_admin ON order_issues(status,issue_type,created_at);
CREATE TABLE IF NOT EXISTS delivery_zones(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,city TEXT NOT NULL DEFAULT 'Sayula',min_distance_km REAL NOT NULL DEFAULT 0,max_distance_km REAL NOT NULL,base_fee REAL NOT NULL,surcharge_per_km REAL NOT NULL DEFAULT 0,minimum_order REAL NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 1,priority INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS delivery_profiles(delivery_user_id INTEGER PRIMARY KEY,status TEXT NOT NULL DEFAULT 'offline',updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(delivery_user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS delivery_rejections(order_id INTEGER NOT NULL,delivery_user_id INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(order_id,delivery_user_id),FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,FOREIGN KEY(delivery_user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS order_financials(order_id INTEGER PRIMARY KEY,subtotal REAL NOT NULL,delivery_fee REAL NOT NULL,platform_commission REAL NOT NULL DEFAULT 0,tip REAL NOT NULL DEFAULT 0,discount REAL NOT NULL DEFAULT 0,total_charged REAL NOT NULL,payment_method TEXT NOT NULL,payment_status TEXT NOT NULL,restaurant_due REAL NOT NULL,courier_due REAL NOT NULL,settlement_status TEXT NOT NULL DEFAULT 'pending',settled_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS restaurant_subscriptions(restaurant_id INTEGER PRIMARY KEY,registration_fee REAL NOT NULL DEFAULT 50,first_month_fee REAL NOT NULL DEFAULT 100,initial_payment_total REAL NOT NULL DEFAULT 150,registration_paid INTEGER NOT NULL DEFAULT 0,registration_paid_at TEXT,promotion_eligible INTEGER NOT NULL DEFAULT 0,promotion_monthly_fee REAL NOT NULL DEFAULT 100,regular_monthly_fee REAL NOT NULL DEFAULT 200,promotion_months INTEGER NOT NULL DEFAULT 12,promotion_started_at TEXT,terms_accepted_at TEXT,FOREIGN KEY(restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS restaurant_members(
    user_id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL,
    can_manage_orders INTEGER NOT NULL DEFAULT 1,
    can_manage_products INTEGER NOT NULL DEFAULT 0,
    can_view_finance INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_restaurant_members_restaurant ON restaurant_members(restaurant_id,active);
CREATE TABLE IF NOT EXISTS notifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_id INTEGER,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    target_url TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,read_at,id DESC);
CREATE TABLE IF NOT EXISTS push_subscriptions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS settlement_batches(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    period_date TEXT NOT NULL,
    amount REAL NOT NULL,
    reference TEXT NOT NULL,
    proof_url TEXT,
    paid_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_by_user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(restaurant_id) REFERENCES restaurants(id),
    FOREIGN KEY(paid_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_batches_restaurant ON settlement_batches(restaurant_id,period_date);
CREATE INDEX IF NOT EXISTS idx_financials_settlement ON order_financials(settlement_status,created_at);
`);

ensureColumn('restaurant_subscriptions','first_month_fee','REAL NOT NULL DEFAULT 100');
ensureColumn('restaurant_subscriptions','initial_payment_total','REAL NOT NULL DEFAULT 150');
ensureColumn('order_financials','reversal_amount','REAL NOT NULL DEFAULT 0');
ensureColumn('order_financials','reversed_at','TEXT');
ensureColumn('order_financials','reversal_reason','TEXT');
ensureColumn('order_financials','settlement_batch_id','INTEGER');
ensureColumn('restaurant_members','can_use_pos','INTEGER NOT NULL DEFAULT 0');
ensureColumn('delivery_profiles','internal_number','TEXT');
ensureColumn('delivery_profiles','photo_url','TEXT');
ensureColumn('delivery_profiles','vehicle_type','TEXT');
ensureColumn('delivery_profiles','vehicle_description','TEXT');
ensureColumn('delivery_profiles','verification_status',"TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('delivery_profiles','max_active_orders','INTEGER NOT NULL DEFAULT 1');
db.exec(`
CREATE TABLE IF NOT EXISTS pos_sales(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    sold_by_user_id INTEGER,
    receipt_number TEXT UNIQUE,
    subtotal REAL NOT NULL,
    total REAL NOT NULL,
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    note TEXT,
    age_confirmed INTEGER NOT NULL DEFAULT 0,
    client_request_id TEXT NOT NULL UNIQUE,
    void_reason TEXT,
    voided_at TEXT,
    voided_by_user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(restaurant_id) REFERENCES restaurants(id),
    FOREIGN KEY(sold_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(voided_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS pos_sale_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES pos_sales(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_sales_restaurant ON pos_sales(restaurant_id,created_at,status);
CREATE TABLE IF NOT EXISTS cash_sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    opened_by_user_id INTEGER,
    closed_by_user_id INTEGER,
    opening_amount REAL NOT NULL DEFAULT 0 CHECK(opening_amount>=0),
    counted_amount REAL,
    expected_amount REAL,
    difference_amount REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    opening_note TEXT,
    closing_note TEXT,
    opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT,
    FOREIGN KEY(restaurant_id) REFERENCES restaurants(id),
    FOREIGN KEY(opened_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_one_open ON cash_sessions(restaurant_id) WHERE status='open';
CREATE TABLE IF NOT EXISTS cash_movements(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cash_session_id INTEGER NOT NULL,
    user_id INTEGER,
    movement_type TEXT NOT NULL CHECK(movement_type IN ('income','withdrawal')),
    amount REAL NOT NULL CHECK(amount>0),
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id,created_at);
CREATE TABLE IF NOT EXISTS courier_cash_records(
    order_id INTEGER PRIMARY KEY,
    delivery_user_id INTEGER NOT NULL,
    cash_collected REAL NOT NULL DEFAULT 0 CHECK(cash_collected>=0),
    courier_earnings REAL NOT NULL DEFAULT 0 CHECK(courier_earnings>=0),
    amount_to_remit REAL NOT NULL DEFAULT 0 CHECK(amount_to_remit>=0),
    settlement_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(delivery_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_courier_cash_pending ON courier_cash_records(delivery_user_id,settlement_id,created_at);
CREATE TABLE IF NOT EXISTS courier_cash_settlements(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_user_id INTEGER NOT NULL,
    expected_amount REAL NOT NULL,
    reported_amount REAL NOT NULL,
    difference_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'review' CHECK(status IN ('review','settled')),
    courier_note TEXT,
    admin_note TEXT,
    reference TEXT,
    reported_at TEXT DEFAULT CURRENT_TIMESTAMP,
    settled_at TEXT,
    settled_by_user_id INTEGER,
    FOREIGN KEY(delivery_user_id) REFERENCES users(id),
    FOREIGN KEY(settled_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_courier_cash_settlements_status ON courier_cash_settlements(status,reported_at);
CREATE TABLE IF NOT EXISTS trust_profiles(
    user_id INTEGER PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 50 CHECK(score BETWEEN 0 AND 100),
    level TEXT NOT NULL DEFAULT 'standard' CHECK(level IN ('new','standard','trusted','review')),
    positive_events INTEGER NOT NULL DEFAULT 0,
    negative_events INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS order_risk_assessments(
    order_id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
    level TEXT NOT NULL CHECK(level IN ('normal','warning','verification','prepaid_review')),
    action TEXT NOT NULL,
    signals_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(customer_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_order_risk_admin ON order_risk_assessments(level,score,created_at);
CREATE TABLE IF NOT EXISTS dispute_resolutions(
    issue_id INTEGER PRIMARY KEY,
    responsibility TEXT NOT NULL CHECK(responsibility IN ('undetermined','customer','restaurant','delivery','platform','external')),
    resolution TEXT NOT NULL,
    decided_by_user_id INTEGER NOT NULL,
    decided_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(issue_id) REFERENCES order_issues(id) ON DELETE CASCADE,
    FOREIGN KEY(decided_by_user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS customer_addresses(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    address TEXT NOT NULL,
    reference TEXT,
    latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_user ON customer_addresses(customer_id,is_default DESC,id DESC);
CREATE TABLE IF NOT EXISTS coupons(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE COLLATE NOCASE,description TEXT,discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed','free_delivery')),discount_value REAL NOT NULL CHECK(discount_value>=0),minimum_order REAL NOT NULL DEFAULT 0,maximum_discount REAL,restaurant_id INTEGER,starts_at TEXT,expires_at TEXT,total_limit INTEGER,per_user_limit INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,created_by_user_id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS coupon_redemptions(id INTEGER PRIMARY KEY AUTOINCREMENT,coupon_id INTEGER NOT NULL,customer_id INTEGER NOT NULL,order_id INTEGER NOT NULL UNIQUE,amount REAL NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(coupon_id) REFERENCES coupons(id),FOREIGN KEY(customer_id) REFERENCES users(id),FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_limits ON coupon_redemptions(coupon_id,customer_id);
CREATE TABLE IF NOT EXISTS customer_credits(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,amount REAL NOT NULL CHECK(amount>0),remaining_amount REAL NOT NULL CHECK(remaining_amount>=0),source_type TEXT NOT NULL CHECK(source_type IN ('compensation','loyalty','referral','promotion')),source_reference TEXT NOT NULL,reason TEXT NOT NULL,expires_at TEXT,created_by_user_id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(customer_id,source_type,source_reference),FOREIGN KEY(customer_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS credit_uses(id INTEGER PRIMARY KEY AUTOINCREMENT,credit_id INTEGER NOT NULL,order_id INTEGER NOT NULL,amount REAL NOT NULL CHECK(amount>0),created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(credit_id,order_id),FOREIGN KEY(credit_id) REFERENCES customer_credits(id),FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS loyalty_accounts(customer_id INTEGER PRIMARY KEY,points INTEGER NOT NULL DEFAULT 0 CHECK(points>=0),lifetime_points INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_points>=0),updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(customer_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS referrals(id INTEGER PRIMARY KEY AUTOINCREMENT,referrer_user_id INTEGER NOT NULL,referred_user_id INTEGER NOT NULL UNIQUE,referral_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rewarded','cancelled')),qualifying_order_id INTEGER,rewarded_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,CHECK(referrer_user_id<>referred_user_id),FOREIGN KEY(referrer_user_id) REFERENCES users(id),FOREIGN KEY(referred_user_id) REFERENCES users(id),FOREIGN KEY(qualifying_order_id) REFERENCES orders(id));
CREATE TABLE IF NOT EXISTS favorite_restaurants(customer_id INTEGER NOT NULL,restaurant_id INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(customer_id,restaurant_id),FOREIGN KEY(customer_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS local_promotions(id INTEGER PRIMARY KEY AUTOINCREMENT,restaurant_id INTEGER NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,starts_at TEXT,expires_at TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_local_promotions_public ON local_promotions(active,starts_at,expires_at);
`);
ensureColumn('orders','coupon_id','INTEGER');
ensureColumn('orders','credit_used','REAL NOT NULL DEFAULT 0');
ensureColumn('pos_sale_items','options_description','TEXT');
ensureColumn('pos_sales','cash_session_id','INTEGER');
db.prepare('UPDATE restaurant_subscriptions SET registration_fee=50,first_month_fee=100,initial_payment_total=150 WHERE registration_fee=150').run();

if(!db.prepare('SELECT id FROM delivery_zones LIMIT 1').get()){
    db.prepare("INSERT INTO delivery_zones(name,city,min_distance_km,max_distance_km,base_fee,surcharge_per_km,minimum_order,available,priority) VALUES('Zona centro','Sayula',0,3,35,0,0,1,10)").run();
    db.prepare("INSERT INTO delivery_zones(name,city,min_distance_km,max_distance_km,base_fee,surcharge_per_km,minimum_order,available,priority) VALUES('Zona extendida','Sayula',3,15,35,6,0,1,5)").run();
}
db.exec(`INSERT OR IGNORE INTO order_financials(order_id,subtotal,delivery_fee,platform_commission,tip,discount,total_charged,payment_method,payment_status,restaurant_due,courier_due)
SELECT id,COALESCE(subtotal,total-COALESCE(delivery_fee,0)),COALESCE(delivery_fee,0),0,0,0,total,payment_method,payment_status,COALESCE(subtotal,total-COALESCE(delivery_fee,0)),COALESCE(delivery_fee,0) FROM orders;`);
db.exec(`UPDATE order_financials SET reversal_amount=total_charged,reversed_at=COALESCE(reversed_at,CURRENT_TIMESTAMP),reversal_reason=COALESCE(reversal_reason,'Migración de pedido cancelado'),restaurant_due=0,courier_due=0,platform_commission=0,payment_status='cancelled',settlement_status='reversed',updated_at=CURRENT_TIMESTAMP WHERE order_id IN (SELECT id FROM orders WHERE status='cancelled') AND settlement_status!='reversed';`);
db.prepare('INSERT OR IGNORE INTO schema_migrations(version,description) VALUES(?,?)').run('2026-09-09-phase-1','Privacidad de reparto, disponibilidad temporal, cancelación, sustituciones y preparación confirmada');
db.prepare("UPDATE delivery_profiles SET verification_status='verified',internal_number=COALESCE(internal_number,'CS-'||printf('%04d',delivery_user_id)) WHERE delivery_user_id IN (SELECT id FROM users WHERE role='delivery' AND account_status='approved') AND verification_status='pending'").run();
db.prepare('INSERT OR IGNORE INTO schema_migrations(version,description) VALUES(?,?)').run('2026-09-09-phase-2','Identidad del repartidor, PIN aleatorio, evidencia de entrega y límites simultáneos');
db.prepare('INSERT OR IGNORE INTO schema_migrations(version,description) VALUES(?,?)').run('2026-09-09-phase-3','Libro de efectivo, diferencias y conciliaciones de repartidores');
db.exec("INSERT OR IGNORE INTO trust_profiles(user_id,score,level) SELECT id,50,CASE WHEN julianday('now')-julianday(created_at)<30 THEN 'new' ELSE 'standard' END FROM users");
db.prepare('INSERT OR IGNORE INTO schema_migrations(version,description) VALUES(?,?)').run('2026-09-09-phase-4','Confianza recuperable, riesgo explicable y resolución de disputas');
db.prepare('INSERT OR IGNORE INTO schema_migrations(version,description) VALUES(?,?)').run('2026-09-09-phase-5','Cupones, créditos, fidelidad, referidos, promociones locales y favoritos');

module.exports = db;
