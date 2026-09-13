const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const fs=require("fs");
const crypto=require("crypto");
const Database=require("better-sqlite3");
const webpush=require('web-push');
const {PDFParse}=require('pdf-parse');
const {createWorker,OEM,PSM}=require('tesseract.js');
const spanishOcrData=require('@tesseract.js-data/spa');
const db=require("./database");
const {OAuth2Client}=require("google-auth-library");

const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||"846821366103-clbjraiah8qvdb5gia3op8h8rsu4c8ba.apps.googleusercontent.com";
const googleClient=new OAuth2Client(GOOGLE_CLIENT_ID);
const OPENAI_API_KEY=String(process.env.OPENAI_API_KEY||'').trim();
const OPENAI_MODEL=String(process.env.OPENAI_MODEL||'gpt-5-mini').trim();
const SENDGRID_API_KEY=String(process.env.SENDGRID_API_KEY||'').trim();
const SENDGRID_FROM_EMAIL=String(process.env.SENDGRID_FROM_EMAIL||'').trim().toLowerCase();
const SENDGRID_FROM_NAME=String(process.env.SENDGRID_FROM_NAME||'COME SAYULA').trim().slice(0,100)||'COME SAYULA';
const SENDGRID_API_URL=String(process.env.SENDGRID_API_URL||'https://api.sendgrid.com/v3/mail/send').trim();
const MERCADOPAGO_MODE=String(process.env.MERCADOPAGO_MODE||'test').trim().toLowerCase();
const MERCADOPAGO_ACCESS_TOKEN=String(MERCADOPAGO_MODE==='production'?process.env.MERCADOPAGO_ACCESS_TOKEN||'':process.env.MERCADOPAGO_TEST_ACCESS_TOKEN||'').trim();
const MERCADOPAGO_API_BASE=String(process.env.MERCADOPAGO_API_BASE||'https://api.mercadopago.com').replace(/\/$/,'');
const MERCADOPAGO_WEBHOOK_SECRET=String(process.env.MERCADOPAGO_WEBHOOK_SECRET||'').trim();
const PAYMENT_PROVIDER_ENABLED=process.env.PAYMENT_PROVIDER_ENABLED==='1';
const mercadoPagoConfigured=()=>Boolean(PAYMENT_PROVIDER_ENABLED&&MERCADOPAGO_ACCESS_TOKEN&&['test','production'].includes(MERCADOPAGO_MODE));
const ORDER_RESPONSE_MINUTES=Math.min(60,Math.max(3,Number(process.env.ORDER_RESPONSE_MINUTES)||10));
const NOTIFICATION_WORKER_INTERVAL_MS=Math.max(100,Number(process.env.NOTIFICATION_WORKER_INTERVAL_MS)||60*1000);
const ORDER_RATE_LIMIT_MAX=Math.min(200,Math.max(12,Number(process.env.ORDER_RATE_LIMIT_MAX)||12));
const BACKUP_RETENTION_COUNT=Math.min(90,Math.max(2,Number(process.env.BACKUP_RETENTION_COUNT)||7));
const PLATFORM_COMMISSION_PERCENT=Math.min(100,Math.max(0,Number(process.env.PLATFORM_COMMISSION_PERCENT??5)));
const SCHEDULE_MIN_MINUTES=45;
const SCHEDULE_MAX_DAYS=7;
const COURIER_SCHEDULE_WINDOW_MINUTES=60;
const LARGE_ORDER_AMOUNT=Math.max(500,Number(process.env.LARGE_ORDER_AMOUNT)||1200);
const cashLimits={new:500,standard:800,trusted:1500,review:300};
const trustLevel=score=>score>=75?'trusted':score<35?'review':'standard';
const ensureTrustProfile=userId=>{db.prepare("INSERT OR IGNORE INTO trust_profiles(user_id,score,level) VALUES(?,50,CASE WHEN julianday('now')-(SELECT julianday(created_at) FROM users WHERE id=?)<30 THEN 'new' ELSE 'standard' END)").run(userId,userId);return db.prepare('SELECT * FROM trust_profiles WHERE user_id=?').get(userId)};
const adjustTrust=(userId,delta)=>{if(!userId||!Number.isFinite(delta))return;ensureTrustProfile(userId);const current=db.prepare('SELECT score,positive_events,negative_events FROM trust_profiles WHERE user_id=?').get(userId),score=Math.max(0,Math.min(100,Number(current.score)+delta));db.prepare('UPDATE trust_profiles SET score=?,level=?,positive_events=positive_events+?,negative_events=negative_events+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(score,trustLevel(score),delta>0?1:0,delta<0?1:0,userId)};
const activeCorrectiveActions=userId=>db.prepare("SELECT id,issue_id,action_type,reason,starts_at,expires_at FROM corrective_actions WHERE target_user_id=? AND status='active' AND datetime(expires_at)>CURRENT_TIMESTAMP ORDER BY expires_at").all(userId);
const hasCorrectiveAction=(userId,type)=>Boolean(db.prepare("SELECT id FROM corrective_actions WHERE target_user_id=? AND action_type=? AND status='active' AND datetime(expires_at)>CURRENT_TIMESTAMP LIMIT 1").get(userId,type));
const assessOrderRisk=(customerId,total,paymentMethod)=>{const user=db.prepare('SELECT created_at,email_verified,phone_verified FROM users WHERE id=?').get(customerId),trust=ensureTrustProfile(customerId),signals=[];let score=0;const ageDays=Math.max(0,(Date.now()-new Date(user.created_at+'Z').getTime())/86400000),cancellations=db.prepare("SELECT COUNT(*) total FROM orders WHERE customer_id=? AND status='cancelled' AND datetime(created_at)>=datetime('now','-30 days')").get(customerId).total,delivered=db.prepare("SELECT COUNT(*) total FROM orders WHERE customer_id=? AND status='delivered'").get(customerId).total;if(ageDays<7){score+=15;signals.push('Cuenta con menos de 7 días')}if(!user.email_verified&&!user.phone_verified){score+=15;signals.push('Contacto sin verificar')}if(cancellations>=2){score+=Math.min(30,cancellations*8);signals.push('Varias cancelaciones recientes')}if(total>=LARGE_ORDER_AMOUNT){score+=25;signals.push('Pedido de monto alto')}if(paymentMethod==='Efectivo'&&total>cashLimits[trust.level]){score+=30;signals.push('Supera el límite de efectivo del nivel')}if(delivered>=5&&cancellations===0){score=Math.max(0,score-15);signals.push('Historial positivo de entregas')}const level=score>=70?'prepaid_review':score>=50?'verification':score>=25?'warning':'normal',action=level==='prepaid_review'?'Solicitar pago no efectivo y revisión':level==='verification'?'Solicitar verificación adicional':level==='warning'?'Mostrar advertencia y observar':'Procesar normalmente';return {score,level,action,signals,trust,cashLimit:cashLimits[trust.level]}};
const referralCode=userId=>'CS'+Number(userId).toString(36).toUpperCase().padStart(5,'0');
const availableCredit=userId=>Number(db.prepare("SELECT ROUND(COALESCE(SUM(remaining_amount),0),2) total FROM customer_credits WHERE customer_id=? AND remaining_amount>0 AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP)").get(userId).total)||0;
const validateCoupon=(code,customerId,restaurantId,subtotal,deliveryFee)=>{if(!code)return {coupon:null,discount:0};const coupon=db.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1 AND (restaurant_id IS NULL OR restaurant_id=?) AND (starts_at IS NULL OR datetime(starts_at)<=CURRENT_TIMESTAMP) AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP)").get(String(code).trim(),restaurantId);if(!coupon)throw new Error('El cupón no existe, está vencido o no aplica a este restaurante');if(subtotal<Number(coupon.minimum_order))throw new Error('Este cupón requiere una compra mínima de $'+Number(coupon.minimum_order).toFixed(2));const totalUses=db.prepare('SELECT COUNT(*) total FROM coupon_redemptions WHERE coupon_id=?').get(coupon.id).total,userUses=db.prepare('SELECT COUNT(*) total FROM coupon_redemptions WHERE coupon_id=? AND customer_id=?').get(coupon.id,customerId).total;if(coupon.total_limit!==null&&totalUses>=coupon.total_limit)throw new Error('El cupón alcanzó su límite de usos');if(userUses>=coupon.per_user_limit)throw new Error('Ya utilizaste este cupón');let discount=coupon.discount_type==='percent'?subtotal*Number(coupon.discount_value)/100:coupon.discount_type==='free_delivery'?deliveryFee:Number(coupon.discount_value);if(coupon.maximum_discount!==null)discount=Math.min(discount,Number(coupon.maximum_discount));discount=Math.round(Math.min(subtotal+deliveryFee,Math.max(0,discount))*100)/100;return {coupon,discount}};
const rewardDeliveredOrder=orderId=>{const order=db.prepare('SELECT customer_id,total,is_demo FROM orders WHERE id=?').get(orderId);if(!order||order.is_demo)return;const points=Math.max(1,Math.floor(Number(order.total)/20));db.prepare('INSERT INTO loyalty_accounts(customer_id,points,lifetime_points) VALUES(?,?,?) ON CONFLICT(customer_id) DO UPDATE SET points=points+excluded.points,lifetime_points=lifetime_points+excluded.lifetime_points,updated_at=CURRENT_TIMESTAMP').run(order.customer_id,points,points);const referral=db.prepare("SELECT * FROM referrals WHERE referred_user_id=? AND status='pending'").get(order.customer_id);if(referral){db.prepare("UPDATE referrals SET status='rewarded',qualifying_order_id=?,rewarded_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(orderId,referral.id);for(const userId of [referral.referrer_user_id,referral.referred_user_id])db.prepare("INSERT OR IGNORE INTO customer_credits(customer_id,amount,remaining_amount,source_type,source_reference,reason,expires_at) VALUES(?,50,50,'referral',?,'Recompensa por referido válido',datetime('now','+90 days'))").run(userId,'referral-'+referral.id+'-'+userId);}};
const normalizeOrderTiming=body=>{
    const orderTiming=String(body.orderTiming||'immediate');
    if(orderTiming==='immediate')return {orderTiming,scheduledFor:null};
    if(orderTiming!=='scheduled')return {error:'El tipo de pedido no es válido'};
    const raw=String(body.scheduledFor||'');
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))return {error:'Selecciona una fecha y hora válidas'};
    const scheduledDate=new Date(raw),delay=scheduledDate.getTime()-Date.now();
    if(!Number.isFinite(scheduledDate.getTime()))return {error:'Selecciona una fecha y hora válidas'};
    if(delay<SCHEDULE_MIN_MINUTES*60*1000)return {error:'Los pedidos programados requieren al menos 45 minutos de anticipación'};
    if(delay>SCHEDULE_MAX_DAYS*24*60*60*1000)return {error:'Sólo puedes programar pedidos dentro de los próximos 7 días'};
    return {orderTiming,scheduledFor:scheduledDate.toISOString()};
};
const canOfferScheduledOrder=order=>!order.scheduled_for||new Date(order.scheduled_for).getTime()<=Date.now()+COURIER_SCHEDULE_WINDOW_MINUTES*60*1000;
const scheduledPrepStart=order=>order.scheduled_for?new Date(new Date(order.scheduled_for).getTime()-Math.max(5,Number(order.accepted_prep_minutes)||Number(order.estimated_prep_minutes)||30)*60*1000):null;
const sayulaDateKey=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const restaurantScheduleStatus=(restaurantId,date=new Date())=>{const rows=db.prepare('SELECT weekday,is_closed,opens_at,closes_at FROM restaurant_business_hours WHERE restaurant_id=?').all(restaurantId);if(!rows.length)return {configured:false,open:true};const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Mexico_City',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value])),weekday={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[parts.weekday],row=rows.find(item=>item.weekday===weekday),minute=Number(parts.hour)*60+Number(parts.minute);if(!row||row.is_closed)return {configured:true,open:false,weekday};const toMinute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));return {configured:true,open:minute>=toMinute(row.opens_at)&&minute<toMinute(row.closes_at),weekday,opensAt:row.opens_at,closesAt:row.closes_at};};
const restaurantOperationalScheduleStatus=(restaurantId,date=new Date())=>{const special=db.prepare('SELECT is_closed,opens_at,closes_at,note FROM restaurant_special_hours WHERE restaurant_id=? AND service_date=?').get(restaurantId,sayulaDateKey(date));if(!special)return restaurantScheduleStatus(restaurantId,date);if(special.is_closed)return {configured:true,open:false,special:true,note:special.note};const time=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Mexico_City',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date),toMinutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3)),minute=toMinutes(time);return {configured:true,open:minute>=toMinutes(special.opens_at)&&minute<toMinutes(special.closes_at),special:true,opensAt:special.opens_at,closesAt:special.closes_at,note:special.note};};
const weekKey=date=>{const local=new Date(sayulaDateKey(date)+'T12:00:00Z'),day=(local.getUTCDay()+6)%7;local.setUTCDate(local.getUTCDate()-day);return local.toISOString().slice(0,10)};
const courierLevel=deliveryUserId=>{const stats=db.prepare("SELECT COUNT(*) deliveries,ROUND(AVG(rv.delivery_rating),1) rating FROM delivery_assignments da JOIN orders o ON o.id=da.order_id LEFT JOIN order_reviews rv ON rv.order_id=o.id WHERE da.delivery_user_id=? AND o.status='delivered' AND o.is_demo=0").get(deliveryUserId),deliveries=Number(stats.deliveries)||0,rating=Number(stats.rating)||0;const name=deliveries>=100&&rating>=4.7?'Embajador':deliveries>=50&&rating>=4.5?'Oro':deliveries>=15?'Plata':'Inicio';return {name,deliveries,rating,nextAt:name==='Inicio'?15:name==='Plata'?50:name==='Oro'?100:null}};
const recordCourierAchievement=(deliveryUserId,orderId)=>{const today=sayulaDateKey(new Date()),yesterday=sayulaDateKey(new Date(Date.now()-86400000)),streak=db.prepare('SELECT * FROM driver_streaks WHERE delivery_user_id=?').get(deliveryUserId);let current=streak?.last_delivery_date===today?Number(streak.current_days):streak?.last_delivery_date===yesterday?Number(streak.current_days)+1:1;db.prepare('INSERT INTO driver_streaks(delivery_user_id,current_days,best_days,last_delivery_date) VALUES(?,?,?,?) ON CONFLICT(delivery_user_id) DO UPDATE SET current_days=excluded.current_days,best_days=MAX(driver_streaks.best_days,excluded.best_days),last_delivery_date=excluded.last_delivery_date,updated_at=CURRENT_TIMESTAMP').run(deliveryUserId,current,Math.max(current,Number(streak?.best_days)||0),today);const goals=db.prepare("SELECT * FROM driver_goals WHERE active=1 AND datetime(starts_at)<=CURRENT_TIMESTAMP AND datetime(ends_at)>=CURRENT_TIMESTAMP").all();for(const goal of goals){const key=goal.period_type==='daily'?today:weekKey(new Date());db.prepare('INSERT INTO driver_goal_progress(goal_id,delivery_user_id,period_key,deliveries) VALUES(?,?,?,1) ON CONFLICT(goal_id,delivery_user_id,period_key) DO UPDATE SET deliveries=deliveries+1,updated_at=CURRENT_TIMESTAMP').run(goal.id,deliveryUserId,key);const progress=db.prepare('SELECT * FROM driver_goal_progress WHERE goal_id=? AND delivery_user_id=? AND period_key=?').get(goal.id,deliveryUserId,key);if(progress.deliveries>=goal.target_deliveries&&!progress.completed_at){db.prepare('UPDATE driver_goal_progress SET completed_at=CURRENT_TIMESTAMP WHERE id=? AND completed_at IS NULL').run(progress.id);const reward=db.prepare("INSERT OR IGNORE INTO driver_rewards(delivery_user_id,goal_id,period_key,amount,reward_type,reason) VALUES(?,?,?,?, 'goal_bonus',?)").run(deliveryUserId,goal.id,key,goal.bonus_amount,'Meta completada: '+goal.name);if(reward.changes)addNotification(deliveryUserId,orderId,'goal_completed','¡Meta completada!','Ganaste un bono de $'+Number(goal.bonus_amount).toFixed(2)+'.','/delivery.html');}}};
const scheduledOrderView=order=>{const prepStart=scheduledPrepStart(order);return {...order,prep_start_at:prepStart?.toISOString()||null};};
const app=express();
app.set('trust proxy',process.env.TRUST_PROXY==='1'?1:false);
const dataDir=process.env.DATA_DIR||__dirname;
const uploadsDir=process.env.UPLOADS_DIR||path.join(dataDir,'uploads');
fs.mkdirSync(uploadsDir,{recursive:true});
const settlementProofDir=path.join(dataDir,'settlement-proofs');
fs.mkdirSync(settlementProofDir,{recursive:true});
const deliveryProofDir=path.join(dataDir,'delivery-proofs');
fs.mkdirSync(deliveryProofDir,{recursive:true});
const purgeExpiredDeliveryProofs=()=>{for(const proof of db.prepare("SELECT id,photo_path FROM delivery_proofs WHERE datetime(delete_after)<=CURRENT_TIMESTAMP").all()){try{if(proof.photo_path)fs.unlinkSync(path.join(deliveryProofDir,path.basename(proof.photo_path)))}catch(error){if(error.code!=='ENOENT')console.error('DELIVERY PROOF CLEANUP ERROR',error.message)}db.prepare('DELETE FROM delivery_proofs WHERE id=?').run(proof.id)}};
const purgeExperienceData=()=>{db.prepare("DELETE FROM order_messages WHERE datetime(delete_after)<=CURRENT_TIMESTAMP").run();db.prepare("UPDATE group_orders SET status='expired' WHERE status='open' AND datetime(expires_at)<=CURRENT_TIMESTAMP").run();db.prepare("DELETE FROM delivery_locations WHERE datetime(updated_at)<=datetime('now','-24 hours') AND NOT EXISTS(SELECT 1 FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=delivery_locations.delivery_user_id AND da.status='accepted' AND o.status IN ('assigned','delivering'))").run();};
purgeExpiredDeliveryProofs();
purgeExperienceData();
setInterval(purgeExpiredDeliveryProofs,6*60*60*1000).unref();
setInterval(purgeExperienceData,60*60*1000).unref();
const persistentStorageConfigured=()=>Boolean(process.env.DATA_DIR&&path.resolve(db.name).startsWith(path.resolve(dataDir)+path.sep));
const backupStatus={enabled:process.env.DISABLE_AUTOMATIC_BACKUP!=='1',lastSuccessAt:null};
const deleteLocalImage=value=>{if(!/^\/uploads\/restaurant-[a-zA-Z0-9._-]+$/.test(String(value||'')))return;try{fs.unlinkSync(path.join(uploadsDir,path.basename(value)));}catch(e){if(e.code!=='ENOENT')console.error('IMAGE CLEANUP ERROR',e.message);}};
const directoryBytes=directory=>{if(!fs.existsSync(directory))return 0;let total=0;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);try{total+=entry.isDirectory()?directoryBytes(full):fs.statSync(full).size;}catch(e){}}return total;};
const secretPath=path.join(dataDir,'.come_sayula_secret');
const SECRET=process.env.JWT_SECRET||(
    fs.existsSync(secretPath)
        ? fs.readFileSync(secretPath,'utf8').trim()
        : (()=>{const value=crypto.randomBytes(48).toString('hex');fs.writeFileSync(secretPath,value,{mode:0o600});return value;})()
);
const JWT_OPTIONS={algorithm:'HS256',issuer:'come-sayula',audience:'come-sayula-web'};
const signToken=user=>jwt.sign({...user,sessionVersion:Number(user.session_version||user.sessionVersion||0)},SECRET,{...JWT_OPTIONS,expiresIn:'30d'});
const normalizeEmail=value=>String(value||'').trim().toLowerCase().slice(0,254);
const hasSensitiveCardData=body=>['cardNumber','card_number','pan','cvv','cvc','securityCode','expiry','expiration'].some(key=>body&&body[key]!=null);
const normalizeChoices=value=>{const rows=Array.isArray(value)?value:[];return rows.slice(0,20).map(row=>({name:String(row?.name||'').trim().slice(0,60),priceDelta:Math.round(Number(row?.priceDelta||0)*100)/100})).filter(row=>row.name&&Number.isFinite(row.priceDelta)&&row.priceDelta>=0&&row.priceDelta<=5000)};
const MENU_CATEGORIES=['Comida','Bebidas','Bebidas alcohólicas','Postres','Extras'];
const menuDraftError=(name,price,category)=>!name?'Falta el nombre':name.length>100?'El nombre supera 100 caracteres':!Number.isFinite(price)||price<=0||price>100000?'Precio inválido':!MENU_CATEGORIES.includes(category)?'Categoría inválida':null;
const parseCsvLine=line=>{const cells=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const char=line[i];if(char==='"'&&quoted&&line[i+1]==='"'){value+='"';i++;}else if(char==='"')quoted=!quoted;else if(char===','&&!quoted){cells.push(value.trim());value='';}else value+=char;}cells.push(value.trim());return cells;};
const parseMenuDraft=(content,sourceType)=>{
    const lines=String(content||'').replace(/\r/g,'').split('\n').map(line=>line.trim()).filter(Boolean);
    const delimited=['csv','tsv'].includes(sourceType),parseLine=sourceType==='tsv'?line=>line.split('\t').map(value=>value.trim()):parseCsvLine;
    if(delimited&&lines.length){
        const header=parseLine(lines[0]).map(value=>value.toLowerCase()),nameIndex=header.findIndex(value=>['name','nombre','producto'].includes(value)),priceIndex=header.findIndex(value=>['price','precio'].includes(value));
        if(nameIndex>=0&&priceIndex>=0)return lines.slice(1,301).map((line,index)=>{const cells=parseLine(line),category=(cells[header.findIndex(value=>['category','categoria','categoría'].includes(value))]||'Comida').trim(),name=(cells[nameIndex]||'').trim(),price=Number(String(cells[priceIndex]||'').replace(/[$,\s]/g,'')),description=(cells[header.findIndex(value=>['description','descripcion','descripción'].includes(value))]||'').trim();return {name:name.slice(0,100),description:description.slice(0,500),price,category,error:menuDraftError(name,price,category),sortOrder:index};});
    }
    return lines.slice(0,300).map((line,index)=>{const parts=(delimited?parseLine(line):line.split('|')).map(value=>value.trim()),priceAtEnd=line.match(/\$?\s*(\d+(?:\.\d{1,2})?)\s*$/),name=parts[0]||'',price=Number(String(parts[1]||priceAtEnd?.[1]||'').replace(/[$,\s]/g,'')),category=parts[2]||'Comida',description=parts[3]||'';return {name:name.replace(/\s*\$?\s*\d+(?:\.\d{1,2})?\s*$/,'').slice(0,100),description:description.slice(0,500),price,category,error:menuDraftError(name,price,category),sortOrder:index};});
};
const createMenuDraft=(restaurantId,userId,sourceType,sourceName,content)=>{const items=parseMenuDraft(content,sourceType),storedType=sourceType==='tsv'?'csv':sourceType;const id=db.transaction(()=>{const draft=Number(db.prepare('INSERT INTO menu_drafts(restaurant_id,source_type,source_name,created_by_user_id) VALUES(?,?,?,?)').run(restaurantId,storedType,String(sourceName||'Texto pegado').slice(0,120),userId).lastInsertRowid),insert=db.prepare('INSERT INTO menu_draft_items(draft_id,name,description,price,category,validation_error,sort_order) VALUES(?,?,?,?,?,?,?)');items.forEach(item=>insert.run(draft,item.name,item.description,Number.isFinite(item.price)?item.price:null,item.category,item.error,item.sortOrder));return draft;})();return {id,itemCount:items.length,errorCount:items.filter(item=>item.error).length};};
let menuOcrBusy=false;
const productSelection=(product,item)=>{let variants=[],addons=[];try{variants=JSON.parse(product.variants_json||'[]');addons=JSON.parse(product.addons_json||'[]')}catch{}const selected=[];let extra=0;if(variants.length){const variant=variants.find(v=>v.name===String(item.variant||''));if(!variant)throw new Error('Selecciona una variante válida');selected.push(variant.name);extra+=Number(variant.priceDelta||0)}const requested=[...new Set(Array.isArray(item.addons)?item.addons.map(String):[])];for(const name of requested){const addon=addons.find(a=>a.name===name);if(!addon)throw new Error('Complemento inválido');selected.push(addon.name);extra+=Number(addon.priceDelta||0)}return {unitPrice:Math.round((Number(product.price)+extra)*100)/100,optionsDescription:selected.join(', ')}};
const refreshTemporaryAvailability=()=>db.prepare("UPDATE products SET available=1,availability_status='available',unavailable_until=NULL WHERE availability_status='temporary' AND unavailable_until IS NOT NULL AND datetime(unavailable_until)<=CURRENT_TIMESTAMP").run();
const restaurantLoadState=restaurant=>{const activeOrderCount=Number(db.prepare("SELECT COUNT(*) total FROM orders WHERE restaurant_id=? AND is_demo=0 AND status IN ('received','accepted','preparing','ready') AND payment_status!='awaiting_online_payment'").get(restaurant.id).total)||0,autoSaturated=restaurant.operational_status==='open'&&Boolean(restaurant.auto_saturation_enabled)&&activeOrderCount>=Number(restaurant.auto_saturation_limit||5),effectiveStatus=autoSaturated?'saturated':restaurant.operational_status,effectivePrepMinutes=Math.min(180,Math.max(5,Number(restaurant.prep_minutes)||30)+(effectiveStatus==='saturated'?20:0));return {activeOrderCount,autoSaturated,effectiveStatus,effectivePrepMinutes};};
const publicUser=user=>({id:user.id,name:user.name,email:user.email,phone:user.phone||'',role:user.role,accountStatus:user.account_status});
async function mercadoPagoRequest(route,options={}){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(MERCADOPAGO_API_BASE+route,{...options,signal:controller.signal,headers:{Authorization:'Bearer '+MERCADOPAGO_ACCESS_TOKEN,'Content-Type':'application/json',...(options.headers||{})}}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||data.error||'Mercado Pago no respondió correctamente');return data;}finally{clearTimeout(timeout)}}

const bootstrapAdminEmail=normalizeEmail(process.env.ADMIN_EMAIL);
const bootstrapAdminPassword=String(process.env.ADMIN_PASSWORD||'');
const vapidPath=path.join(dataDir,'.come_sayula_vapid.json');
let vapidKeys;
if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY)vapidKeys={publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY};
else if(fs.existsSync(vapidPath))vapidKeys=JSON.parse(fs.readFileSync(vapidPath,'utf8'));
else{vapidKeys=webpush.generateVAPIDKeys();fs.writeFileSync(vapidPath,JSON.stringify(vapidKeys),{mode:0o600});}
webpush.setVapidDetails('mailto:'+(process.env.SUPPORT_EMAIL||bootstrapAdminEmail||'soporte@come-sayula.app'),vapidKeys.publicKey,vapidKeys.privateKey);
if(bootstrapAdminEmail&&bootstrapAdminPassword.length>=12&&!db.prepare("SELECT id FROM users WHERE role='admin'").get()){
    db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,email_verified) VALUES(?,?,?,?, 'admin','approved',1)")
        .run('Administrador',bootstrapAdminEmail,'',bcrypt.hashSync(bootstrapAdminPassword,12));
    console.log('Cuenta administrativa inicial creada para '+bootstrapAdminEmail);
}

app.disable('x-powered-by');
app.use((req,res,next)=>{
    req.requestId=crypto.randomUUID();res.setHeader('X-Request-Id',req.requestId);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer-when-downgrade');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin-allow-popups');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(self)');
    res.setHeader('Cross-Origin-Resource-Policy','same-site');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org; connect-src 'self' https://accounts.google.com https://router.project-osrm.org; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'; form-action 'self'");
    if(process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    next();
});
app.use(express.json({limit:'6mb',strict:true}));
app.use((req,res,next)=>{if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');next();});
app.use('/uploads',express.static(uploadsDir,{dotfiles:'deny',fallthrough:false,maxAge:'7d'}));
app.use(express.static(path.join(__dirname,'public'),{dotfiles:'deny',index:'index.html'}));

const rateLimit=(name,max,windowMs)=>(req,res,next)=>{
    const key=name+':'+req.ip;
    const now=Date.now();
    let entry=db.prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').get(key);
    if(!entry||entry.reset_at<=now){db.prepare('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,reset_at=excluded.reset_at').run(key,now+windowMs);return next();}
    if(entry.count>=max){res.setHeader('Retry-After',Math.ceil((entry.reset_at-now)/1000));return res.status(429).json({error:'Demasiados intentos. Espera un momento.'});}
    db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);next();
};
const auth=(req,res,next)=>{
    try{
        const header=req.headers.authorization||'';
        if(!header.startsWith('Bearer '))throw new Error('token missing');
        req.user=jwt.verify(header.slice(7),SECRET,{...JWT_OPTIONS,algorithms:['HS256']});
        const current=db.prepare('SELECT id,name,email,phone,role,account_status,session_version FROM users WHERE id=?').get(req.user.id);
        if(!current||current.account_status!=='approved')return res.status(403).json({error:'Esta cuenta está pendiente de aprobación o fue suspendida'});
        if(Number(req.user.sessionVersion||0)!==Number(current.session_version||0))return res.status(401).json({error:'La sesión venció. Inicia sesión nuevamente'});
        req.user={...req.user,...publicUser(current)};
        next();
    }catch(e){res.status(401).json({error:'Sesión inválida o vencida'});}
};
const role=roles=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:'Sin permisos'});
const getRestaurantAccess=userId=>db.prepare(`SELECT r.*,
    CASE WHEN r.owner_id=? THEN 1 ELSE 0 END is_owner,
    CASE WHEN r.owner_id=? THEN 1 ELSE COALESCE(m.can_manage_orders,0) END can_manage_orders,
    CASE WHEN r.owner_id=? THEN 1 ELSE COALESCE(m.can_manage_products,0) END can_manage_products,
    CASE WHEN r.owner_id=? THEN 1 ELSE COALESCE(m.can_view_finance,0) END can_view_finance
    ,CASE WHEN r.owner_id=? THEN 1 ELSE COALESCE(m.can_use_pos,0) END can_use_pos
    FROM restaurants r LEFT JOIN restaurant_members m ON m.restaurant_id=r.id AND m.user_id=? AND m.active=1
    WHERE r.owner_id=? OR m.user_id=? LIMIT 1`).get(userId,userId,userId,userId,userId,userId,userId,userId);
const restaurantAccess=permission=>(req,res,next)=>{
    if(!['restaurant','restaurant_employee'].includes(req.user.role))return res.status(403).json({error:'Sin permisos'});
    const access=getRestaurantAccess(req.user.id);
    if(!access)return res.status(403).json({error:'La cuenta no está vinculada a un restaurante activo'});
    if(permission&&!access[permission])return res.status(403).json({error:'El dueño no habilitó este permiso para tu cuenta'});
    const load=restaurantLoadState(access);access.auto_saturated=load.autoSaturated;access.active_order_count=load.activeOrderCount;access.effective_operational_status=load.effectiveStatus;access.effective_prep_minutes=load.effectivePrepMinutes;
    req.restaurant=access;next();
};
const restaurantOwner=(req,res,next)=>req.restaurant?.is_owner?next():res.status(403).json({error:'Esta acción está reservada al dueño del restaurante'});
const audit=(req,action,type,id)=>{try{db.prepare('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,ip_address) VALUES(?,?,?,?,?)').run(req.user?.id||null,action,type||null,id||null,String(req.ip||'').slice(0,64));}catch(e){console.error('AUDIT ERROR',e.message);}};
const sendPush=(userId,payload)=>{for(const row of db.prepare('SELECT id,subscription_json FROM push_subscriptions WHERE user_id=?').all(userId)){let subscription;try{subscription=JSON.parse(row.subscription_json);}catch(e){db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);continue;}webpush.sendNotification(subscription,JSON.stringify(payload),{TTL:300,urgency:'high'}).catch(error=>{if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);else console.error('PUSH ERROR',error.statusCode||'',error.message);});}};
const addNotification=(userId,orderId,type,title,message,targetUrl)=>{if(userId){const result=db.prepare('INSERT INTO notifications(user_id,order_id,type,title,message,target_url) VALUES(?,?,?,?,?,?)').run(userId,orderId||null,type,String(title).slice(0,120),String(message).slice(0,300),targetUrl||null);sendPush(userId,{id:Number(result.lastInsertRowid),title,message,url:targetUrl||'/'});}};
const notifyAdmins=(orderId,type,title,message,url='/admin.html')=>{for(const admin of db.prepare("SELECT id FROM users WHERE role='admin' AND account_status='approved'").all())addNotification(admin.id,orderId,type,title,message,url);};
const reverseOrderFinancials=(orderId,reason)=>db.transaction(()=>{const changed=db.prepare("UPDATE order_financials SET reversal_amount=total_charged,reversed_at=CURRENT_TIMESTAMP,reversal_reason=?,restaurant_due=0,courier_due=0,platform_commission=0,payment_status='cancelled',settlement_status='reversed',updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND settlement_status!='reversed'").run(String(reason||'Pedido cancelado').slice(0,300),orderId);if(changed.changes===1){for(const use of db.prepare('SELECT credit_id,amount FROM credit_uses WHERE order_id=?').all(orderId))db.prepare('UPDATE customer_credits SET remaining_amount=remaining_amount+? WHERE id=?').run(use.amount,use.credit_id);db.prepare('DELETE FROM credit_uses WHERE order_id=?').run(orderId);db.prepare('DELETE FROM coupon_redemptions WHERE order_id=?').run(orderId);}return changed;})();
const restoreOrderInventory=orderId=>{for(const item of db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(orderId))db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,available=CASE WHEN stock_enabled=1 THEN 1 ELSE available END WHERE id=? AND stock_enabled=1').run(item.quantity,item.product_id);};
const cancelPendingOnlineOrder=(orderId,reason)=>db.transaction(()=>{const changed=db.prepare("UPDATE orders SET status='cancelled',payment_status='cancelled' WHERE id=? AND payment_status='awaiting_online_payment'").run(orderId);if(changed.changes===1){restoreOrderInventory(orderId);reverseOrderFinancials(orderId,reason);}return changed.changes;})();
function notifyOrderStatus(orderId,status,actor){
    const order=db.prepare('SELECT o.id,o.customer_id,o.restaurant_id,o.scheduled_for,r.owner_id,r.name restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=?').get(orderId);if(!order)return;
    const info={received:['Nuevo pedido','Recibiste un nuevo pedido.','/restaurant.html'],accepted:['Pedido aceptado',`${order.restaurant_name} aceptó tu pedido.`,'/tracking.html?order='+orderId],preparing:['Pedido en preparación','Tu pedido ya se está preparando.','/tracking.html?order='+orderId],ready:['Pedido listo','Tu pedido está listo y busca repartidor.','/tracking.html?order='+orderId],assigned:['Repartidor asignado','Ya hay un repartidor asignado a tu pedido.','/tracking.html?order='+orderId],delivering:['Pedido en camino','Tu pedido salió rumbo a tu domicilio.','/tracking.html?order='+orderId],delivered:['Pedido entregado','Tu pedido fue marcado como entregado.','/home3.html'],cancelled:['Pedido cancelado','El pedido fue cancelado.','/home3.html']}[status];if(!info)return;
    const recipients=new Map();
    if(status==='received'){recipients.set(order.owner_id,'/restaurant.html');for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(order.restaurant_id))recipients.set(member.user_id,'/restaurant.html');}
    else recipients.set(order.customer_id,info[2]);
    if(status==='ready'&&canOfferScheduledOrder(order))for(const courier of db.prepare("SELECT u.id FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.role='delivery' AND u.account_status='approved' AND COALESCE(dp.status,'offline')='available'").all())recipients.set(courier.id,'/delivery.html');
    if(['assigned','delivering','delivered'].includes(status)){recipients.set(order.owner_id,'/restaurant.html');const assignment=db.prepare("SELECT delivery_user_id FROM delivery_assignments WHERE order_id=? AND status IN ('accepted','delivered')").get(orderId);if(assignment)recipients.set(assignment.delivery_user_id,'/delivery.html');}
    for(const [userId,url] of recipients)if(userId!==actor?.id)addNotification(userId,orderId,'order_'+status,info[0],info[1],url);
}
const recordOrderStatus=(orderId,fromStatus,toStatus,user,note='')=>{const result=db.prepare('INSERT INTO order_status_history(order_id,from_status,to_status,actor_user_id,actor_role,note) VALUES(?,?,?,?,?,?)').run(orderId,fromStatus||null,toStatus,user?.id||null,user?.role||'system',String(note||'').slice(0,300));notifyOrderStatus(orderId,toStatus,user);if(toStatus==='accepted')notifyScheduledPrep(orderId);return result;};
function activatePaidOnlineOrder(orderId,payment){return db.transaction(()=>{const order=db.prepare("SELECT id,status,payment_status,total FROM orders WHERE id=?").get(orderId);if(!order||order.status==='cancelled')throw new Error('El pedido ya no está disponible');if(order.payment_status==='paid')return false;if(order.payment_status!=='awaiting_online_payment')throw new Error('El pedido no espera un pago en línea');const amount=Math.round(Number(payment.transaction_amount)*100)/100;if(payment.status!=='approved'||String(payment.external_reference)!=='order:'+orderId||amount!==Math.round(Number(order.total)*100)/100||String(payment.currency_id)!=='MXN')throw new Error('El pago no coincide con el pedido');const changed=db.prepare("UPDATE orders SET payment_status='paid',provider_payment_id=?,created_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status='awaiting_online_payment'").run(String(payment.id),orderId);if(changed.changes!==1)return false;db.prepare("UPDATE order_financials SET payment_status='paid',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);recordOrderStatus(orderId,null,'received',{role:'system'},'Pago en línea aprobado y verificado por Mercado Pago');return true;})();}
const deliveryPinKey=crypto.createHash('sha256').update(SECRET+':delivery-pin').digest();
const ensureDeliveryPin=orderId=>{const current=db.prepare('SELECT delivery_pin_hash,delivery_pin_cipher FROM orders WHERE id=?').get(orderId);if(current?.delivery_pin_hash&&current?.delivery_pin_cipher)return;const pin=String(crypto.randomInt(0,10000)).padStart(4,'0'),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',deliveryPinKey,iv),encrypted=Buffer.concat([cipher.update(pin,'utf8'),cipher.final()]),payload=JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}),hash=crypto.createHmac('sha256',SECRET).update('pin:'+orderId+':'+pin).digest('hex');db.prepare('UPDATE orders SET delivery_pin_hash=?,delivery_pin_cipher=? WHERE id=? AND delivery_pin_hash IS NULL').run(hash,payload,orderId)};
const deliveryPinFor=orderId=>{const row=db.prepare('SELECT delivery_pin_cipher FROM orders WHERE id=?').get(orderId);if(row?.delivery_pin_cipher)try{const payload=JSON.parse(row.delivery_pin_cipher),decipher=crypto.createDecipheriv('aes-256-gcm',deliveryPinKey,Buffer.from(payload.iv,'base64'));decipher.setAuthTag(Buffer.from(payload.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(payload.data,'base64')),decipher.final()]).toString('utf8')}catch(e){return null}const hex=crypto.createHmac('sha256',SECRET).update('delivery:'+orderId).digest('hex');return String(parseInt(hex.slice(0,8),16)%10000).padStart(4,'0')};
const verifyDeliveryPin=(orderId,pin)=>{const row=db.prepare('SELECT delivery_pin_hash FROM orders WHERE id=?').get(orderId);if(!/^\d{4}$/.test(String(pin||'')))return false;if(!row?.delivery_pin_hash)return String(pin)===deliveryPinFor(orderId);const actual=crypto.createHmac('sha256',SECRET).update('pin:'+orderId+':'+pin).digest(),expected=Buffer.from(row.delivery_pin_hash,'hex');return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected)};

function aiContextFor(user){
    if(user.role==='customer'){
        const restaurants=db.prepare("SELECT r.id,r.name,r.description,r.address FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.active=1 ORDER BY r.name LIMIT 30").all();
        const products=db.prepare("SELECT p.id,p.name,p.description,p.price,r.name restaurant FROM products p JOIN restaurants r ON r.id=p.restaurant_id JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE p.available=1 AND r.active=1 ORDER BY r.name,p.name LIMIT 100").all();
        const orders=db.prepare("SELECT id,status,payment_method,payment_status,total,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 8").all(user.id);
        return {restaurants,products,myRecentOrders:orders};
    }
    if(['restaurant','restaurant_employee'].includes(user.role)){
        const access=getRestaurantAccess(user.id),restaurant=access&&db.prepare('SELECT id,name,description,address,active,latitude,longitude FROM restaurants WHERE id=?').get(access.id);
        if(!restaurant)return {restaurant:null};
        const products=db.prepare('SELECT id,name,price,available FROM products WHERE restaurant_id=? ORDER BY id DESC LIMIT 100').all(restaurant.id);
        const orders=db.prepare('SELECT id,status,payment_method,payment_status,subtotal,delivery_fee,total,created_at FROM orders WHERE restaurant_id=? ORDER BY id DESC LIMIT 30').all(restaurant.id);
        return {restaurant:{...restaurant,latitude:restaurant.latitude==null?'sin configurar':'configurada',longitude:restaurant.longitude==null?'sin configurar':'configurada'},products,recentOrders:orders};
    }
    if(user.role==='delivery'){
        const assigned=db.prepare("SELECT o.id,o.status,o.payment_method,o.payment_status,o.total,o.created_at,r.name restaurant FROM delivery_assignments da JOIN orders o ON o.id=da.order_id JOIN restaurants r ON r.id=o.restaurant_id WHERE da.delivery_user_id=? ORDER BY o.id DESC LIMIT 20").all(user.id);
        const available=db.prepare("SELECT o.id,o.status,o.total,o.created_at,r.name restaurant FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN delivery_assignments da ON da.order_id=o.id WHERE o.status='ready' AND (o.scheduled_for IS NULL OR julianday(o.scheduled_for)<=julianday('now','+' || ? || ' minutes')) AND (da.id IS NULL OR da.status='available') ORDER BY o.id LIMIT 20").all(COURIER_SCHEDULE_WINDOW_MINUTES);
        return {myDeliveries:assigned,availableOrders:available};
    }
    const counts={
        customers:db.prepare("SELECT COUNT(*) value FROM users WHERE role='customer'").get().value,
        restaurants:db.prepare("SELECT COUNT(*) value FROM users WHERE role='restaurant'").get().value,
        delivery:db.prepare("SELECT COUNT(*) value FROM users WHERE role='delivery'").get().value,
        pendingAccounts:db.prepare("SELECT COUNT(*) value FROM users WHERE account_status='pending'").get().value,
        activeOrders:db.prepare("SELECT COUNT(*) value FROM orders WHERE status NOT IN ('delivered','cancelled')").get().value
    };
    const recentOrders=db.prepare('SELECT id,status,payment_method,payment_status,total,created_at FROM orders ORDER BY id DESC LIMIT 30').all();
    return {counts,recentOrders};
}

const aiRoleInstructions={
    customer:'Ayuda a elegir productos reales disponibles, usar el carrito, entender pagos y seguir pedidos propios.',
    restaurant:'Ayuda a completar el perfil, mejorar el menú, interpretar pedidos y sugerir acciones operativas.',
    restaurant_employee:'Ayuda a atender pedidos y productos únicamente con los permisos otorgados por el dueño.',
    delivery:'Ayuda a entender pedidos disponibles y asignados, estados de entrega y procedimientos seguros.',
    admin:'Resume la operación, detecta datos incompletos o estados anómalos y propone pasos de diagnóstico.'
};

function extractOpenAIText(data){
    if(typeof data.output_text==='string'&&data.output_text.trim())return data.output_text.trim();
    return (data.output||[]).flatMap(item=>item.content||[]).filter(part=>part.type==='output_text').map(part=>part.text).join('\n').trim();
}

async function openAIRequest(pathname,body){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),20000);
    try{
        const response=await fetch('https://api.openai.com/v1/'+pathname,{method:'POST',headers:{'Authorization':'Bearer '+OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error('OpenAI '+response.status+': '+String(data.error?.message||'respuesta inválida').slice(0,180));
        return data;
    }finally{clearTimeout(timeout);}
}
const sendgridConfigured=()=>SENDGRID_API_KEY.startsWith('SG.')&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(SENDGRID_FROM_EMAIL);
const publicAppBase=req=>{
    const configured=String(process.env.APP_BASE_URL||process.env.RENDER_EXTERNAL_URL||'').trim().replace(/\/$/,'');
    if(/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(configured))return configured;
    if(process.env.NODE_ENV!=='production')return `${req.protocol}://${req.get('host')}`;
    return 'https://come-sayula.onrender.com';
};
async function sendPasswordResetEmail(email,resetUrl){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    try{
        const response=await fetch(SENDGRID_API_URL,{method:'POST',headers:{Authorization:'Bearer '+SENDGRID_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email}]}],from:{email:SENDGRID_FROM_EMAIL,name:SENDGRID_FROM_NAME},subject:'Recupera tu acceso a COME SAYULA',content:[{type:'text/plain',value:`Solicitaste cambiar tu contraseña de COME SAYULA. Abre este enlace dentro de los próximos 30 minutos:\n\n${resetUrl}\n\nSi no hiciste esta solicitud, ignora este mensaje.`},{type:'text/html',value:`<p>Solicitaste cambiar tu contraseña de COME SAYULA.</p><p><a href="${resetUrl}">Cambiar mi contraseña</a></p><p>El enlace vence en 30 minutos y sólo puede utilizarse una vez.</p><p>Si no hiciste esta solicitud, ignora este mensaje.</p>`}]}),signal:controller.signal});
        if(!response.ok)throw new Error('SendGrid respondió con estado '+response.status);
    }finally{clearTimeout(timeout);}
}
app.post('/api/auth/register',rateLimit('register',8,15*60*1000),async(req,res)=>{try{const{name,phone,password}=req.body;const email=normalizeEmail(req.body.email);if(!name||!email||!password||String(password).length<10)return res.status(400).json({error:'Completa los datos y usa una contraseña de al menos 10 caracteres'});if(req.body.termsAccepted!==true)return res.status(400).json({error:'Debes aceptar los términos y el aviso de privacidad'});if(req.body.role&&req.body.role!=='customer')return res.status(403).json({error:'El registro público está disponible únicamente para clientes'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'No fue posible registrar esa cuenta'});const r=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,terms_accepted_at,terms_version) VALUES(?,?,?,?,'customer','approved',CURRENT_TIMESTAMP,'2026-09-08')").run(String(name).trim().slice(0,100),email,String(phone||'').trim().slice(0,30),await bcrypt.hash(password,12));const u=db.prepare('SELECT id,name,email,phone,role,account_status,session_version FROM users WHERE id=?').get(r.lastInsertRowid);audit({user:u,ip:req.ip},'customer_registered','user',u.id);res.status(201).json({token:signToken(u),user:publicUser(u)})}catch(e){console.error(e);res.status(500).json({error:'No fue posible crear la cuenta'})}});
app.post('/api/auth/login',rateLimit('login',10,15*60*1000),async(req,res)=>{
    const email=(req.body.email||'').trim().toLowerCase();
    const selectedRole=req.body.role;
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!user||!(await bcrypt.compare(req.body.password||'',user.password_hash))){
        return res.status(401).json({error:'Correo o contraseña incorrectos'});
    }
    if(user.account_status!=='approved')return res.status(403).json({error:user.account_status==='pending'?'Tu cuenta está pendiente de aprobación administrativa':'Tu cuenta está suspendida; comunícate con soporte'});
    if(selectedRole&&user.role!==selectedRole&&!(selectedRole==='restaurant'&&user.role==='restaurant_employee')){
        return res.status(403).json({
            error:'Esta cuenta no corresponde al tipo de acceso seleccionado'
        });
    }
    const sessionUser=publicUser(user);
    res.json({token:signToken(user),user:sessionUser});
});
app.post('/api/auth/forgot-password',rateLimit('forgot-password',5,30*60*1000),async(req,res)=>{
    const email=normalizeEmail(req.body.email);
    const user=db.prepare("SELECT id FROM users WHERE email=? AND account_status='approved'").get(email);
    let developmentToken;
    if(user){
        const token=crypto.randomBytes(32).toString('hex');
        const hash=crypto.createHash('sha256').update(token).digest('hex');
        db.prepare("UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL").run(user.id);
        db.prepare("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 minutes'))").run(user.id,hash);
        audit(req,'password_reset_requested','user',user.id);
        if(sendgridConfigured()){
            try{await sendPasswordResetEmail(email,publicAppBase(req)+'/reset-password.html?token='+encodeURIComponent(token));audit(req,'password_reset_email_sent','user',user.id);}
            catch(error){db.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(hash);console.error('SENDGRID ERROR',req.requestId,error.name==='AbortError'?'tiempo agotado':String(error.message).slice(0,180));}
        }else if(process.env.NODE_ENV!=='production'&&process.env.DEV_SHOW_RESET_TOKEN==='1')developmentToken=token;
        else console.warn('Recuperación solicitada, pero el proveedor de correo no está configurado. Solicitud '+req.requestId);
    }
    res.json({message:'Si la cuenta existe, enviaremos instrucciones para recuperar el acceso.',developmentToken});
});
app.post('/api/auth/reset-password',rateLimit('reset-password',8,30*60*1000),async(req,res)=>{
    const password=String(req.body.password||''),hash=crypto.createHash('sha256').update(String(req.body.token||'')).digest('hex');
    if(password.length<10)return res.status(400).json({error:'La nueva contraseña debe tener al menos 10 caracteres'});
    const record=db.prepare("SELECT id,user_id FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP").get(hash);
    if(!record)return res.status(400).json({error:'El enlace es inválido o ya venció'});
    db.transaction(()=>{db.prepare('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?').run(bcrypt.hashSync(password,12),record.user_id);db.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(record.id);})();
    audit(req,'password_reset_completed','user',record.user_id);res.json({ok:true});
});
app.patch('/api/auth/password',auth,rateLimit('change-password',8,30*60*1000),async(req,res)=>{
    const currentPassword=String(req.body.currentPassword||''),newPassword=String(req.body.newPassword||'');
    if(newPassword.length<10)return res.status(400).json({error:'La contraseña nueva debe tener al menos 10 caracteres'});
    if(currentPassword===newPassword)return res.status(400).json({error:'La contraseña nueva debe ser diferente'});
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if(!user||!(await bcrypt.compare(currentPassword,user.password_hash)))return res.status(401).json({error:'La contraseña actual no es correcta'});
    db.prepare('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?').run(await bcrypt.hash(newPassword,12),user.id);
    db.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL').run(user.id);
    const updated=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);audit(req,'password_changed','user',user.id);
    res.json({ok:true,message:'Contraseña actualizada. Las demás sesiones fueron cerradas.',token:signToken(updated),user:publicUser(updated)});
});
app.post('/api/auth/logout',auth,rateLimit('logout',20,15*60*1000),(req,res)=>{
    db.transaction(()=>{db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(req.user.id);db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(req.user.id);})();
    audit(req,'sessions_revoked','user',req.user.id);
    res.json({ok:true,message:'Todas las sesiones fueron cerradas de forma segura.'});
});
app.get('/api/account/deletion-request',auth,(req,res)=>res.json(db.prepare("SELECT id,status,reason,requested_at,updated_at FROM account_deletion_requests WHERE user_id=? ORDER BY id DESC LIMIT 1").get(req.user.id)||null));
app.post('/api/account/deletion-request',auth,rateLimit('account-deletion',3,24*60*60*1000),(req,res)=>{
    const confirmation=String(req.body.confirmation||'').trim().toUpperCase(),reason=String(req.body.reason||'').trim().slice(0,500);
    if(confirmation!=='ELIMINAR')return res.status(400).json({error:'Escribe ELIMINAR para confirmar la solicitud'});
    if(db.prepare("SELECT id FROM account_deletion_requests WHERE user_id=? AND status='pending'").get(req.user.id))return res.status(409).json({error:'Ya existe una solicitud pendiente'});
    const result=db.prepare("INSERT INTO account_deletion_requests(user_id,role,reason) VALUES(?,?,?)").run(req.user.id,req.user.role,reason);
    audit(req,'account_deletion_requested','account_deletion_request',Number(result.lastInsertRowid));notifyAdmins(null,'account_deletion_requested','Solicitud de eliminación de cuenta','Una persona solicitó eliminar su cuenta. Requiere verificar identidad, retención y datos vinculados.','/admin.html');
    res.status(201).json({ok:true,id:Number(result.lastInsertRowid),message:'Recibimos tu solicitud. Soporte revisará la identidad y te responderá por el correo de tu cuenta.'});
});
app.delete('/api/account/deletion-request',auth,(req,res)=>{const result=db.prepare("UPDATE account_deletion_requests SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND status='pending'").run(req.user.id);if(!result.changes)return res.status(404).json({error:'No existe una solicitud pendiente'});audit(req,'account_deletion_cancelled','user',req.user.id);res.json({ok:true,message:'La solicitud fue cancelada.'})});
app.get('/api/notifications',auth,(req,res)=>{const after=Math.max(0,Number(req.query.after)||0);const rows=db.prepare('SELECT id,order_id,type,title,message,target_url,read_at,created_at FROM notifications WHERE user_id=? AND id>? ORDER BY id DESC LIMIT 50').all(req.user.id,after);const unread=db.prepare('SELECT COUNT(*) total FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).total;res.json({notifications:rows,unread});});
app.patch('/api/notifications/read',auth,(req,res)=>{const id=req.body.id==null?null:Number(req.body.id);if(id!==null&&(!Number.isInteger(id)||id<=0))return res.status(400).json({error:'Notificación inválida'});if(id===null)db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL').run(req.user.id);else db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(id,req.user.id);res.json({ok:true});});
app.get('/api/push/public-key',auth,(req,res)=>res.json({publicKey:vapidKeys.publicKey}));
app.post('/api/push/subscribe',auth,rateLimit('push-subscribe',20,60*60*1000),(req,res)=>{const subscription=req.body.subscription,endpoint=String(subscription?.endpoint||''),p256dh=String(subscription?.keys?.p256dh||''),authKey=String(subscription?.keys?.auth||''),serialized=JSON.stringify(subscription||{});if(!endpoint.startsWith('https://')||endpoint.length>2048||p256dh.length<20||p256dh.length>512||authKey.length<8||authKey.length>256||Buffer.byteLength(serialized)>16384)return res.status(400).json({error:'Suscripción inválida'});db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,subscription_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,subscription_json=excluded.subscription_json,updated_at=CURRENT_TIMESTAMP`).run(req.user.id,endpoint,serialized);res.status(201).json({ok:true});});
app.delete('/api/push/subscribe',auth,(req,res)=>{const endpoint=String(req.body.endpoint||'');db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id,endpoint);res.json({ok:true});});
app.get('/api/admin/pilot-readiness',auth,role(['admin']),(req,res)=>{const checks=[
    {key:'restaurant',label:'Restaurante aprobado con ubicación y producto',ready:Boolean(db.prepare("SELECT r.id FROM restaurants r JOIN users u ON u.id=r.owner_id JOIN products p ON p.restaurant_id=r.id AND p.available=1 WHERE u.account_status='approved' AND r.active=1 AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL LIMIT 1").get())},
    {key:'courier',label:'Repartidor aprobado',ready:Boolean(db.prepare("SELECT id FROM users WHERE role='delivery' AND account_status='approved' LIMIT 1").get())},
    {key:'zones',label:'Zona de entrega activa',ready:Boolean(db.prepare('SELECT id FROM delivery_zones WHERE available=1 LIMIT 1').get())},
    {key:'notifications',label:'Notificaciones móviles configuradas',ready:Boolean(vapidKeys.publicKey)},
    {key:'backups',label:'Respaldos automáticos habilitados',ready:process.env.DISABLE_AUTOMATIC_BACKUP!=='1'},
    {key:'security',label:'Secreto de sesiones de producción configurado',ready:String(process.env.JWT_SECRET||'').length>=48},
    {key:'verification',label:'Proveedor de correo o SMS configurado',ready:process.env.ACCOUNT_MESSAGE_PROVIDER_ENABLED==='1'&&sendgridConfigured()},
    {key:'legal',label:'Datos legales y de privacidad confirmados',ready:process.env.LEGAL_DOCUMENTS_APPROVED==='1'},
    {key:'support',label:'Correo formal de soporte configurado',ready:Boolean(process.env.SUPPORT_EMAIL)},
    {key:'payment',label:'Proveedor de cobro en línea configurado',ready:Boolean(process.env.PAYMENT_PROVIDER_ENABLED==='1'&&MERCADOPAGO_MODE==='production'&&mercadoPagoConfigured()&&MERCADOPAGO_WEBHOOK_SECRET)}
];res.json({readyForControlledPilot:checks.filter(c=>['restaurant','courier','zones','notifications','backups','security'].includes(c.key)).every(c=>c.ready),readyForPublicPayments:checks.every(c=>c.ready),checks});});
app.get('/api/admin/audit',auth,role(['admin']),(req,res)=>{const limit=Math.min(500,Math.max(1,Number(req.query.limit)||100));res.json(db.prepare('SELECT a.id,a.action,a.entity_type,a.entity_id,a.ip_address,a.created_at,u.name user_name,u.role user_role FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?').all(limit));});
app.get('/api/admin/storage',auth,role(['admin']),(req,res)=>{const databaseBytes=fs.existsSync(db.name)?fs.statSync(db.name).size:0,backupDir=path.join(dataDir,'backups'),backupFiles=fs.existsSync(backupDir)?fs.readdirSync(backupDir).filter(name=>/^come_sayula-.*\.db$/.test(name)):[],backupsBytes=directoryBytes(backupDir),uploadsBytes=directoryBytes(uploadsDir),proofsBytes=directoryBytes(settlementProofDir),usedBytes=databaseBytes+uploadsBytes+backupsBytes+proofsBytes,capacityBytes=Math.max(1,Number(process.env.DISK_CAPACITY_GB)||1)*1024*1024*1024;res.json({capacityBytes,usedBytes,percent:Number((usedBytes/capacityBytes*100).toFixed(2)),databaseBytes,uploadsBytes,backupsBytes,proofsBytes,backupCount:backupFiles.length,backupRetentionCount:BACKUP_RETENTION_COUNT,persistentStorageConfigured:persistentStorageConfigured(),automaticBackupEnabled:backupStatus.enabled,lastBackupAt:backupStatus.lastSuccessAt});});
app.get('/api/admin/settlements',auth,role(['admin']),(req,res)=>{const pending=db.prepare(`SELECT r.id restaurant_id,r.name,date(o.created_at) period_date,COUNT(*) orders_count,ROUND(SUM(f.restaurant_due),2) amount FROM order_financials f JOIN orders o ON o.id=f.order_id JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status='delivered' AND o.is_demo=0 AND f.settlement_status='pending' GROUP BY r.id,date(o.created_at) ORDER BY period_date,r.name`).all();const paid=db.prepare(`SELECT b.*,r.name restaurant_name,u.name paid_by_name FROM settlement_batches b JOIN restaurants r ON r.id=b.restaurant_id LEFT JOIN users u ON u.id=b.paid_by_user_id ORDER BY b.paid_at DESC LIMIT 100`).all();res.json({pending,paid});});
app.post('/api/admin/settlements',auth,role(['admin']),rateLimit('settlements',20,60*60*1000),(req,res)=>{const restaurantId=Number(req.body.restaurantId),periodDate=String(req.body.periodDate||''),reference=String(req.body.reference||'').trim().slice(0,120),dataUrl=String(req.body.proofDataUrl||'');if(!Number.isInteger(restaurantId)||!/^\d{4}-\d{2}-\d{2}$/.test(periodDate)||reference.length<3)return res.status(400).json({error:'Selecciona el corte y escribe una referencia'});let proofName=null;if(dataUrl){const match=dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!match)return res.status(400).json({error:'El comprobante debe ser una imagen PNG, JPG o WEBP'});const buffer=Buffer.from(match[2],'base64');if(!buffer.length||buffer.length>4*1024*1024)return res.status(400).json({error:'El comprobante debe pesar menos de 4 MB'});const valid=(match[1]==='jpeg'&&buffer[0]===0xff&&buffer[1]===0xd8)||(match[1]==='png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(match[1]==='webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP');if(!valid)return res.status(400).json({error:'El archivo no contiene una imagen válida'});const ext=match[1]==='jpeg'?'jpg':match[1];proofName=crypto.randomUUID()+'.'+ext;fs.writeFileSync(path.join(settlementProofDir,proofName),buffer,{mode:0o600});}try{const result=db.transaction(()=>{const totals=db.prepare(`SELECT COUNT(*) count,ROUND(SUM(f.restaurant_due),2) amount FROM order_financials f JOIN orders o ON o.id=f.order_id WHERE o.restaurant_id=? AND date(o.created_at)=? AND o.status='delivered' AND o.is_demo=0 AND f.settlement_status='pending'`).get(restaurantId,periodDate);if(!totals.count)throw new Error('Ese corte ya fue conciliado o no tiene pedidos entregados');const batch=db.prepare('INSERT INTO settlement_batches(restaurant_id,period_date,amount,reference,proof_url,paid_by_user_id) VALUES(?,?,?,?,?,?)').run(restaurantId,periodDate,totals.amount,reference,proofName,req.user.id),batchId=Number(batch.lastInsertRowid);db.prepare(`UPDATE order_financials SET settlement_status='paid',settled_at=CURRENT_TIMESTAMP,settlement_batch_id=?,updated_at=CURRENT_TIMESTAMP WHERE order_id IN (SELECT id FROM orders WHERE restaurant_id=? AND date(created_at)=? AND status='delivered' AND is_demo=0) AND settlement_status='pending'`).run(batchId,restaurantId,periodDate);return {batchId,amount:totals.amount};})();audit(req,'settlement_paid','settlement',result.batchId);const owner=db.prepare('SELECT owner_id FROM restaurants WHERE id=?').get(restaurantId);addNotification(owner?.owner_id,null,'settlement_paid','Corte conciliado','Se registró el corte del '+periodDate+' por $'+Number(result.amount).toFixed(2)+'.','/restaurant.html');res.status(201).json({ok:true,...result,proofUrl:proofName?'/api/settlements/'+result.batchId+'/proof':null});}catch(e){if(proofName)try{fs.unlinkSync(path.join(settlementProofDir,proofName));}catch(_){}res.status(409).json({error:e.message});}});
app.get('/api/settlements/:id/proof',auth,(req,res)=>{const batch=db.prepare('SELECT id,restaurant_id,proof_url FROM settlement_batches WHERE id=?').get(Number(req.params.id));if(!batch?.proof_url)return res.status(404).json({error:'Comprobante no encontrado'});const allowed=req.user.role==='admin'||Boolean((()=>{const access=getRestaurantAccess(req.user.id);return access&&access.id===batch.restaurant_id&&access.can_view_finance;})());if(!allowed)return res.status(403).json({error:'Sin permisos'});const file=path.join(settlementProofDir,path.basename(batch.proof_url));if(!fs.existsSync(file))return res.status(404).json({error:'Comprobante no encontrado'});res.sendFile(file);});

app.get('/api/admin/users',auth,role(['admin']),(req,res)=>{
    res.json(db.prepare("SELECT id,name,email,phone,role,account_status,email_verified,phone_verified,created_at FROM users WHERE role IN ('restaurant','delivery') ORDER BY id DESC").all());
});
app.post('/api/admin/users',auth,role(['admin']),rateLimit('admin-create-user',30,60*60*1000),async(req,res)=>{
    try{
        const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),phone=String(req.body.phone||'').trim().slice(0,30),password=String(req.body.password||''),newRole=String(req.body.role||'');
        if(!name||!email||password.length<10||!['restaurant','delivery'].includes(newRole))return res.status(400).json({error:'Completa los datos; la contraseña temporal debe tener al menos 10 caracteres'});
        const result=db.transaction(()=>{const created=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status) VALUES(?,?,?,?,?,'pending')").run(name,email,phone,bcrypt.hashSync(password,12),newRole);if(newRole==='restaurant'){const restaurant=db.prepare("INSERT INTO restaurants(owner_id,name,description,address,phone,active) VALUES(?,?,'Nuevo restaurante en COME SAYULA','Sayula, Jalisco',?,0)").run(created.lastInsertRowid,name,phone);const eligible=db.prepare('SELECT COUNT(*) total FROM restaurant_subscriptions WHERE promotion_eligible=1').get().total<100?1:0;db.prepare('INSERT INTO restaurant_subscriptions(restaurant_id,promotion_eligible) VALUES(?,?)').run(restaurant.lastInsertRowid,eligible);}return created;})();
        audit(req,'staff_account_created','user',Number(result.lastInsertRowid));res.status(201).json({id:Number(result.lastInsertRowid),status:'pending'});
    }catch(error){if(String(error.code||'').includes('CONSTRAINT'))return res.status(409).json({error:'El correo ya está registrado'});throw error;}
});
app.patch('/api/admin/users/:id/status',auth,role(['admin']),(req,res)=>{
    const id=Number(req.params.id),status=String(req.body.status||'');
    if(!Number.isInteger(id)||!['approved','pending','suspended'].includes(status))return res.status(400).json({error:'Datos inválidos'});
    const user=db.prepare("SELECT id,role FROM users WHERE id=? AND role IN ('restaurant','delivery')").get(id);if(!user)return res.status(404).json({error:'Cuenta no encontrada'});
    db.transaction(()=>{db.prepare('UPDATE users SET account_status=? WHERE id=?').run(status,id);if(user.role==='restaurant')db.prepare('UPDATE restaurants SET active=? WHERE owner_id=?').run(status==='approved'?1:0,id);if(user.role==='delivery')db.prepare("INSERT INTO delivery_profiles(delivery_user_id,status,internal_number,verification_status) VALUES(?,'offline','CS-'||printf('%04d',?),?) ON CONFLICT(delivery_user_id) DO UPDATE SET verification_status=excluded.verification_status,status=CASE WHEN excluded.verification_status='verified' THEN delivery_profiles.status ELSE 'offline' END,updated_at=CURRENT_TIMESTAMP").run(id,id,status==='approved'?'verified':status==='suspended'?'suspended':'pending');})();
    audit(req,'staff_status_'+status,'user',id);res.json({ok:true,status});
});
app.patch('/api/admin/users/:id/verification',auth,role(['admin']),(req,res)=>{
    const id=Number(req.params.id);db.prepare('UPDATE users SET email_verified=?,phone_verified=? WHERE id=?').run(req.body.emailVerified?1:0,req.body.phoneVerified?1:0,id);audit(req,'contact_verification_updated','user',id);res.json({ok:true});
});
app.get('/api/admin/restaurants',auth,role(['admin']),(req,res)=>{
    res.json(db.prepare(`SELECT r.id,r.name,r.category,r.priority,r.featured,r.active,u.account_status,
        ROUND(AVG(rv.restaurant_rating),1) rating,COUNT(rv.id) rating_count
        FROM restaurants r JOIN users u ON u.id=r.owner_id
        LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id
        GROUP BY r.id ORDER BY r.featured DESC,r.priority DESC,r.name`).all());
});
app.get('/api/admin/service-quality',auth,role(['admin']),(req,res)=>{
    const summary=db.prepare(`SELECT COUNT(DISTINCT rv.id) reviews,ROUND(AVG(rv.restaurant_rating),1) restaurant_average,ROUND(AVG(rv.delivery_rating),1) delivery_average,(SELECT COUNT(*) FROM order_surveys os JOIN orders so ON so.id=os.order_id WHERE os.everything_ok=0 AND so.is_demo=0) negative_surveys FROM order_reviews rv JOIN orders o ON o.id=rv.order_id WHERE o.is_demo=0`).get();
    const restaurants=db.prepare(`SELECT r.id,r.name,COUNT(rv.id) reviews,ROUND(AVG(rv.restaurant_rating),1) overall,ROUND(AVG(rv.food_rating),1) food,ROUND(AVG(rv.completeness_rating),1) completeness,ROUND(AVG(rv.preparation_rating),1) preparation FROM restaurants r JOIN order_reviews rv ON rv.restaurant_id=r.id JOIN orders o ON o.id=rv.order_id AND o.is_demo=0 GROUP BY r.id ORDER BY overall,r.name`).all();
    const couriers=db.prepare(`SELECT u.id,u.name,dp.internal_number,COUNT(rv.id) reviews,ROUND(AVG(rv.delivery_rating),1) overall,ROUND(AVG(rv.punctuality_rating),1) punctuality,ROUND(AVG(rv.courtesy_rating),1) courtesy,ROUND(AVG(rv.delivery_quality_rating),1) delivery_quality FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id JOIN order_reviews rv ON rv.delivery_user_id=u.id JOIN orders o ON o.id=rv.order_id AND o.is_demo=0 WHERE u.role='delivery' GROUP BY u.id ORDER BY overall,u.name`).all();
    const alerts=db.prepare(`SELECT o.id order_id,r.name restaurant_name,u.name delivery_name,rv.restaurant_rating,rv.delivery_rating,rv.comment,COALESCE(os.everything_ok,1) everything_ok,COALESCE(rv.created_at,os.created_at) created_at FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN order_reviews rv ON rv.order_id=o.id LEFT JOIN order_surveys os ON os.order_id=o.id LEFT JOIN delivery_assignments da ON da.order_id=o.id AND da.status='accepted' LEFT JOIN users u ON u.id=da.delivery_user_id WHERE o.is_demo=0 AND (os.everything_ok=0 OR rv.restaurant_rating<=2 OR rv.delivery_rating<=2) ORDER BY COALESCE(rv.created_at,os.created_at) DESC LIMIT 50`).all();
    res.json({summary,restaurants,couriers,alerts});
});
app.get('/api/admin/analytics',auth,role(['admin']),(req,res)=>{
    const days=[7,30,90].includes(Number(req.query.days))?Number(req.query.days):30,since=`-${days-1} days`;
    const orders=db.prepare(`SELECT COUNT(*) total_orders,COUNT(CASE WHEN o.status='delivered' THEN 1 END) delivered_orders,COUNT(CASE WHEN o.status='cancelled' THEN 1 END) cancelled_orders,ROUND(COALESCE(SUM(CASE WHEN o.status='delivered' THEN f.total_charged ELSE 0 END),0),2) gross_sales,ROUND(COALESCE(SUM(CASE WHEN o.status='delivered' THEN f.platform_commission ELSE 0 END),0),2) platform_commission,ROUND(COALESCE(SUM(CASE WHEN o.status='delivered' THEN f.discount ELSE 0 END),0),2) discounts FROM orders o LEFT JOIN order_financials f ON f.order_id=o.id WHERE o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?)`).get(since);
    const operations={active_restaurants:Number(db.prepare(`SELECT COUNT(*) total FROM restaurants r JOIN users u ON u.id=r.owner_id WHERE r.active=1 AND u.account_status='approved'`).get().total)||0,approved_couriers:Number(db.prepare(`SELECT COUNT(*) total FROM users WHERE role='delivery' AND account_status='approved'`).get().total)||0,recurring_customers:Number(db.prepare(`SELECT COUNT(*) total FROM (SELECT customer_id FROM orders WHERE status='delivered' AND is_demo=0 AND date(created_at)>=date('now','localtime',?) GROUP BY customer_id HAVING COUNT(*)>=2)`).get(since).total)||0,open_issues:Number(db.prepare(`SELECT COUNT(*) total FROM order_issues i JOIN orders o ON o.id=i.order_id WHERE i.status!='resolved' AND o.is_demo=0`).get().total)||0,negative_surveys:Number(db.prepare(`SELECT COUNT(*) total FROM order_surveys s JOIN orders o ON o.id=s.order_id WHERE s.everything_ok=0 AND o.is_demo=0 AND date(s.created_at)>=date('now','localtime',?)`).get(since).total)||0};
    const prep=db.prepare(`SELECT ROUND(AVG((julianday(ready.created_at)-julianday(accepted.created_at))*1440),1) average_minutes,COUNT(*) measured_orders FROM orders o JOIN order_status_history accepted ON accepted.order_id=o.id AND accepted.to_status='accepted' JOIN order_status_history ready ON ready.order_id=o.id AND ready.to_status='ready' WHERE o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?)`).get(since);
    const delivery=db.prepare(`SELECT ROUND(AVG((julianday(done.created_at)-julianday(started.created_at))*1440),1) average_minutes,COUNT(*) measured_orders FROM orders o JOIN order_status_history started ON started.order_id=o.id AND started.to_status='delivering' JOIN order_status_history done ON done.order_id=o.id AND done.to_status='delivered' WHERE o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?)`).get(since);
    const benefits={coupon_uses:Number(db.prepare(`SELECT COUNT(*) total FROM coupon_redemptions cr JOIN orders o ON o.id=cr.order_id WHERE o.status='delivered' AND o.is_demo=0 AND date(cr.created_at)>=date('now','localtime',?)`).get(since).total)||0,coupon_amount:Number(db.prepare(`SELECT ROUND(COALESCE(SUM(cr.amount),0),2) total FROM coupon_redemptions cr JOIN orders o ON o.id=cr.order_id WHERE o.status='delivered' AND o.is_demo=0 AND date(cr.created_at)>=date('now','localtime',?)`).get(since).total)||0,compensations:Number(db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) total FROM customer_credits WHERE source_type='compensation' AND date(created_at)>=date('now','localtime',?)`).get(since).total)||0,driver_rewards:Number(db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) total FROM driver_rewards WHERE status!='cancelled' AND date(earned_at)>=date('now','localtime',?)`).get(since).total)||0};
    const daily=db.prepare(`SELECT date(o.created_at) day,COUNT(*) orders,COUNT(CASE WHEN o.status='delivered' THEN 1 END) delivered,COUNT(CASE WHEN o.status='cancelled' THEN 1 END) cancelled,ROUND(COALESCE(SUM(CASE WHEN o.status='delivered' THEN f.total_charged ELSE 0 END),0),2) sales FROM orders o LEFT JOIN order_financials f ON f.order_id=o.id WHERE o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?) GROUP BY date(o.created_at) ORDER BY day`).all(since);
    res.json({days,orders,operations,prep,delivery,benefits,daily});
});
app.patch('/api/admin/restaurants/:id/visibility',auth,role(['admin']),(req,res)=>{
    const id=Number(req.params.id),priority=Number(req.body.priority),category=String(req.body.category||'Otros').trim().slice(0,40),featured=req.body.featured?1:0;
    if(!Number.isInteger(id)||id<=0||!Number.isInteger(priority)||priority<0||priority>100||!category)return res.status(400).json({error:'Visibilidad inválida'});
    const result=db.prepare('UPDATE restaurants SET category=?,priority=?,featured=? WHERE id=?').run(category,priority,featured,id);
    if(result.changes!==1)return res.status(404).json({error:'Restaurante no encontrado'});
    audit(req,'restaurant_visibility_updated','restaurant',id);res.json({ok:true,category,priority,featured:Boolean(featured)});
});
app.get('/api/admin/subscriptions',auth,role(['admin']),(req,res)=>res.json(db.prepare(`SELECT s.*,r.name FROM restaurant_subscriptions s JOIN restaurants r ON r.id=s.restaurant_id ORDER BY r.id`).all()));
app.patch('/api/admin/subscriptions/:id/payment',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id);if(req.body.acceptedTerms!==true)return res.status(400).json({error:'Confirma que el restaurante aceptó las condiciones'});const result=db.prepare("UPDATE restaurant_subscriptions SET registration_paid=1,registration_paid_at=CURRENT_TIMESTAMP,promotion_started_at=COALESCE(promotion_started_at,CURRENT_TIMESTAMP),terms_accepted_at=COALESCE(terms_accepted_at,CURRENT_TIMESTAMP) WHERE restaurant_id=?").run(id);if(result.changes!==1)return res.status(404).json({error:'Suscripción no encontrada'});audit(req,'restaurant_registration_confirmed','restaurant',id);res.json({ok:true,registrationFee:50,firstMonthFee:100,initialPaymentTotal:150,firstMonthIncluded:true});});
app.get('/api/admin/delivery-zones',auth,role(['admin']),(req,res)=>res.json(db.prepare('SELECT * FROM delivery_zones ORDER BY priority DESC,max_distance_km').all()));
app.post('/api/admin/delivery-zones',auth,role(['admin']),(req,res)=>{const name=String(req.body.name||'').trim().slice(0,80),city=String(req.body.city||'Sayula').trim().slice(0,80),min=Number(req.body.minDistanceKm),max=Number(req.body.maxDistanceKm),base=Number(req.body.baseFee),surcharge=Number(req.body.surchargePerKm||0),minimum=Number(req.body.minimumOrder||0);if(!name||![min,max,base,surcharge,minimum].every(Number.isFinite)||min<0||max<=min||base<0||surcharge<0||minimum<0)return res.status(400).json({error:'Datos de zona inválidos'});const result=db.prepare('INSERT INTO delivery_zones(name,city,min_distance_km,max_distance_km,base_fee,surcharge_per_km,minimum_order,available,priority) VALUES(?,?,?,?,?,?,?,?,?)').run(name,city,min,max,base,surcharge,minimum,req.body.available===false?0:1,Number(req.body.priority)||0);audit(req,'delivery_zone_created','delivery_zone',Number(result.lastInsertRowid));res.status(201).json({id:Number(result.lastInsertRowid)});});
app.patch('/api/admin/delivery-zones/:id',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),name=String(req.body.name||'').trim().slice(0,80),city=String(req.body.city||'Sayula').trim().slice(0,80),min=Number(req.body.minDistanceKm),max=Number(req.body.maxDistanceKm),base=Number(req.body.baseFee),surcharge=Number(req.body.surchargePerKm||0),minimum=Number(req.body.minimumOrder||0);if(!Number.isInteger(id)||!name||![min,max,base,surcharge,minimum].every(Number.isFinite)||min<0||max<=min||base<0||surcharge<0||minimum<0)return res.status(400).json({error:'Datos de zona inválidos'});const result=db.prepare('UPDATE delivery_zones SET name=?,city=?,min_distance_km=?,max_distance_km=?,base_fee=?,surcharge_per_km=?,minimum_order=?,available=?,priority=? WHERE id=?').run(name,city,min,max,base,surcharge,minimum,req.body.available?1:0,Number(req.body.priority)||0,id);if(result.changes!==1)return res.status(404).json({error:'Zona no encontrada'});audit(req,'delivery_zone_updated','delivery_zone',id);res.json({ok:true});});
app.get('/api/admin/delivery-couriers',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT u.id,u.name,u.phone,COALESCE(dp.status,'offline') status,COALESCE(dp.verification_status,'pending') verification_status,COALESCE(dp.max_active_orders,1) max_active_orders,dp.internal_number,dp.vehicle_type,dp.vehicle_description,(SELECT COUNT(*) FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=u.id AND da.status='accepted' AND o.status IN ('assigned','delivering')) active_orders FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.role='delivery' AND u.account_status='approved' ORDER BY status,name").all()));
app.patch('/api/admin/delivery-couriers/:id/profile',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),verificationStatus=String(req.body.verificationStatus||''),maxActiveOrders=Number(req.body.maxActiveOrders);if(!Number.isInteger(id)||!['pending','reviewing','verified','rejected','suspended'].includes(verificationStatus)||!Number.isInteger(maxActiveOrders)||maxActiveOrders<1||maxActiveOrders>3)return res.status(400).json({error:'Perfil o límite inválido'});const user=db.prepare("SELECT id FROM users WHERE id=? AND role='delivery'").get(id);if(!user)return res.status(404).json({error:'Repartidor no encontrado'});db.prepare("INSERT INTO delivery_profiles(delivery_user_id,status,internal_number,verification_status,max_active_orders) VALUES(?,'offline','CS-'||printf('%04d',?),?,?) ON CONFLICT(delivery_user_id) DO UPDATE SET verification_status=excluded.verification_status,max_active_orders=excluded.max_active_orders,status=CASE WHEN excluded.verification_status='verified' THEN delivery_profiles.status ELSE 'offline' END,updated_at=CURRENT_TIMESTAMP").run(id,id,verificationStatus,maxActiveOrders);audit(req,'delivery_profile_reviewed','delivery_profile',id);res.json({ok:true,verificationStatus,maxActiveOrders})});
app.get('/api/admin/delivery-ready-orders',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT o.id,o.total,r.name restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status='ready' AND (o.scheduled_for IS NULL OR julianday(o.scheduled_for)<=julianday('now','+' || ? || ' minutes')) ORDER BY o.id").all(COURIER_SCHEDULE_WINDOW_MINUTES)));
app.post('/api/admin/orders/:id/assign',auth,role(['admin']),(req,res)=>{const orderId=Number(req.params.id),courierId=Number(req.body.deliveryUserId);const order=db.prepare("SELECT id,status,scheduled_for FROM orders WHERE id=?").get(orderId),courier=db.prepare("SELECT u.id,COALESCE(dp.status,'offline') status,COALESCE(dp.verification_status,'pending') verification_status,COALESCE(dp.max_active_orders,1) max_active_orders FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.id=? AND u.role='delivery' AND u.account_status='approved'").get(courierId);if(!order||order.status!=='ready')return res.status(409).json({error:'El pedido no está listo para asignación'});if(!canOfferScheduledOrder(order))return res.status(409).json({error:'El pedido programado todavía no está disponible para reparto'});if(!courier||courier.status!=='available'||courier.verification_status!=='verified')return res.status(409).json({error:'El repartidor no está disponible o verificado'});const active=db.prepare("SELECT COUNT(*) total FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering')").get(courierId);if(active.total>=courier.max_active_orders)return res.status(409).json({error:'El repartidor alcanzó su límite de entregas activas'});try{db.transaction(()=>{db.prepare("INSERT INTO delivery_assignments(order_id,delivery_user_id,status,accepted_at) VALUES(?,?,'accepted',CURRENT_TIMESTAMP)").run(orderId,courierId);db.prepare("UPDATE orders SET status='assigned' WHERE id=? AND status='ready'").run(orderId);ensureDeliveryPin(orderId);db.prepare("UPDATE delivery_profiles SET status='busy',updated_at=CURRENT_TIMESTAMP WHERE delivery_user_id=?").run(courierId);recordOrderStatus(orderId,'ready','assigned',req.user,'Asignación manual administrativa');})();audit(req,'admin_delivery_assigned','order',orderId);res.json({ok:true,status:'assigned'});}catch(e){res.status(409).json({error:'El pedido ya fue asignado'});}});

const feedbackLabels={error:'Error',suggestion:'Sugerencia',complaint:'Inconformidad',praise:'Felicitación'};
const feedbackStatuses=['received','reviewing','accepted','resolved'];
const feedbackSeverities=['low','normal','high','critical'];
const feedbackGroupKey=(category,comment,answers)=>{
    const words=(comment+' '+answers.join(' ')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(word=>word.length>3).slice(0,8).sort().join('|');
    return crypto.createHash('sha256').update(category+'|'+words).digest('hex').slice(0,24);
};
const canUseOrder=(user,orderId)=>{
    if(!orderId)return true;
    if(user.role==='customer')return Boolean(db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(orderId,user.id));
    if(user.role==='restaurant')return Boolean(db.prepare('SELECT o.id FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=? AND r.owner_id=?').get(orderId,user.id));
    if(user.role==='restaurant_employee'){const access=getRestaurantAccess(user.id);return Boolean(access&&db.prepare('SELECT id FROM orders WHERE id=? AND restaurant_id=?').get(orderId,access.id));}
    if(user.role==='delivery')return Boolean(db.prepare('SELECT order_id FROM delivery_assignments WHERE order_id=? AND delivery_user_id=?').get(orderId,user.id));
    return false;
};
const orderChatAccess=(user,orderId,channel)=>{const order=db.prepare(`SELECT o.id,o.customer_id,o.restaurant_id,o.status,r.owner_id,da.delivery_user_id FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN delivery_assignments da ON da.order_id=o.id WHERE o.id=?`).get(orderId);if(!order)return null;if(user.role==='admin')return {order,canPost:false};if(user.role==='customer'&&order.customer_id===user.id)return {order,canPost:true};if(channel==='customer_restaurant'&&user.role==='restaurant'&&order.owner_id===user.id)return {order,canPost:true};if(channel==='customer_restaurant'&&user.role==='restaurant_employee'){const access=getRestaurantAccess(user.id);if(access?.id===order.restaurant_id&&access.can_manage_orders)return {order,canPost:true}}if(channel==='customer_delivery'&&user.role==='delivery'&&order.delivery_user_id===user.id)return {order,canPost:true};return null;};
const chatRecipientIds=(order,channel,senderId)=>{const ids=new Set();if(order.customer_id!==senderId)ids.add(order.customer_id);if(channel==='customer_restaurant'){const restaurant=db.prepare('SELECT owner_id FROM restaurants WHERE id=?').get(order.restaurant_id);if(restaurant?.owner_id!==senderId)ids.add(restaurant.owner_id);for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(order.restaurant_id))if(member.user_id!==senderId)ids.add(member.user_id);}else{const assignment=db.prepare('SELECT delivery_user_id FROM delivery_assignments WHERE order_id=?').get(order.id);if(assignment?.delivery_user_id&&assignment.delivery_user_id!==senderId)ids.add(assignment.delivery_user_id);}return ids;};
const issueTypes=['missing_product','wrong_order','delayed','customer_unavailable','restaurant_closed','cancellation','help'];

app.get('/api/feedback/orders',auth,role(['customer','restaurant','restaurant_employee','delivery']),(req,res)=>{
    let rows=[];
    if(req.user.role==='customer')rows=db.prepare('SELECT id,status,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 30').all(req.user.id);
    if(req.user.role==='restaurant')rows=db.prepare('SELECT o.id,o.status,o.created_at FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE r.owner_id=? ORDER BY o.id DESC LIMIT 30').all(req.user.id);
    if(req.user.role==='restaurant_employee'){const access=getRestaurantAccess(req.user.id);if(access)rows=db.prepare('SELECT id,status,created_at FROM orders WHERE restaurant_id=? ORDER BY id DESC LIMIT 30').all(access.id);}
    if(req.user.role==='delivery')rows=db.prepare('SELECT o.id,o.status,o.created_at FROM orders o JOIN delivery_assignments da ON da.order_id=o.id WHERE da.delivery_user_id=? ORDER BY o.id DESC LIMIT 30').all(req.user.id);
    res.json(rows);
});

app.post('/api/feedback/upload',auth,role(['customer','restaurant','restaurant_employee','delivery']),rateLimit('feedback-upload',10,60*60*1000),(req,res)=>{
    const match=String(req.body.dataUrl||'').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!match)return res.status(400).json({error:'Usa una captura PNG, JPG o WEBP'});
    const buffer=Buffer.from(match[2],'base64');
    if(!buffer.length||buffer.length>4*1024*1024)return res.status(400).json({error:'La captura debe pesar menos de 4 MB'});
    const extension=match[1]==='image/png'?'png':match[1]==='image/webp'?'webp':'jpg';
    const fileName='feedback-'+crypto.randomUUID()+'.'+extension;
    fs.writeFileSync(path.join(uploadsDir,fileName),buffer,{mode:0o600});
    res.status(201).json({url:'/uploads/'+fileName});
});

app.post('/api/feedback',auth,role(['customer','restaurant','restaurant_employee','delivery']),rateLimit('feedback-create',12,60*60*1000),(req,res)=>{
    const category=String(req.body.category||''),rating=Number(req.body.rating),comment=String(req.body.comment||'').trim().slice(0,1500),anonymous=req.body.anonymous?1:0,contactAllowed=req.body.contactAllowed?1:0;
    const answers=Array.isArray(req.body.answers)?req.body.answers.map(value=>String(value||'').trim().slice(0,500)).slice(0,6):[];
    const orderId=req.body.orderId?Number(req.body.orderId):null;
    const screenshotUrl=String(req.body.screenshotUrl||'').trim();
    if(!feedbackLabels[category]||!Number.isInteger(rating)||rating<1||rating>5||answers.some(value=>!value)||!comment)return res.status(400).json({error:'Completa las preguntas, el comentario y la calificación'});
    if(orderId!==null&&(!Number.isInteger(orderId)||orderId<=0||!canUseOrder(req.user,orderId)))return res.status(403).json({error:'No puedes relacionar ese pedido'});
    if(screenshotUrl&&!/^\/uploads\/feedback-[a-f0-9-]+\.(png|jpg|webp)$/.test(screenshotUrl))return res.status(400).json({error:'Captura inválida'});
    const trackingCode=crypto.randomBytes(12).toString('hex'),groupKey=feedbackGroupKey(category,comment,answers);
    const contact=anonymous?{}:{name:String(req.user.name||'').slice(0,100),email:String(req.user.email||'').slice(0,254),phone:String(req.user.phone||'').slice(0,30)};
    const feedbackRole=req.user.role==='restaurant_employee'?'restaurant':req.user.role;
    const result=db.prepare(`INSERT INTO feedback_reports(tracking_code,user_id,user_role,category,rating,answers_json,comment,screenshot_url,order_id,anonymous,contact_allowed,contact_name,contact_email,contact_phone,group_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(trackingCode,anonymous?null:req.user.id,feedbackRole,category,rating,JSON.stringify(answers),comment,screenshotUrl||null,orderId,anonymous,contactAllowed,contact.name||null,contact.email||null,contact.phone||null,groupKey);
    audit(req,'feedback_created','feedback',Number(result.lastInsertRowid));
    notifyAdmins(orderId,'feedback_received','Nueva opinión','Se recibió una nueva opinión de usuario.','/admin.html');
    res.status(201).json({id:Number(result.lastInsertRowid),trackingCode,status:'received'});
});

app.get('/api/feedback/status/:code',rateLimit('feedback-status',60,60*60*1000),(req,res)=>{
    const code=String(req.params.code||'');
    if(!/^[a-f0-9]{24}$/.test(code))return res.status(404).json({error:'Folio no encontrado'});
    const report=db.prepare('SELECT id,tracking_code,user_role,category,rating,status,severity,created_at,updated_at FROM feedback_reports WHERE tracking_code=?').get(code);
    if(!report)return res.status(404).json({error:'Folio no encontrado'});
    res.json(report);
});

app.get('/api/admin/feedback',auth,role(['admin']),(req,res)=>{
    const roleFilter=['customer','restaurant','delivery'].includes(String(req.query.role||''))?String(req.query.role):null;
    const statusFilter=feedbackStatuses.includes(String(req.query.status||''))?String(req.query.status):null;
    const severityFilter=feedbackSeverities.includes(String(req.query.severity||''))?String(req.query.severity):null;
    const reports=db.prepare(`SELECT f.*,COUNT(g.id) AS frequency FROM feedback_reports f LEFT JOIN feedback_reports g ON g.group_key=f.group_key
        WHERE (? IS NULL OR f.user_role=?) AND (? IS NULL OR f.status=?) AND (? IS NULL OR f.severity=?)
        GROUP BY f.id ORDER BY CASE f.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,frequency DESC,f.created_at DESC LIMIT 300`).all(roleFilter,roleFilter,statusFilter,statusFilter,severityFilter,severityFilter);
    res.json(reports.map(item=>({...item,answers:JSON.parse(item.answers_json||'[]'),anonymous:Boolean(item.anonymous),contact_allowed:Boolean(item.contact_allowed),category_label:feedbackLabels[item.category]})));
});

app.patch('/api/admin/feedback/:id',auth,role(['admin']),(req,res)=>{
    const id=Number(req.params.id),status=String(req.body.status||''),severity=String(req.body.severity||''),notes=String(req.body.adminNotes||'').trim().slice(0,1500);
    if(!Number.isInteger(id)||!feedbackStatuses.includes(status)||!feedbackSeverities.includes(severity))return res.status(400).json({error:'Estado o gravedad inválidos'});
    const result=db.prepare('UPDATE feedback_reports SET status=?,severity=?,admin_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,severity,notes,id);
    if(result.changes!==1)return res.status(404).json({error:'Opinión no encontrada'});
    audit(req,'feedback_updated','feedback',id);res.json({ok:true,status,severity});
});

app.post('/api/order-issues',auth,role(['customer','restaurant','restaurant_employee','delivery']),rateLimit('order-issue',20,60*60*1000),(req,res)=>{
    const orderId=Number(req.body.orderId),issueType=String(req.body.issueType||''),description=String(req.body.description||'').trim().slice(0,1000);
    if(!Number.isInteger(orderId)||orderId<=0||!issueTypes.includes(issueType))return res.status(400).json({error:'Selecciona un pedido y un tipo de problema'});
    if(!canUseOrder(req.user,orderId))return res.status(403).json({error:'No puedes reportar problemas de ese pedido'});
    const result=db.prepare('INSERT INTO order_issues(order_id,reporter_user_id,reporter_role,issue_type,description) VALUES(?,?,?,?,?)').run(orderId,req.user.id,req.user.role,issueType,description);
    notifyAdmins(orderId,'order_issue','Problema reportado','Se reportó un problema en el pedido #'+orderId+'.','/admin.html');
    audit(req,'order_issue_created','order_issue',Number(result.lastInsertRowid));res.status(201).json({id:Number(result.lastInsertRowid),status:'open'});
});
app.get('/api/order-issues/my',auth,role(['customer','restaurant','restaurant_employee','delivery']),(req,res)=>res.json(db.prepare('SELECT id,order_id,issue_type,description,status,created_at,updated_at FROM order_issues WHERE reporter_user_id=? ORDER BY id DESC').all(req.user.id)));
app.get('/api/admin/order-issues',auth,role(['admin']),(req,res)=>res.json(db.prepare(`SELECT i.*,u.name reporter_name FROM order_issues i LEFT JOIN users u ON u.id=i.reporter_user_id ORDER BY CASE i.status WHEN 'open' THEN 1 WHEN 'reviewing' THEN 2 ELSE 3 END,i.created_at DESC`).all()));
app.patch('/api/admin/order-issues/:id',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),status=String(req.body.status||''),notes=String(req.body.adminNotes||'').trim().slice(0,1000);if(!Number.isInteger(id)||!['open','reviewing','resolved'].includes(status))return res.status(400).json({error:'Estado inválido'});const result=db.prepare('UPDATE order_issues SET status=?,admin_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,notes,id);if(result.changes!==1)return res.status(404).json({error:'Reporte no encontrado'});audit(req,'order_issue_updated','order_issue',id);res.json({ok:true,status});});
app.post('/api/admin/order-issues/:id/resolve',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),responsibility=String(req.body.responsibility||''),resolution=String(req.body.resolution||'').trim().slice(0,1000);if(!['undetermined','customer','restaurant','delivery','platform','external'].includes(responsibility)||resolution.length<5)return res.status(400).json({error:'Selecciona responsabilidad y explica la resolución'});const issue=db.prepare('SELECT id,order_id FROM order_issues WHERE id=?').get(id);if(!issue)return res.status(404).json({error:'Incidencia no encontrada'});db.transaction(()=>{db.prepare('INSERT INTO dispute_resolutions(issue_id,responsibility,resolution,decided_by_user_id) VALUES(?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET responsibility=excluded.responsibility,resolution=excluded.resolution,decided_by_user_id=excluded.decided_by_user_id,decided_at=CURRENT_TIMESTAMP').run(id,responsibility,resolution,req.user.id);db.prepare("UPDATE order_issues SET status='resolved',admin_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(resolution,id)})();audit(req,'dispute_resolved','order_issue',id);res.json({ok:true,status:'resolved',responsibility})});
app.get('/api/trust/me',auth,(req,res)=>{const profile=ensureTrustProfile(req.user.id),actions=activeCorrectiveActions(req.user.id),cashLimit=req.user.role==='customer'?Math.min(cashLimits[profile.level],actions.some(action=>action.action_type==='benefit_reduction')?300:Infinity):null;res.json({...profile,cashLimit,correctiveActions:actions,message:profile.level==='trusted'?'Tu buen historial aumenta tus beneficios.':profile.level==='review'?'Tu cuenta está en recuperación; completar operaciones correctamente mejora el nivel.':'Sigue completando operaciones correctamente para aumentar tu confianza.'})});
app.get('/api/admin/trust',auth,role(['admin']),(req,res)=>res.json({profiles:db.prepare("SELECT t.*,u.name,u.email,u.role FROM trust_profiles t JOIN users u ON u.id=t.user_id ORDER BY t.score,u.name").all(),risks:db.prepare("SELECT a.*,o.total,o.payment_method,u.name customer_name FROM order_risk_assessments a JOIN orders o ON o.id=a.order_id JOIN users u ON u.id=a.customer_id ORDER BY a.score DESC,a.created_at DESC LIMIT 100").all().map(row=>({...row,signals:JSON.parse(row.signals_json||'[]')})),correctiveActions:db.prepare("SELECT a.*,u.name target_name,u.role target_role,i.order_id,creator.name created_by_name FROM corrective_actions a JOIN users u ON u.id=a.target_user_id JOIN order_issues i ON i.id=a.issue_id JOIN users creator ON creator.id=a.created_by_user_id ORDER BY CASE WHEN a.status='active' AND datetime(a.expires_at)>CURRENT_TIMESTAMP THEN 1 ELSE 2 END,a.id DESC LIMIT 100").all()}));
app.patch('/api/admin/trust/:id',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),delta=Number(req.body.delta),reason=String(req.body.reason||'').trim().slice(0,500);if(!Number.isInteger(id)||!Number.isInteger(delta)||delta===0||Math.abs(delta)>20||reason.length<5)return res.status(400).json({error:'Ajuste o motivo inválido'});if(!db.prepare('SELECT id FROM users WHERE id=?').get(id))return res.status(404).json({error:'Usuario no encontrado'});adjustTrust(id,delta);audit(req,'trust_adjusted_'+(delta>0?'positive':'negative'),'trust_profile',id);res.json(ensureTrustProfile(id))});
app.post('/api/admin/corrective-actions',auth,role(['admin']),rateLimit('corrective-actions',30,60*60*1000),(req,res)=>{const targetUserId=Number(req.body.targetUserId),issueId=Number(req.body.issueId),actionType=String(req.body.actionType||''),days=Number(req.body.days),reason=String(req.body.reason||'').trim().slice(0,500);if(!Number.isInteger(targetUserId)||!Number.isInteger(issueId)||!['warning','verification_required','benefit_reduction','temporary_restriction'].includes(actionType)||!Number.isInteger(days)||days<1||days>30||reason.length<5)return res.status(400).json({error:'Completa una medida temporal válida de 1 a 30 días'});const target=db.prepare("SELECT id,role FROM users WHERE id=? AND role IN ('customer','restaurant','delivery')").get(targetUserId),issue=db.prepare('SELECT i.id,d.responsibility FROM order_issues i JOIN dispute_resolutions d ON d.issue_id=i.id WHERE i.id=? AND i.status=\'resolved\'').get(issueId),roleResponsibility={customer:'customer',restaurant:'restaurant',delivery:'delivery'};if(!target)return res.status(404).json({error:'Usuario operativo no encontrado'});if(!issue||issue.responsibility!==roleResponsibility[target.role])return res.status(409).json({error:'La medida requiere una incidencia resuelta que confirme la responsabilidad de ese usuario'});if(db.prepare("SELECT id FROM corrective_actions WHERE target_user_id=? AND issue_id=? AND action_type=? AND status='active' AND datetime(expires_at)>CURRENT_TIMESTAMP").get(targetUserId,issueId,actionType))return res.status(409).json({error:'Esa medida ya está activa para la incidencia'});const expiresAt=new Date(Date.now()+days*86400000).toISOString(),created=db.prepare('INSERT INTO corrective_actions(target_user_id,issue_id,action_type,reason,expires_at,created_by_user_id) VALUES(?,?,?,?,?,?)').run(targetUserId,issueId,actionType,reason,expiresAt,req.user.id);audit(req,'corrective_action_created','corrective_action',Number(created.lastInsertRowid));addNotification(targetUserId,null,'corrective_action','Medida temporal en tu cuenta','Consulta Mi cuenta para conocer el motivo, duración y cómo recuperar beneficios.','/account.html');res.status(201).json({id:Number(created.lastInsertRowid),actionType,expiresAt,automatic:false})});
app.patch('/api/admin/corrective-actions/:id/revoke',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),reason=String(req.body.reason||'').trim().slice(0,300);if(!Number.isInteger(id)||reason.length<5)return res.status(400).json({error:'Explica por qué se retira la medida'});const changed=db.prepare("UPDATE corrective_actions SET status='revoked',revoked_by_user_id=?,revoked_at=CURRENT_TIMESTAMP,reason=reason||' · Retirada: '||? WHERE id=? AND status='active'").run(req.user.id,reason,id);if(changed.changes!==1)return res.status(409).json({error:'La medida ya terminó, fue retirada o no existe'});audit(req,'corrective_action_revoked','corrective_action',id);res.json({ok:true,status:'revoked'})});

app.get('/api/growth/me',auth,role(['customer']),(req,res)=>{const loyalty=db.prepare('SELECT points,lifetime_points FROM loyalty_accounts WHERE customer_id=?').get(req.user.id)||{points:0,lifetime_points:0},credits=db.prepare("SELECT id,remaining_amount,source_type,reason,expires_at FROM customer_credits WHERE customer_id=? AND remaining_amount>0 AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP) ORDER BY expires_at IS NULL,expires_at").all(req.user.id),referrals=db.prepare('SELECT status,COUNT(*) total FROM referrals WHERE referrer_user_id=? GROUP BY status').all(req.user.id);res.json({referralCode:referralCode(req.user.id),loyalty,creditBalance:availableCredit(req.user.id),credits,referrals})});
app.post('/api/growth/quote',auth,role(['customer']),rateLimit('growth-quote',60,10*60*1000),(req,res)=>{const restaurantId=Number(req.body.restaurantId),subtotal=Math.round(Number(req.body.subtotal)*100)/100,deliveryFee=Math.round(Number(req.body.deliveryFee)*100)/100;if(!Number.isInteger(restaurantId)||!Number.isFinite(subtotal)||subtotal<0||!Number.isFinite(deliveryFee)||deliveryFee<0)return res.status(400).json({error:'Cotización inválida'});try{const coupon=validateCoupon(req.body.couponCode,req.user.id,restaurantId,subtotal,deliveryFee),credit=req.body.useCredits===true?Math.min(availableCredit(req.user.id),Math.max(0,subtotal+deliveryFee-coupon.discount)):0;res.json({couponCode:coupon.coupon?.code||null,couponDiscount:coupon.discount,creditAvailable:availableCredit(req.user.id),creditUsed:credit,total:Math.round(Math.max(0,subtotal+deliveryFee-coupon.discount-credit)*100)/100})}catch(error){res.status(409).json({error:error.message})}});
app.post('/api/referrals/claim',auth,role(['customer']),rateLimit('referral-claim',5,24*60*60*1000),(req,res)=>{const code=String(req.body.code||'').trim().toUpperCase(),match=/^CS([0-9A-Z]{5,})$/.exec(code);if(!match)return res.status(400).json({error:'Código de referido inválido'});const referrerId=parseInt(match[1],36);if(!Number.isInteger(referrerId)||referrerId===req.user.id)return res.status(400).json({error:'No puedes usar tu propio código'});if(!db.prepare("SELECT id FROM users WHERE id=? AND role='customer' AND account_status='approved'").get(referrerId))return res.status(404).json({error:'Código de referido inválido'});if(db.prepare('SELECT id FROM orders WHERE customer_id=? LIMIT 1').get(req.user.id))return res.status(409).json({error:'El código sólo puede registrarse antes del primer pedido'});try{db.prepare('INSERT INTO referrals(referrer_user_id,referred_user_id,referral_code) VALUES(?,?,?)').run(referrerId,req.user.id,code);audit(req,'referral_claimed','user',referrerId);res.status(201).json({ok:true,message:'El beneficio se activará cuando completes tu primer pedido'})}catch{res.status(409).json({error:'Tu cuenta ya tiene un referido registrado'})}});
app.get('/api/favorites',auth,role(['customer']),(req,res)=>res.json(db.prepare("SELECT r.id,r.name,r.category,r.image,r.operational_status FROM favorite_restaurants f JOIN restaurants r ON r.id=f.restaurant_id JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE f.customer_id=? AND r.active=1 ORDER BY f.created_at DESC").all(req.user.id)));
app.put('/api/favorites/:restaurantId',auth,role(['customer']),(req,res)=>{const id=Number(req.params.restaurantId);if(!db.prepare("SELECT r.id FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.id=? AND r.active=1").get(id))return res.status(404).json({error:'Restaurante no encontrado'});db.prepare('INSERT OR IGNORE INTO favorite_restaurants(customer_id,restaurant_id) VALUES(?,?)').run(req.user.id,id);res.json({ok:true,favorite:true})});
app.delete('/api/favorites/:restaurantId',auth,role(['customer']),(req,res)=>{db.prepare('DELETE FROM favorite_restaurants WHERE customer_id=? AND restaurant_id=?').run(req.user.id,Number(req.params.restaurantId));res.json({ok:true,favorite:false})});
app.get('/api/promotions',(req,res)=>res.json(db.prepare("SELECT p.id,p.title,p.description,p.expires_at,r.id restaurant_id,r.name restaurant_name FROM local_promotions p JOIN restaurants r ON r.id=p.restaurant_id JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE p.active=1 AND r.active=1 AND (p.starts_at IS NULL OR datetime(p.starts_at)<=CURRENT_TIMESTAMP) AND (p.expires_at IS NULL OR datetime(p.expires_at)>CURRENT_TIMESTAMP) ORDER BY p.created_at DESC LIMIT 50").all()));
app.get('/api/restaurant/promotions',auth,restaurantAccess('can_manage_products'),(req,res)=>res.json(db.prepare('SELECT * FROM local_promotions WHERE restaurant_id=? ORDER BY id DESC').all(req.restaurant.id)));
app.post('/api/restaurant/promotions',auth,restaurantAccess('can_manage_products'),rateLimit('restaurant-promotions',20,60*60*1000),(req,res)=>{const title=String(req.body.title||'').trim().slice(0,100),description=String(req.body.description||'').trim().slice(0,300),expiresAt=req.body.expiresAt?String(req.body.expiresAt):null;if(title.length<3||description.length<5||expiresAt&&Number.isNaN(Date.parse(expiresAt)))return res.status(400).json({error:'Completa título, descripción y vigencia válida'});const created=db.prepare('INSERT INTO local_promotions(restaurant_id,title,description,expires_at) VALUES(?,?,?,?)').run(req.restaurant.id,title,description,expiresAt);audit(req,'local_promotion_created','local_promotion',Number(created.lastInsertRowid));res.status(201).json({id:Number(created.lastInsertRowid)})});
app.patch('/api/restaurant/promotions/:id',auth,restaurantAccess('can_manage_products'),(req,res)=>{const active=req.body.active===true?1:req.body.active===false?0:null;if(active===null)return res.status(400).json({error:'Estado inválido'});const result=db.prepare('UPDATE local_promotions SET active=? WHERE id=? AND restaurant_id=?').run(active,Number(req.params.id),req.restaurant.id);if(result.changes!==1)return res.status(404).json({error:'Promoción no encontrada'});audit(req,'local_promotion_status','local_promotion',Number(req.params.id));res.json({ok:true,active:Boolean(active)})});
app.get('/api/admin/growth',auth,role(['admin']),(req,res)=>res.json({coupons:db.prepare('SELECT c.*,r.name restaurant_name,(SELECT COUNT(*) FROM coupon_redemptions x WHERE x.coupon_id=c.id) uses FROM coupons c LEFT JOIN restaurants r ON r.id=c.restaurant_id ORDER BY c.id DESC').all(),credits:db.prepare('SELECT c.*,u.name customer_name FROM customer_credits c JOIN users u ON u.id=c.customer_id ORDER BY c.id DESC LIMIT 100').all(),referrals:db.prepare('SELECT status,COUNT(*) total FROM referrals GROUP BY status').all()}));
app.post('/api/admin/coupons',auth,role(['admin']),rateLimit('admin-coupons',30,60*60*1000),(req,res)=>{const code=String(req.body.code||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,30),type=String(req.body.discountType||''),value=Number(req.body.discountValue),minimum=Math.max(0,Number(req.body.minimumOrder)||0),maximum=req.body.maximumDiscount==null?null:Number(req.body.maximumDiscount),totalLimit=req.body.totalLimit==null?null:Number(req.body.totalLimit),perUser=Math.max(1,Number(req.body.perUserLimit)||1),expiresAt=req.body.expiresAt?String(req.body.expiresAt):null,restaurantId=req.body.restaurantId?Number(req.body.restaurantId):null;if(code.length<3||!['percent','fixed','free_delivery'].includes(type)||!Number.isFinite(value)||value<0||(type==='percent'&&value>100)||maximum!==null&&(!Number.isFinite(maximum)||maximum<0)||totalLimit!==null&&(!Number.isInteger(totalLimit)||totalLimit<1)||expiresAt&&Number.isNaN(Date.parse(expiresAt)))return res.status(400).json({error:'Datos del cupón inválidos'});try{const created=db.prepare('INSERT INTO coupons(code,description,discount_type,discount_value,minimum_order,maximum_discount,restaurant_id,expires_at,total_limit,per_user_limit,created_by_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(code,String(req.body.description||'').trim().slice(0,200),type,value,minimum,maximum,restaurantId,expiresAt,totalLimit,perUser,req.user.id);audit(req,'coupon_created','coupon',Number(created.lastInsertRowid));res.status(201).json({id:Number(created.lastInsertRowid),code})}catch{res.status(409).json({error:'Ese código ya existe'})}});
app.patch('/api/admin/coupons/:id',auth,role(['admin']),(req,res)=>{const active=req.body.active===true?1:req.body.active===false?0:null;if(active===null)return res.status(400).json({error:'Estado inválido'});const result=db.prepare('UPDATE coupons SET active=? WHERE id=?').run(active,Number(req.params.id));if(result.changes!==1)return res.status(404).json({error:'Cupón no encontrado'});audit(req,'coupon_status','coupon',Number(req.params.id));res.json({ok:true,active:Boolean(active)})});
app.post('/api/admin/compensations',auth,role(['admin']),rateLimit('admin-compensations',20,60*60*1000),(req,res)=>{const customerId=Number(req.body.customerId),orderId=Number(req.body.orderId),amount=Math.round(Number(req.body.amount)*100)/100,reason=String(req.body.reason||'').trim().slice(0,300);if(!Number.isInteger(customerId)||!Number.isInteger(orderId)||!Number.isFinite(amount)||amount<=0||amount>2000||reason.length<5)return res.status(400).json({error:'Cliente, pedido, monto o motivo inválido'});if(!db.prepare("SELECT id FROM orders WHERE id=? AND customer_id=? AND status IN ('cancelled','delivered')").get(orderId,customerId))return res.status(409).json({error:'La compensación debe relacionarse con un pedido cerrado de ese cliente'});try{const created=db.prepare("INSERT INTO customer_credits(customer_id,amount,remaining_amount,source_type,source_reference,reason,expires_at,created_by_user_id) VALUES(?,?,?,'compensation',?,?,datetime('now','+180 days'),?)").run(customerId,amount,amount,'order-'+orderId,reason,req.user.id);audit(req,'compensation_created','customer_credit',Number(created.lastInsertRowid));addNotification(customerId,orderId,'compensation','Crédito de compensación','Recibiste $'+amount.toFixed(2)+' de crédito COME SAYULA.','/account.html');res.status(201).json({id:Number(created.lastInsertRowid),amount})}catch{res.status(409).json({error:'Ese pedido ya recibió una compensación'})}});

app.post('/api/admin/demo/create',auth,role(['admin']),rateLimit('demo-create',10,60*60*1000),(req,res)=>{
    const restaurant=db.prepare("SELECT r.id,r.prep_minutes,p.id product_id,p.name product_name,p.price FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' JOIN products p ON p.restaurant_id=r.id AND p.available=1 WHERE r.active=1 ORDER BY r.id,p.id LIMIT 1").get();
    if(!restaurant)return res.status(409).json({error:'Necesitas al menos un restaurante activo con un producto disponible'});
    let customer=db.prepare("SELECT id FROM users WHERE email='demo-cliente@come-sayula.local'").get();
    if(!customer){const created=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,email_verified) VALUES('Cliente demostración','demo-cliente@come-sayula.local','',?,'customer','approved',1)").run(bcrypt.hashSync(crypto.randomBytes(18).toString('hex'),10));customer={id:Number(created.lastInsertRowid)};}
    const orderId=db.transaction(()=>{const o=db.prepare("INSERT INTO orders(customer_id,restaurant_id,address,payment_method,total,status,subtotal,delivery_fee,payment_status,client_request_id,estimated_prep_minutes,is_demo) VALUES(?,?,?,'Efectivo',?,'received',?,35,'pay_on_delivery',?,?,1)").run(customer.id,restaurant.id,'Pedido de demostración · Plaza principal',Number(restaurant.price)+35,restaurant.price,'demo-'+crypto.randomUUID(),restaurant.prep_minutes||30);const id=Number(o.lastInsertRowid);db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,1)').run(id,restaurant.product_id,restaurant.product_name,restaurant.price);recordOrderStatus(id,null,'received',req.user,'Pedido de demostración creado');return id;})();
    audit(req,'demo_order_created','order',orderId);res.status(201).json({orderId,status:'received'});
});
app.post('/api/admin/demo/:id/advance',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),order=db.prepare('SELECT id,status FROM orders WHERE id=? AND is_demo=1').get(id);if(!order)return res.status(404).json({error:'Pedido de demostración no encontrado'});const next={received:'accepted',accepted:'preparing',preparing:'ready',ready:'assigned',assigned:'delivering',delivering:'delivered'}[order.status];if(!next)return res.status(409).json({error:'La demostración ya terminó'});db.transaction(()=>{if(next==='assigned'){const courier=db.prepare("SELECT id FROM users WHERE role='delivery' AND account_status='approved' ORDER BY id LIMIT 1").get();if(!courier)throw new Error('Necesitas un repartidor aprobado');db.prepare("INSERT INTO delivery_assignments(order_id,delivery_user_id,status,accepted_at) VALUES(?,?,'accepted',CURRENT_TIMESTAMP)").run(id,courier.id);}db.prepare('UPDATE orders SET status=?,payment_status=CASE WHEN ?=\'delivered\' THEN \'paid\' ELSE payment_status END WHERE id=? AND status=?').run(next,next,id,order.status);if(next==='delivered')db.prepare("UPDATE delivery_assignments SET status='delivered',delivered_at=CURRENT_TIMESTAMP WHERE order_id=?").run(id);recordOrderStatus(id,order.status,next,req.user,'Simulación administrativa');})();audit(req,'demo_order_advanced','order',id);res.json({ok:true,status:next});});
app.get('/api/admin/demo',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT o.id,o.status,o.total,o.created_at,r.name restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.is_demo=1 ORDER BY o.id DESC").all()));
app.get('/api/admin/unanswered-orders',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT o.id,o.created_at,o.total,r.name restaurant_name,u.name customer_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id JOIN users u ON u.id=o.customer_id WHERE o.status='received' AND o.is_demo=0 AND datetime(o.created_at,'+' || ? || ' minutes')<=CURRENT_TIMESTAMP ORDER BY o.created_at").all(ORDER_RESPONSE_MINUTES)));
app.get('/api/admin/scheduled-orders',auth,role(['admin']),(req,res)=>{const now=new Date(),today=sayulaDateKey(now),rows=db.prepare(`SELECT o.id,o.status,o.scheduled_for,o.estimated_prep_minutes,o.total,r.name restaurant_name,u.name customer_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id JOIN users u ON u.id=o.customer_id WHERE o.order_timing='scheduled' AND o.scheduled_for IS NOT NULL AND o.status NOT IN ('delivered','cancelled') ORDER BY julianday(o.scheduled_for),o.id`).all().map(scheduledOrderView);res.json({summary:{upcoming:rows.filter(o=>new Date(o.scheduled_for)>now).length,today:rows.filter(o=>sayulaDateKey(new Date(o.scheduled_for))===today).length,overdue:rows.filter(o=>new Date(o.scheduled_for)<now).length},orders:rows.map(o=>({...o,schedule_state:new Date(o.scheduled_for)<now?'overdue':sayulaDateKey(new Date(o.scheduled_for))===today?'today':'upcoming'}))});});
app.delete('/api/admin/demo',auth,role(['admin']),(req,res)=>{const ids=db.prepare('SELECT id FROM orders WHERE is_demo=1').all().map(x=>x.id);const removed=db.transaction(()=>{for(const id of ids){db.prepare('DELETE FROM order_issues WHERE order_id=?').run(id);db.prepare('DELETE FROM order_reviews WHERE order_id=?').run(id);db.prepare('DELETE FROM delivery_assignments WHERE order_id=?').run(id);db.prepare('DELETE FROM order_status_history WHERE order_id=?').run(id);db.prepare('DELETE FROM orders WHERE id=? AND is_demo=1').run(id);}return ids.length;})();audit(req,'demo_orders_reset','order',null);res.json({ok:true,removed});});
app.get('/api/restaurants',(req,res)=>{const registrados=db.prepare(`SELECT r.id,r.name,r.description,CASE WHEN r.public_address=1 THEN r.address END address,CASE WHEN r.public_phone=1 THEN r.phone END phone,CASE WHEN r.public_location=1 THEN r.latitude END latitude,CASE WHEN r.public_location=1 THEN r.longitude END longitude,r.image,r.category,r.priority,r.featured,r.operational_status,r.prep_minutes,r.special_hours,r.auto_saturation_enabled,r.auto_saturation_limit,
    ROUND(AVG(rv.restaurant_rating),1) AS rating,COUNT(rv.id) AS ratingCount,
    'registered' AS listingType,'Verificado' AS verificationStatus,NULL AS sourceUrl
    FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id WHERE r.active=1
    GROUP BY r.id`).all().map(r=>{const load=restaurantLoadState(r);return {...r,operational_status:load.effectiveStatus,auto_saturated:load.autoSaturated,active_order_count:load.activeOrderCount,estimatedPrepMinutes:load.effectivePrepMinutes}});const directorio=db.prepare("SELECT 'directory-' || id AS id,name,description,address,phone,NULL AS image,category,priority,featured,NULL AS rating,0 AS ratingCount,'directory' AS listingType,verification_status AS verificationStatus,source_url AS sourceUrl FROM directory_entries WHERE active=1").all();res.json([...registrados,...directorio].sort((a,b)=>Number(b.featured)-Number(a.featured)||Number(b.priority)-Number(a.priority)||(Number(b.rating)||0)-(Number(a.rating)||0)||a.name.localeCompare(b.name,'es')))});
app.get('/api/restaurants/:id/menu',(req,res)=>{const id=String(req.params.id);if(id.startsWith('directory-')){const directoryId=Number(id.replace('directory-',''));const r=db.prepare('SELECT id,name,category,description,address,phone,hours,source_url,verification_status FROM directory_entries WHERE id=? AND active=1').get(directoryId);if(!r)return res.status(404).json({error:'No encontrado'});return res.json({restaurant:{...r,id,listingType:'directory',sourceUrl:r.source_url,verificationStatus:r.verification_status},products:[]})}refreshTemporaryAvailability();let r=db.prepare(`SELECT r.id,r.name,r.category,r.description,CASE WHEN r.public_address=1 THEN r.address END address,CASE WHEN r.public_phone=1 THEN r.phone END phone,CASE WHEN r.public_location=1 THEN r.latitude END latitude,CASE WHEN r.public_location=1 THEN r.longitude END longitude,r.image,r.operational_status,r.prep_minutes,r.special_hours,r.auto_saturation_enabled,r.auto_saturation_limit,ROUND(AVG(rv.restaurant_rating),1) rating,COUNT(rv.id) ratingCount FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id WHERE r.id=? AND r.active=1 GROUP BY r.id`).get(req.params.id);if(!r)return res.status(404).json({error:'No encontrado'});const load=restaurantLoadState(r);res.json({restaurant:{...r,operational_status:load.effectiveStatus,auto_saturated:load.autoSaturated,active_order_count:load.activeOrderCount,estimatedPrepMinutes:load.effectivePrepMinutes,listingType:'registered',verificationStatus:'Verificado'},products:db.prepare('SELECT * FROM products WHERE restaurant_id=? AND available=1').all(r.id)})});
const distanceKm=(lat1,lng1,lat2,lng2)=>{const rad=Math.PI/180;const a=Math.sin((lat2-lat1)*rad/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};
const sqliteInstant=value=>value?new Date(String(value).includes('T')?value:String(value).replace(' ','T')+'Z'):null;
const dynamicDeliveryEstimate=tracking=>{if(['delivered','cancelled'].includes(tracking.status))return {minAt:null,maxAt:null,details:null};const now=Date.now(),history=tracking.history||[],eventAt=status=>sqliteInstant(history.find(event=>event.to_status===status)?.created_at)?.getTime()||null,travelDefault=Math.max(8,Math.ceil((Number(tracking.distance_km)||3)/22*60)+5),historical=db.prepare(`SELECT ROUND(AVG((julianday(ready.created_at)-julianday(accepted.created_at))*1440),1) average,COUNT(*) sample FROM orders o JOIN order_status_history accepted ON accepted.order_id=o.id AND accepted.to_status='accepted' JOIN order_status_history ready ON ready.order_id=o.id AND ready.to_status='ready' WHERE o.restaurant_id=? AND o.status='delivered' AND o.is_demo=0 AND (julianday(ready.created_at)-julianday(accepted.created_at))*1440 BETWEEN 1 AND 180 AND datetime(o.created_at)>=datetime('now','-30 days')`).get(tracking.restaurant_id),historicalPrep=Number(historical.sample)>=5?Number(historical.average):null,prepMinutes=Math.max(5,Number(tracking.accepted_prep_minutes)||historicalPrep||Number(tracking.estimated_prep_minutes)||30),acceptedAt=eventAt('accepted'),readyAt=eventAt('ready'),assignedAt=eventAt('assigned'),deliveringAt=eventAt('delivering');let prepRemaining=prepMinutes,dispatchWait=0,travelMinutes=travelDefault,remainingDistance=Number(tracking.distance_km)||null;if(acceptedAt)prepRemaining=Math.max(0,Math.ceil(prepMinutes-(now-acceptedAt)/60000));if(['ready','assigned','delivering'].includes(tracking.status))prepRemaining=0;if(tracking.status==='ready')dispatchWait=10;if(tracking.status==='assigned')dispatchWait=Math.max(2,Math.ceil(7-(now-(assignedAt||now))/60000));if(tracking.status==='delivering'&&Number.isFinite(Number(tracking.latitude))&&Number.isFinite(Number(tracking.longitude))&&Number.isFinite(Number(tracking.delivery_latitude))&&Number.isFinite(Number(tracking.delivery_longitude))){remainingDistance=Math.round(distanceKm(Number(tracking.latitude),Number(tracking.longitude),Number(tracking.delivery_latitude),Number(tracking.delivery_longitude))*100)/100;travelMinutes=Math.max(3,Math.ceil(remainingDistance/22*60)+3);}const courierLoad=tracking.delivery_user_id?Math.max(0,Number(db.prepare("SELECT COUNT(*) total FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering')").get(tracking.delivery_user_id).total)-1):0,loadBuffer=Math.min(10,courierLoad*4),scheduledAt=tracking.scheduled_for?new Date(tracking.scheduled_for).getTime():null;if(scheduledAt&&scheduledAt>now&&['received','accepted','preparing'].includes(tracking.status))return {minAt:new Date(scheduledAt-5*60000).toISOString(),maxAt:new Date(scheduledAt+10*60000).toISOString(),details:{prepMinutes,historicalPrepMinutes:historicalPrep,travelMinutes,activeCourierOrders:courierLoad,remainingDistanceKm:remainingDistance,scheduled:true,delayed:false,reviewSource:null,automaticPenalty:false}};const totalMinutes=Math.max(5,prepRemaining+dispatchWait+travelMinutes+loadBuffer),minAt=new Date(now+Math.max(5,totalMinutes-5)*60000).toISOString(),maxAt=new Date(now+(totalMinutes+7)*60000).toISOString(),createdAt=sqliteInstant(tracking.created_at)?.getTime()||now,commitBase=scheduledAt||sqliteInstant(tracking.accepted_eta_at)?.getTime()||createdAt+prepMinutes*60000,committedMax=commitBase+(travelDefault+10)*60000,delayed=now>committedMax&&!['received'].includes(tracking.status),reviewSource=!delayed?null:['accepted','preparing'].includes(tracking.status)?'restaurant':tracking.status==='ready'?'platform':tracking.status==='assigned'?'courier':'unconfirmed';return {minAt,maxAt,details:{prepMinutes,historicalPrepMinutes:historicalPrep,prepRemainingMinutes:prepRemaining,dispatchWaitMinutes:dispatchWait,travelMinutes,activeCourierOrders:courierLoad,remainingDistanceKm:remainingDistance,scheduled:false,delayed,reviewSource,automaticPenalty:false,milestones:{createdAt:new Date(createdAt).toISOString(),acceptedAt:acceptedAt?new Date(acceptedAt).toISOString():null,readyAt:readyAt?new Date(readyAt).toISOString():null,assignedAt:assignedAt?new Date(assignedAt).toISOString():null,pickedUpAt:deliveringAt?new Date(deliveringAt).toISOString():null,deliveredAt:eventAt('delivered')?new Date(eventAt('delivered')).toISOString():null}}};};

app.get('/api/admin/delayed-orders',auth,role(['admin']),(req,res)=>{const rows=db.prepare(`SELECT o.id,o.status,o.created_at,o.scheduled_for,o.distance_km,o.estimated_prep_minutes,o.accepted_prep_minutes,o.accepted_eta_at,o.delivery_latitude,o.delivery_longitude,o.restaurant_id,r.name restaurant_name,c.name customer_name,da.delivery_user_id,da.latitude,da.longitude,i.id issue_id,i.status review_status,d.responsibility,d.resolution,d.decided_at FROM orders o JOIN restaurants r ON r.id=o.restaurant_id JOIN users c ON c.id=o.customer_id LEFT JOIN delivery_assignments da ON da.order_id=o.id LEFT JOIN order_issues i ON i.id=(SELECT id FROM order_issues WHERE order_id=o.id AND issue_type='delayed' ORDER BY id DESC LIMIT 1) LEFT JOIN dispute_resolutions d ON d.issue_id=i.id WHERE o.is_demo=0 AND o.status NOT IN ('received','delivered','cancelled') ORDER BY o.id DESC LIMIT 150`).all(),orders=[];for(const row of rows){row.history=db.prepare('SELECT to_status,created_at FROM order_status_history WHERE order_id=? ORDER BY id').all(row.id);const eta=dynamicDeliveryEstimate(row);if(eta.details?.delayed||row.issue_id)orders.push({...row,history:undefined,suggested_source:eta.details?.reviewSource||null,detected_delay:Boolean(eta.details?.delayed),automatic_penalty:false});}res.json({orders});});
app.post('/api/admin/delayed-orders/:orderId/resolve',auth,role(['admin']),rateLimit('delay-review',40,60*60*1000),(req,res)=>{const orderId=Number(req.params.orderId),responsibility=String(req.body.responsibility||''),resolution=String(req.body.resolution||'').trim().slice(0,1000);if(!Number.isInteger(orderId)||!['customer','restaurant','delivery','platform','external'].includes(responsibility)||resolution.length<5)return res.status(400).json({error:'Selecciona la causa confirmada y explica el motivo'});if(!db.prepare('SELECT id FROM orders WHERE id=?').get(orderId))return res.status(404).json({error:'Pedido no encontrado'});const issueId=db.transaction(()=>{let issue=db.prepare("SELECT id FROM order_issues WHERE order_id=? AND issue_type='delayed' ORDER BY id DESC LIMIT 1").get(orderId);if(!issue){const created=db.prepare("INSERT INTO order_issues(order_id,reporter_user_id,reporter_role,issue_type,description,status) VALUES(?,?,'admin','delayed','Retraso detectado y revisado por administración','resolved')").run(orderId,req.user.id);issue={id:Number(created.lastInsertRowid)};}db.prepare("UPDATE order_issues SET status='resolved',admin_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(resolution,issue.id);db.prepare('INSERT INTO dispute_resolutions(issue_id,responsibility,resolution,decided_by_user_id) VALUES(?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET responsibility=excluded.responsibility,resolution=excluded.resolution,decided_by_user_id=excluded.decided_by_user_id,decided_at=CURRENT_TIMESTAMP').run(issue.id,responsibility,resolution,req.user.id);return issue.id;})();audit(req,'order_delay_reviewed','order',orderId);res.json({ok:true,issueId,responsibility,resolution,automaticPenalty:false});});
app.get('/api/restaurants/:id/business-hours',(req,res)=>{const restaurant=db.prepare("SELECT r.id FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.id=? AND r.active=1").get(Number(req.params.id));if(!restaurant)return res.status(404).json({error:'Restaurante no encontrado'});const hours=db.prepare('SELECT weekday,is_closed,opens_at,closes_at FROM restaurant_business_hours WHERE restaurant_id=? ORDER BY weekday').all(restaurant.id),specialHours=db.prepare("SELECT service_date,is_closed,opens_at,closes_at,note FROM restaurant_special_hours WHERE restaurant_id=? AND service_date>=date('now','-1 day') ORDER BY service_date LIMIT 60").all(restaurant.id),status=restaurantOperationalScheduleStatus(restaurant.id,new Date());res.json({configured:hours.length===7,openNow:status.open,hours,specialHours,currentException:status.special?status:null,timeZone:'America/Mexico_City'});});
const deliveryQuote=(restaurant,lat,lng)=>{
    if(restaurant.latitude===null||restaurant.latitude===undefined||restaurant.longitude===null||restaurant.longitude===undefined||!Number.isFinite(Number(restaurant.latitude))||!Number.isFinite(Number(restaurant.longitude))){return {distanceKm:null,deliveryFee:35,zoneName:'Tarifa base provisional'};}
    const distance=Math.round(distanceKm(Number(restaurant.latitude),Number(restaurant.longitude),lat,lng)*100)/100;
    const zone=db.prepare('SELECT * FROM delivery_zones WHERE available=1 AND ? >= min_distance_km AND ? <= max_distance_km ORDER BY priority DESC,max_distance_km LIMIT 1').get(distance,distance);
    if(!zone)return {distanceKm:distance,unavailable:true};
    return {distanceKm:distance,deliveryFee:Math.round((Number(zone.base_fee)+Math.max(0,distance-Number(zone.min_distance_km))*Number(zone.surcharge_per_km))*100)/100,zoneName:zone.name,minimumOrder:Number(zone.minimum_order)};
};

app.get('/api/customer/addresses',auth,role(['customer']),(req,res)=>res.json(db.prepare('SELECT id,label,address,reference,latitude,longitude,is_default,created_at,updated_at FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,id DESC').all(req.user.id)));
app.post('/api/customer/addresses',auth,role(['customer']),rateLimit('customer-addresses',20,60*60*1000),(req,res)=>{const label=String(req.body.label||'Casa').trim().slice(0,40),address=String(req.body.address||'').trim().slice(0,300),reference=String(req.body.reference||'').trim().slice(0,200),latitude=Number(req.body.latitude),longitude=Number(req.body.longitude),makeDefault=req.body.isDefault===true;if(!label||address.length<5||!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180)return res.status(400).json({error:'Dirección o ubicación inválida'});if(db.prepare('SELECT COUNT(*) total FROM customer_addresses WHERE customer_id=?').get(req.user.id).total>=10)return res.status(409).json({error:'Puedes guardar hasta 10 direcciones'});const id=db.transaction(()=>{if(makeDefault)db.prepare('UPDATE customer_addresses SET is_default=0 WHERE customer_id=?').run(req.user.id);const result=db.prepare('INSERT INTO customer_addresses(customer_id,label,address,reference,latitude,longitude,is_default) VALUES(?,?,?,?,?,?,?)').run(req.user.id,label,address,reference,latitude,longitude,makeDefault?1:0);return Number(result.lastInsertRowid)})();audit(req,'customer_address_created','customer_address',id);res.status(201).json(db.prepare('SELECT id,label,address,reference,latitude,longitude,is_default FROM customer_addresses WHERE id=?').get(id));});
app.put('/api/customer/addresses/:id',auth,role(['customer']),(req,res)=>{const id=Number(req.params.id),label=String(req.body.label||'Casa').trim().slice(0,40),address=String(req.body.address||'').trim().slice(0,300),reference=String(req.body.reference||'').trim().slice(0,200),latitude=Number(req.body.latitude),longitude=Number(req.body.longitude),makeDefault=req.body.isDefault===true;if(!label||address.length<5||!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180)return res.status(400).json({error:'Dirección o ubicación inválida'});const result=db.transaction(()=>{if(makeDefault)db.prepare('UPDATE customer_addresses SET is_default=0 WHERE customer_id=?').run(req.user.id);return db.prepare('UPDATE customer_addresses SET label=?,address=?,reference=?,latitude=?,longitude=?,is_default=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND customer_id=?').run(label,address,reference,latitude,longitude,makeDefault?1:0,id,req.user.id)})();if(result.changes!==1)return res.status(404).json({error:'Dirección no encontrada'});audit(req,'customer_address_updated','customer_address',id);res.json({ok:true});});
app.delete('/api/customer/addresses/:id',auth,role(['customer']),(req,res)=>{const id=Number(req.params.id),result=db.prepare('DELETE FROM customer_addresses WHERE id=? AND customer_id=?').run(id,req.user.id);if(result.changes!==1)return res.status(404).json({error:'Dirección no encontrada'});audit(req,'customer_address_deleted','customer_address',id);res.json({ok:true});});

app.post('/api/delivery-quote',auth,role(['customer']),rateLimit('quote',60,60*1000),(req,res)=>{
    const lat=Number(req.body.deliveryLatitude),lng=Number(req.body.deliveryLongitude);
    if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)return res.status(400).json({error:'Datos de entrega inválidos'});
    const restaurant=db.prepare("SELECT r.id,r.latitude,r.longitude FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.id=? AND r.active=1").get(req.body.restaurantId);
    if(!restaurant)return res.status(404).json({error:'Restaurante no disponible'});
    const quote=deliveryQuote(restaurant,lat,lng);if(quote.unavailable)return res.status(409).json({error:'La entrega no está disponible para esa ubicación',...quote});res.json(quote);
});

app.post('/api/orders',auth,role(['customer']),rateLimit('orders',ORDER_RATE_LIMIT_MAX,10*60*1000),async(req,res,next)=>{try{
    refreshTemporaryAvailability();
    if(hasCorrectiveAction(req.user.id,'temporary_restriction'))return res.status(403).json({error:'Tu cuenta tiene una restricción temporal para pedidos nuevos. Consulta Mi cuenta o soporte.'});
    if(hasCorrectiveAction(req.user.id,'verification_required')){const verified=db.prepare('SELECT email_verified,phone_verified FROM users WHERE id=?').get(req.user.id);if(!verified.email_verified&&!verified.phone_verified)return res.status(403).json({error:'Verifica tu correo o teléfono antes de crear otro pedido.'});}
    if(hasSensitiveCardData(req.body))return res.status(400).json({error:'COME SAYULA no recibe ni almacena números de tarjeta o códigos de seguridad'});
    const {restaurantId,items,address,deliveryLatitude,deliveryLongitude,clientRequestId}=req.body;
    const deliveryMethod=String(req.body.deliveryMethod||'contact');
    const paymentMethod=String(req.body.paymentMethod||'Efectivo');
    const allowedPayments=['Efectivo','Transferencia','Tarjeta al recibir',...(mercadoPagoConfigured()?['Mercado Pago']:[])];
    if(!restaurantId||!Array.isArray(items)||!items.length||items.length>50||!String(address||'').trim()||!allowedPayments.includes(paymentMethod)||!['contact','no_contact'].includes(deliveryMethod))return res.status(400).json({error:'Datos del pedido inválidos'});
    if(!/^[a-zA-Z0-9-]{16,80}$/.test(String(clientRequestId||'')))return res.status(400).json({error:'Identificador de pedido inválido'});
    const existing=db.prepare('SELECT id,total,subtotal,delivery_fee,distance_km,payment_status,provider_checkout_url,estimated_prep_minutes,order_timing,scheduled_for FROM orders WHERE customer_id=? AND client_request_id=?').get(req.user.id,clientRequestId);
    if(existing)return res.json({orderId:existing.id,total:existing.total,subtotal:existing.subtotal,deliveryFee:existing.delivery_fee,distanceKm:existing.distance_km,paymentStatus:existing.payment_status,checkoutUrl:existing.provider_checkout_url,estimatedPrepMinutes:existing.estimated_prep_minutes,orderTiming:existing.order_timing,scheduledFor:existing.scheduled_for,repeated:true});
    const timing=normalizeOrderTiming(req.body);
    if(timing.error)return res.status(400).json({error:timing.error});
    const lat=Number(deliveryLatitude),lng=Number(deliveryLongitude);
    if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)return res.status(400).json({error:'Selecciona una ubicación válida para la entrega'});
    const restaurant=db.prepare("SELECT r.id,r.owner_id,r.latitude,r.longitude,r.operational_status,r.prep_minutes,r.auto_saturation_enabled,r.auto_saturation_limit FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.id=? AND r.active=1").get(restaurantId);
    if(!restaurant)return res.status(404).json({error:'Restaurante no disponible'});
    if(hasCorrectiveAction(restaurant.owner_id,'temporary_restriction'))return res.status(409).json({error:'El restaurante no está recibiendo pedidos nuevos temporalmente'});
    const restaurantLoad=restaurantLoadState(restaurant);if(['closed','paused'].includes(restaurantLoad.effectiveStatus))return res.status(409).json({error:restaurantLoad.effectiveStatus==='paused'?'El restaurante pausó temporalmente los pedidos':'El restaurante está cerrado'});
    const schedule=restaurantOperationalScheduleStatus(restaurant.id,timing.scheduledFor?new Date(timing.scheduledFor):new Date());if(!schedule.open)return res.status(409).json({error:timing.orderTiming==='scheduled'?'El restaurante no abre en la fecha y hora seleccionadas':'El restaurante está fuera de su horario de servicio'});
    const getProduct=db.prepare('SELECT id,name,price,available,category,stock_enabled,stock_quantity,variants_json,addons_json FROM products WHERE id=? AND restaurant_id=?');
    const normalized=[];let subtotal=0;
    for(const item of items){const product=getProduct.get(item.productId,restaurantId);const quantity=Number(item.quantity);if(!product||!Number.isInteger(quantity)||quantity<1||quantity>30)return res.status(400).json({error:'Producto o cantidad inválida'});if(product.stock_enabled&&product.stock_quantity<quantity)return res.status(409).json({error:`Sólo quedan ${product.stock_quantity} unidades de ${product.name}`});if(!product.available)return res.status(400).json({error:'Producto o cantidad inválida'});let choice;try{choice=productSelection(product,item)}catch(error){return res.status(400).json({error:error.message})}subtotal+=choice.unitPrice*quantity;normalized.push({...product,...choice,quantity});}
    if(normalized.some(item=>item.category==='Bebidas alcohólicas')&&req.body.ageConfirmed!==true)return res.status(403).json({error:'Confirma que quien recibirá bebidas alcohólicas es mayor de 18 años'});
    subtotal=Math.round(subtotal*100)/100;
    const quote=deliveryQuote(restaurant,lat,lng);
    if(quote.unavailable)return res.status(409).json({error:'La entrega no está disponible para esa ubicación'});
    if(subtotal<Number(quote.minimumOrder||0))return res.status(409).json({error:'El pedido mínimo para '+quote.zoneName+' es de $'+Number(quote.minimumOrder).toFixed(2)});
    let couponResult;try{couponResult=validateCoupon(req.body.couponCode,req.user.id,restaurantId,subtotal,quote.deliveryFee)}catch(error){return res.status(409).json({error:error.message})}
    const creditRequested=req.body.useCredits===true,creditUse=creditRequested?Math.min(availableCredit(req.user.id),Math.max(0,subtotal+quote.deliveryFee-couponResult.discount)):0,grossTotal=Math.round((subtotal+quote.deliveryFee)*100)/100;
    const total=Math.round(Math.max(0,grossTotal-couponResult.discount-creditUse)*100)/100;
    const risk=assessOrderRisk(req.user.id,grossTotal,paymentMethod);if(hasCorrectiveAction(req.user.id,'benefit_reduction'))risk.cashLimit=Math.min(risk.cashLimit,300);
    if(paymentMethod==='Efectivo'&&grossTotal>risk.cashLimit)return res.status(409).json({error:'Por seguridad, tu límite actual para efectivo es de $'+risk.cashLimit.toFixed(2)+'. Elige transferencia, tarjeta al recibir o pago en línea.',riskLevel:risk.level,cashLimit:risk.cashLimit});
    if(grossTotal>=LARGE_ORDER_AMOUNT&&paymentMethod==='Efectivo')return res.status(409).json({error:'Los pedidos de monto alto requieren un método distinto de efectivo y confirmación adicional.',riskLevel:'verification'});
    const onlinePayment=paymentMethod==='Mercado Pago',paymentStatus=onlinePayment?'awaiting_online_payment':paymentMethod==='Transferencia'?'awaiting_confirmation':'pay_on_delivery';if(onlinePayment&&total<1)return res.status(409).json({error:'El crédito cubre el pedido; elige un método al recibir para finalizar sin abrir un cobro en línea.'});
    const estimatedPrepMinutes=restaurantLoad.effectivePrepMinutes;
    let orderId;try{orderId=db.transaction(()=>{const order=db.prepare('INSERT INTO orders(customer_id,restaurant_id,address,payment_method,total,delivery_latitude,delivery_longitude,subtotal,delivery_fee,distance_km,payment_status,client_request_id,estimated_prep_minutes,age_confirmed,order_timing,scheduled_for,payment_provider,delivery_method,coupon_id,credit_used) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(req.user.id,restaurantId,String(address).trim().slice(0,500),paymentMethod,total,lat,lng,subtotal,quote.deliveryFee,quote.distanceKm,paymentStatus,clientRequestId,estimatedPrepMinutes,req.body.ageConfirmed?1:0,timing.orderTiming,timing.scheduledFor,onlinePayment?'mercadopago':null,deliveryMethod,couponResult.coupon?.id||null,creditUse);const id=Number(order.lastInsertRowid),commission=Math.round(subtotal*PLATFORM_COMMISSION_PERCENT)/100;const insert=db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity,options_description) VALUES(?,?,?,?,?,?)');normalized.forEach(item=>{insert.run(id,item.id,item.name,item.unitPrice,item.quantity,item.optionsDescription);if(item.stock_enabled){const stockChange=db.prepare('UPDATE products SET stock_quantity=stock_quantity-?,available=CASE WHEN stock_quantity-?<=0 THEN 0 ELSE available END WHERE id=? AND available=1 AND stock_quantity>=?').run(item.quantity,item.quantity,item.id,item.quantity);if(stockChange.changes!==1)throw new Error('INVENTORY_CHANGED:'+item.name);}});if(couponResult.coupon)db.prepare('INSERT INTO coupon_redemptions(coupon_id,customer_id,order_id,amount) VALUES(?,?,?,?)').run(couponResult.coupon.id,req.user.id,id,couponResult.discount);let remainingCredit=creditUse;if(remainingCredit>0){for(const credit of db.prepare("SELECT id,remaining_amount FROM customer_credits WHERE customer_id=? AND remaining_amount>0 AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP) ORDER BY expires_at IS NULL,expires_at,id").all(req.user.id)){const used=Math.min(remainingCredit,Number(credit.remaining_amount));if(used<=0)continue;db.prepare('UPDATE customer_credits SET remaining_amount=remaining_amount-? WHERE id=? AND remaining_amount>=?').run(used,credit.id,used);db.prepare('INSERT INTO credit_uses(credit_id,order_id,amount) VALUES(?,?,?)').run(credit.id,id,used);remainingCredit=Math.round((remainingCredit-used)*100)/100;if(remainingCredit<=0)break;}if(remainingCredit>0)throw new Error('CREDIT_CHANGED');}db.prepare('INSERT INTO order_financials(order_id,subtotal,delivery_fee,platform_commission,tip,discount,total_charged,payment_method,payment_status,restaurant_due,courier_due) VALUES(?,?,?,?,0,?,?,?,?,?,?)').run(id,subtotal,quote.deliveryFee,commission,couponResult.discount+creditUse,total,paymentMethod,paymentStatus,subtotal-commission,quote.deliveryFee);if(!onlinePayment)recordOrderStatus(id,null,'received',req.user,timing.orderTiming==='scheduled'?'Pedido programado creado por el cliente':'Pedido inmediato creado por el cliente');return id;})();}catch(error){if(error.message.startsWith('INVENTORY_CHANGED:'))return res.status(409).json({error:'La existencia de '+error.message.slice(18)+' cambió; actualiza el carrito'});if(error.message==='CREDIT_CHANGED')return res.status(409).json({error:'Tu saldo cambió; actualiza el pedido'});throw error;}
    db.prepare('INSERT INTO order_risk_assessments(order_id,customer_id,score,level,action,signals_json) VALUES(?,?,?,?,?,?)').run(orderId,req.user.id,risk.score,risk.level,risk.action,JSON.stringify(risk.signals));
    let checkoutUrl=null;if(onlinePayment){try{const baseUrl=publicAppBase(req),expiresAt=new Date(Date.now()+30*60*1000),preference=await mercadoPagoRequest('/checkout/preferences',{method:'POST',headers:{'X-Idempotency-Key':'come-sayula-order-'+orderId},body:JSON.stringify({items:[{id:'order-'+orderId,title:'Pedido COME SAYULA #'+orderId,quantity:1,currency_id:'MXN',unit_price:total}],external_reference:'order:'+orderId,back_urls:{success:baseUrl+'/payment-return.html?order='+orderId,pending:baseUrl+'/payment-return.html?order='+orderId,failure:baseUrl+'/payment-return.html?order='+orderId},auto_return:'approved',notification_url:baseUrl+'/api/payments/mercadopago/webhook',expires:true,expiration_date_from:new Date().toISOString(),expiration_date_to:expiresAt.toISOString()})});checkoutUrl=MERCADOPAGO_MODE==='test'?(preference.sandbox_init_point||preference.init_point):preference.init_point;if(!preference.id||!checkoutUrl)throw new Error('Mercado Pago no devolvió el enlace de pago');db.prepare('UPDATE orders SET provider_preference_id=?,provider_checkout_url=?,payment_expires_at=? WHERE id=?').run(String(preference.id),String(checkoutUrl),expiresAt.toISOString(),orderId);}catch(error){cancelPendingOnlineOrder(orderId,'No se pudo iniciar el pago en línea');console.error('MERCADOPAGO PREFERENCE ERROR ['+req.requestId+']',error.message);return res.status(502).json({error:'No fue posible abrir Mercado Pago. No se realizó ningún cobro; intenta nuevamente.'});}}
    audit(req,'order_created','order',orderId);
    res.status(201).json({orderId,total,subtotal,deliveryFee:quote.deliveryFee,discount:couponResult.discount,creditUsed:creditUse,couponCode:couponResult.coupon?.code||null,distanceKm:quote.distanceKm,zoneName:quote.zoneName,paymentStatus,checkoutUrl,estimatedPrepMinutes,orderTiming:timing.orderTiming,scheduledFor:timing.scheduledFor});
}catch(error){next(error)}});
app.post('/api/payments/mercadopago/confirm',auth,role(['customer']),rateLimit('payment-confirm',30,10*60*1000),async(req,res)=>{try{const orderId=Number(req.body.orderId),paymentId=String(req.body.paymentId||'');if(!Number.isInteger(orderId)||!/^[A-Za-z0-9_-]{1,100}$/.test(paymentId))return res.status(400).json({error:'Datos de pago inválidos'});const order=db.prepare("SELECT id,payment_status FROM orders WHERE id=? AND customer_id=? AND payment_provider='mercadopago'").get(orderId,req.user.id);if(!order)return res.status(404).json({error:'Pedido no encontrado'});if(order.payment_status==='paid')return res.json({ok:true,status:'paid',repeated:true});const payment=await mercadoPagoRequest('/v1/payments/'+encodeURIComponent(paymentId));const activated=activatePaidOnlineOrder(orderId,payment);audit(req,'online_payment_confirmed','order',orderId);res.json({ok:true,status:'paid',activated});}catch(error){console.error('MERCADOPAGO CONFIRM ERROR ['+req.requestId+']',error.message);res.status(409).json({error:'El pago todavía no aparece aprobado o no coincide con el pedido'})}});
app.post('/api/payments/mercadopago/webhook',rateLimit('payment-webhook',120,60*1000),async(req,res)=>{try{if(!mercadoPagoConfigured()||!MERCADOPAGO_WEBHOOK_SECRET)return res.status(503).json({error:'Webhook no configurado'});const signature=String(req.headers['x-signature']||''),requestId=String(req.headers['x-request-id']||''),paymentId=String(req.query['data.id']||req.body?.data?.id||'').toLowerCase(),parts=Object.fromEntries(signature.split(',').map(part=>part.trim().split('=')));if(!paymentId||!parts.ts||!parts.v1)return res.status(400).json({error:'Notificación inválida'});const manifest=`id:${paymentId};request-id:${requestId};ts:${parts.ts};`,expected=crypto.createHmac('sha256',MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest('hex'),received=Buffer.from(parts.v1,'hex'),wanted=Buffer.from(expected,'hex');if(received.length!==wanted.length||!crypto.timingSafeEqual(received,wanted))return res.status(401).json({error:'Firma inválida'});const payment=await mercadoPagoRequest('/v1/payments/'+encodeURIComponent(paymentId)),match=/^order:(\d+)$/.exec(String(payment.external_reference||''));if(match)activatePaidOnlineOrder(Number(match[1]),payment);res.sendStatus(200);}catch(error){console.error('MERCADOPAGO WEBHOOK ERROR ['+req.requestId+']',error.message);res.sendStatus(200)}});
app.get('/api/orders/my',auth,role(['customer']),(req,res)=>{let os=db.prepare(`SELECT o.*,r.name restaurant_name,rv.restaurant_rating,rv.delivery_rating,rv.comment review_comment,rv.tip_amount,rv.tip_method FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN order_reviews rv ON rv.order_id=o.id WHERE o.customer_id=? ORDER BY o.id DESC`).all(req.user.id);let it=db.prepare('SELECT * FROM order_items WHERE order_id=?');res.json(os.map(o=>({...o,responseDeadline:o.status==='received'?new Date(new Date(o.created_at+'Z').getTime()+ORDER_RESPONSE_MINUTES*60000).toISOString():null,items:it.all(o.id)})))});
app.get('/api/orders/:id/repeat',auth,role(['customer']),(req,res)=>{const order=db.prepare('SELECT o.id,o.restaurant_id,r.name restaurant_name,r.active,r.operational_status FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=? AND o.customer_id=?').get(req.params.id,req.user.id);if(!order)return res.status(404).json({error:'Pedido no encontrado'});if(!order.active||['closed','paused'].includes(order.operational_status))return res.status(409).json({error:'El restaurante no está recibiendo pedidos'});const previous=db.prepare('SELECT product_id,quantity,options_description FROM order_items WHERE order_id=?').all(order.id),items=[],warnings=[];for(const old of previous){const p=db.prepare('SELECT id,name,price,category,available,stock_enabled,stock_quantity,variants_json,addons_json FROM products WHERE id=? AND restaurant_id=?').get(old.product_id,order.restaurant_id);if(!p||!p.available){warnings.push('Un producto ya no está disponible');continue}let variants=[],addons=[];try{variants=JSON.parse(p.variants_json||'[]');addons=JSON.parse(p.addons_json||'[]')}catch{}const names=String(old.options_description||'').split(',').map(x=>x.trim()).filter(Boolean),variant=variants.find(v=>names.includes(v.name))?.name||'',selected=addons.filter(a=>names.includes(a.name)).map(a=>a.name),recognized=new Set([variant,...selected].filter(Boolean));if(names.some(name=>!recognized.has(name)))warnings.push(p.name+' cambió sus opciones; revisa los complementos actuales');let choice;try{choice=productSelection(p,{variant,addons:selected})}catch{warnings.push(p.name+' cambió sus opciones');continue}const quantity=p.stock_enabled?Math.min(Number(old.quantity),Number(p.stock_quantity)):Number(old.quantity);if(quantity<1){warnings.push(p.name+' está agotado');continue}items.push({id:p.id,name:p.name,price:choice.unitPrice,category:p.category,quantity,restaurantId:order.restaurant_id,restaurantName:order.restaurant_name,variant,addons:selected,optionsDescription:choice.optionsDescription,optionKey:variant+'|'+selected.join('|')});}if(!items.length)return res.status(409).json({error:'Los productos de ese pedido ya no están disponibles'});res.json({items,warnings});});
app.post('/api/orders/:id/cancel-no-response',auth,role(['customer']),(req,res)=>{const id=Number(req.params.id),order=db.prepare('SELECT id,status,created_at FROM orders WHERE id=? AND customer_id=?').get(id,req.user.id);if(!order)return res.status(404).json({error:'Pedido no encontrado'});if(order.status!=='received')return res.status(409).json({error:'El restaurante ya respondió o el pedido ya fue cerrado'});if(Date.now()-new Date(order.created_at+'Z').getTime()<ORDER_RESPONSE_MINUTES*60000)return res.status(409).json({error:'El tiempo de respuesta todavía no termina'});const changed=db.transaction(()=>{const result=db.prepare("UPDATE orders SET status='cancelled',payment_status='cancelled' WHERE id=? AND status='received'").run(id);if(result.changes===1){reverseOrderFinancials(id,'Cancelación sin penalización por falta de respuesta');recordOrderStatus(id,'received','cancelled',req.user,'Cancelación sin penalización por falta de respuesta');}return result;})();if(changed.changes!==1)return res.status(409).json({error:'El pedido cambió; actualiza la pantalla'});audit(req,'order_cancelled_no_response','order',id);res.json({ok:true,status:'cancelled'});});
app.post('/api/orders/:id/cancel',auth,role(['customer']),rateLimit('customer-cancel',20,60*60*1000),(req,res)=>{const id=Number(req.params.id),reason=String(req.body.reason||'').trim().slice(0,300),order=db.prepare('SELECT id,status,payment_status FROM orders WHERE id=? AND customer_id=?').get(id,req.user.id);if(!order)return res.status(404).json({error:'Pedido no encontrado'});if(reason.length<3)return res.status(400).json({error:'Escribe brevemente el motivo de la cancelación'});if(order.status!=='received')return res.status(409).json({error:'El restaurante ya aceptó el pedido; solicita ayuda para cualquier cambio'});if(order.payment_status==='paid')return res.status(409).json({error:'Este pedido ya fue pagado en línea; solicita ayuda para tramitar el reembolso'});const changed=db.transaction(()=>{const result=db.prepare("UPDATE orders SET status='cancelled',payment_status='cancelled',cancellation_reason=? WHERE id=? AND customer_id=? AND status='received'").run(reason,id,req.user.id);if(result.changes===1){restoreOrderInventory(id);reverseOrderFinancials(id,'Cancelación del cliente antes de aceptación: '+reason);recordOrderStatus(id,'received','cancelled',req.user,'Cancelación del cliente: '+reason);}return result;})();if(changed.changes!==1)return res.status(409).json({error:'El pedido cambió; actualiza la pantalla'});audit(req,'order_cancelled_by_customer','order',id);res.json({ok:true,status:'cancelled'});});
app.post('/api/auth/google',rateLimit('google-login',10,15*60*1000),async(req,res)=>{
    try{
        const {credential}=req.body;

        if(!credential){
            return res.status(400).json({
                error:'Falta la credencial de Google'
            });
        }

        const ticket=await googleClient.verifyIdToken({
            idToken:credential,
            audience:GOOGLE_CLIENT_ID
        });

        const payload=ticket.getPayload();

        if(!payload){
            return res.status(401).json({
                error:'Credencial de Google inválida'
            });
        }

        const googleId=payload.sub;
        const email=(payload.email||'').toLowerCase();
        const name=payload.name||payload.email||'Usuario';

        if(!googleId||!email){
            return res.status(400).json({
                error:'Google no proporcionó los datos necesarios'
            });
        }

        let user=db.prepare(
            'SELECT id,name,email,phone,role,google_id,account_status,session_version FROM users WHERE google_id=?'
        ).get(googleId);

        if(!user){
            user=db.prepare(
                'SELECT id,name,email,phone,role,google_id,account_status,session_version FROM users WHERE email=?'
            ).get(email);
        }

        if(user){
            if(user.role!=='customer'||user.account_status!=='approved')return res.status(403).json({error:'Google sólo está disponible para cuentas de cliente aprobadas'});

            if(!user.google_id){
                db.prepare(
                    'UPDATE users SET google_id=? WHERE id=?'
                ).run(googleId,user.id);
            }

        }else{
            if(req.body.termsAccepted!==true)return res.status(400).json({error:'Debes aceptar los términos y el aviso de privacidad para crear la cuenta'});

            const passwordHash=await bcrypt.hash(
                'google_'+googleId,
                10
            );

            const result=db.prepare(`
                INSERT INTO users
                (name,email,phone,password_hash,role,google_id,terms_accepted_at,terms_version)
                VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,'2026-09-08')
            `).run(
                name,
                email,
                '',
                passwordHash,
                'customer',
                googleId
            );

            user={
                id:Number(result.lastInsertRowid),
                name,
                email,
                phone:'',
                role:'customer',
                google_id:googleId,
                account_status:'approved'
            };
        }

        const sessionUser={
            id:user.id,
            name:user.name,
            email:user.email,
            phone:user.phone||'',
            role:user.role
        };

        const token=signToken(user);

        res.json({
            token,
            user:sessionUser
        });

    }catch(e){

        console.error('GOOGLE AUTH ERROR:',e);

        res.status(401).json({
            error:'No se pudo autenticar con Google'
        });
    }
});
app.get('/api/restaurant/me',auth,restaurantAccess(),(req,res)=>{refreshTemporaryAvailability();const r=req.restaurant,products=db.prepare('SELECT * FROM products WHERE restaurant_id=?').all(r.id),orders=db.prepare("SELECT o.*,u.name customer_name,u.phone customer_phone,EXISTS(SELECT 1 FROM delivery_assignments da WHERE da.order_id=o.id AND da.status='accepted') AS delivery_assigned FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.restaurant_id=? AND o.payment_status!='awaiting_online_payment' ORDER BY CASE WHEN o.order_timing='scheduled' AND o.status NOT IN ('delivered','cancelled') THEN 0 ELSE 1 END,julianday(o.scheduled_for),o.id DESC").all(r.id),it=db.prepare('SELECT * FROM order_items WHERE order_id=?');const access={isOwner:Boolean(r.is_owner),canManageOrders:Boolean(r.can_manage_orders),canManageProducts:Boolean(r.can_manage_products),canViewFinance:Boolean(r.can_view_finance),canUsePos:Boolean(r.can_use_pos)};res.json({...r,access,products:access.canManageProducts||access.canUsePos||access.isOwner?products:[],orders:access.canManageOrders?orders.map(o=>{const closed=['delivered','cancelled'].includes(o.status);return {...scheduledOrderView(o),customer_phone:closed?null:o.customer_phone,address:closed?'Datos ocultos al cerrar el pedido':o.address,delivery_latitude:closed?null:o.delivery_latitude,delivery_longitude:closed?null:o.delivery_longitude,items:it.all(o.id)}}):[]})});
app.get('/api/restaurant/settlement',auth,restaurantAccess('can_view_finance'),(req,res)=>{const rows=db.prepare(`SELECT date(o.created_at) day,COUNT(CASE WHEN o.status='delivered' THEN 1 END) orders_count,ROUND(SUM(CASE WHEN o.status='delivered' THEN f.subtotal ELSE 0 END),2) sales,ROUND(SUM(CASE WHEN o.status='delivered' THEN f.platform_commission ELSE 0 END),2) commission,ROUND(SUM(CASE WHEN o.status='delivered' AND f.payment_method='Efectivo' THEN f.total_charged ELSE 0 END),2) cash_orders,ROUND(SUM(CASE WHEN o.status='delivered' AND f.payment_method!='Efectivo' THEN f.total_charged ELSE 0 END),2) digital_orders,ROUND(SUM(CASE WHEN o.status='delivered' THEN f.restaurant_due ELSE 0 END),2) restaurant_due,ROUND(SUM(CASE WHEN o.status='delivered' AND f.settlement_status='pending' THEN f.restaurant_due ELSE 0 END),2) pending_due,ROUND(SUM(CASE WHEN o.status='delivered' AND f.settlement_status='paid' THEN f.restaurant_due ELSE 0 END),2) paid_due,COUNT(CASE WHEN o.status='cancelled' THEN 1 END) cancellations,ROUND(SUM(CASE WHEN o.status='cancelled' THEN f.reversal_amount ELSE 0 END),2) reversed_amount FROM orders o JOIN order_financials f ON f.order_id=o.id WHERE o.restaurant_id=? AND o.is_demo=0 GROUP BY date(o.created_at) ORDER BY day DESC LIMIT 60`).all(req.restaurant.id);const batches=db.prepare('SELECT id,period_date,amount,reference,proof_url,paid_at FROM settlement_batches WHERE restaurant_id=? ORDER BY paid_at DESC LIMIT 60').all(req.restaurant.id).map(b=>({...b,proof_url:b.proof_url?'/api/settlements/'+b.id+'/proof':null}));res.json({commissionPercent:PLATFORM_COMMISSION_PERCENT,days:rows,batches});});
app.get('/api/restaurant/analytics',auth,restaurantAccess('can_view_finance'),(req,res)=>{const days=[7,30,90].includes(Number(req.query.days))?Number(req.query.days):7,rid=req.restaurant.id,since=`-${days-1} days`;const delivery=db.prepare(`SELECT COUNT(*) sales_count,ROUND(COALESCE(SUM(f.total_charged),0),2) total,ROUND(COALESCE(SUM(f.subtotal),0),2) restaurant_sales FROM orders o JOIN order_financials f ON f.order_id=o.id WHERE o.restaurant_id=? AND o.status='delivered' AND o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?)`).get(rid,since),pos=db.prepare(`SELECT COUNT(*) sales_count,ROUND(COALESCE(SUM(total),0),2) total FROM pos_sales WHERE restaurant_id=? AND status='completed' AND date(created_at)>=date('now','localtime',?)`).get(rid,since),topProducts=db.prepare(`SELECT product_name,SUM(quantity) quantity,ROUND(SUM(amount),2) amount FROM (SELECT i.product_name,i.quantity,i.unit_price*i.quantity amount FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.restaurant_id=? AND o.status='delivered' AND o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?) UNION ALL SELECT i.product_name,i.quantity,i.unit_price*i.quantity FROM pos_sale_items i JOIN pos_sales s ON s.id=i.sale_id WHERE s.restaurant_id=? AND s.status='completed' AND date(s.created_at)>=date('now','localtime',?)) GROUP BY product_name ORDER BY quantity DESC,amount DESC LIMIT 10`).all(rid,since,rid,since),payments=db.prepare(`SELECT method,COUNT(*) count,ROUND(SUM(total),2) total FROM (SELECT payment_method method,total FROM orders WHERE restaurant_id=? AND status='delivered' AND is_demo=0 AND date(created_at)>=date('now','localtime',?) UNION ALL SELECT payment_method,total FROM pos_sales WHERE restaurant_id=? AND status='completed' AND date(created_at)>=date('now','localtime',?)) GROUP BY method ORDER BY total DESC`).all(rid,since,rid,since),hours=db.prepare(`SELECT hour,COUNT(*) count FROM (SELECT strftime('%H',created_at) hour FROM orders WHERE restaurant_id=? AND status='delivered' AND is_demo=0 AND date(created_at)>=date('now','localtime',?) UNION ALL SELECT strftime('%H',created_at) FROM pos_sales WHERE restaurant_id=? AND status='completed' AND date(created_at)>=date('now','localtime',?)) GROUP BY hour ORDER BY hour`).all(rid,since,rid,since),prep=db.prepare(`SELECT ROUND(AVG((julianday(ready.created_at)-julianday(accepted.created_at))*1440),1) average_minutes,COUNT(*) measured_orders FROM orders o JOIN order_status_history accepted ON accepted.order_id=o.id AND accepted.to_status='accepted' JOIN order_status_history ready ON ready.order_id=o.id AND ready.to_status='ready' WHERE o.restaurant_id=? AND o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?)`).get(rid,since),cash=db.prepare(`SELECT COUNT(*) sessions,ROUND(COALESCE(SUM(difference_amount),0),2) net_difference,ROUND(COALESCE(SUM(ABS(difference_amount)),0),2) absolute_difference FROM cash_sessions WHERE restaurant_id=? AND status='closed' AND date(closed_at)>=date('now','localtime',?)`).get(rid,since),ratings=db.prepare(`SELECT COUNT(rv.restaurant_rating) sample_count,ROUND(AVG(rv.restaurant_rating),1) overall,ROUND(AVG(rv.food_rating),1) food,ROUND(AVG(rv.completeness_rating),1) completeness,ROUND(AVG(rv.preparation_rating),1) preparation FROM order_reviews rv JOIN orders o ON o.id=rv.order_id WHERE rv.restaurant_id=? AND o.status='delivered' AND o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?)`).get(rid,since);res.json({days,delivery,pos,combinedTotal:Math.round((Number(delivery.total)+Number(pos.total))*100)/100,topProducts,payments,hours,prep,cash,ratings});});

app.get('/api/restaurant/optimization',auth,restaurantAccess('can_view_finance'),(req,res)=>{
 const days=[30,90].includes(+req.query.days)?+req.query.days:30,rid=req.restaurant.id,since=`-${days-1} days`,configured=Number(db.prepare('SELECT prep_minutes FROM restaurants WHERE id=?').get(rid).prep_minutes)||30;
 const prep=db.prepare(`SELECT ROUND(AVG((julianday(ready.created_at)-julianday(accepted.created_at))*1440),1) average_minutes,COUNT(*) sample_size FROM orders o JOIN order_status_history accepted ON accepted.order_id=o.id AND accepted.to_status='accepted' JOIN order_status_history ready ON ready.order_id=o.id AND ready.to_status='ready' WHERE o.restaurant_id=? AND o.status='delivered' AND o.is_demo=0 AND date(o.created_at)>=date('now','localtime',?) AND (julianday(ready.created_at)-julianday(accepted.created_at))*1440 BETWEEN 1 AND 180`).get(rid,since);
 const demand=db.prepare(`SELECT strftime('%H',created_at) hour,COUNT(*) orders FROM orders WHERE restaurant_id=? AND status='delivered' AND is_demo=0 AND date(created_at)>=date('now','localtime',?) GROUP BY hour ORDER BY orders DESC,hour LIMIT 1`).get(rid,since)||null,outcomes=db.prepare(`SELECT COUNT(*) total,SUM(status='cancelled') cancelled FROM orders WHERE restaurant_id=? AND is_demo=0 AND date(created_at)>=date('now','localtime',?) AND status IN ('delivered','cancelled')`).get(rid,since);
 const sample=Number(prep.sample_size)||0,measured=Number(prep.average_minutes)||null,confidence=sample>=30?'high':sample>=10?'medium':'insufficient',total=Number(outcomes.total)||0,cancellationRate=total?Math.round(Number(outcomes.cancelled||0)/total*1000)/10:0,recommendations=[];
 if(confidence==='insufficient')recommendations.push({type:'data',level:'info',title:'Sigue reuniendo datos',message:'Se necesitan al menos 10 pedidos entregados con tiempos completos antes de recomendar cambios.',sampleSize:sample});
 else if(measured>configured+5)recommendations.push({type:'prep',level:'attention',title:'Ajusta el tiempo mostrado',message:`La preparación medida es de ${measured} min y el tiempo configurado es ${configured} min. Considera aumentarlo.`,sampleSize:sample,suggestedMinutes:Math.ceil(measured/5)*5});
 else if(measured<configured-10)recommendations.push({type:'prep',level:'opportunity',title:'Revisa el tiempo configurado',message:`La preparación medida es de ${measured} min, menor que los ${configured} min configurados.`,sampleSize:sample,suggestedMinutes:Math.max(5,Math.ceil(measured/5)*5)});
 else recommendations.push({type:'prep',level:'good',title:'Tiempo de preparación consistente',message:`La preparación medida (${measured} min) coincide con el tiempo configurado (${configured} min).`,sampleSize:sample});
 if(total>=10&&cancellationRate>=15)recommendations.push({type:'cancellations',level:'attention',title:'Revisa las cancelaciones',message:`El ${cancellationRate}% de los pedidos cerrados terminó cancelado. Revisa motivos antes de tomar medidas.`,sampleSize:total});
 if(demand&&Number(demand.orders)>=5)recommendations.push({type:'demand',level:'opportunity',title:'Hora con mayor demanda',message:`La mayor concentración está alrededor de las ${demand.hour}:00. Considera preparar personal e inventario antes.`,sampleSize:Number(demand.orders)});
 res.json({days,confidence,minimumSample:10,metrics:{configuredPrepMinutes:configured,measuredPrepMinutes:measured,measuredOrders:sample,closedOrders:total,cancellationRate,peakHour:demand?.hour||null,peakHourOrders:Number(demand?.orders)||0},recommendations,automaticChanges:false});
});
const restaurantMemberPermissions=body=>{const positionRole=String(body.positionRole||'custom'),presets={manager:[1,1,1,1],cashier:[1,0,0,1],kitchen:[1,0,0,0]};if(!['manager','cashier','kitchen','custom'].includes(positionRole))return null;const values=presets[positionRole]||[body.canManageOrders?1:0,body.canManageProducts?1:0,body.canViewFinance?1:0,body.canUsePos?1:0];return {positionRole,orders:values[0],products:values[1],finance:values[2],pos:values[3]};};
app.get('/api/restaurant/employees',auth,restaurantAccess(),restaurantOwner,(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.account_status,m.position_role,m.can_manage_orders,m.can_manage_products,m.can_view_finance,m.can_use_pos,m.active,m.created_at FROM restaurant_members m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? ORDER BY m.created_at DESC`).all(req.restaurant.id)));
app.post('/api/restaurant/employees',auth,restaurantAccess(),restaurantOwner,rateLimit('restaurant-employees',12,60*60*1000),async(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),phone=String(req.body.phone||'').trim().slice(0,30),password=String(req.body.password||''),permissions=restaurantMemberPermissions(req.body);if(!name||!email||password.length<10||!permissions)return res.status(400).json({error:'Completa nombre, correo, contraseña y perfil válidos'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'Ese correo ya pertenece a otra cuenta'});const id=db.transaction(()=>{const created=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,email_verified) VALUES(?,?,?,?, 'restaurant_employee','approved',0)").run(name,email,phone,bcrypt.hashSync(password,12));db.prepare('INSERT INTO restaurant_members(user_id,restaurant_id,position_role,can_manage_orders,can_manage_products,can_view_finance,can_use_pos) VALUES(?,?,?,?,?,?,?)').run(created.lastInsertRowid,req.restaurant.id,permissions.positionRole,permissions.orders,permissions.products,permissions.finance,permissions.pos);return Number(created.lastInsertRowid)})();audit(req,'restaurant_employee_created','user',id);res.status(201).json({id,positionRole:permissions.positionRole});});
app.patch('/api/restaurant/employees/:id',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const id=Number(req.params.id),active=req.body.active===false?0:1,permissions=restaurantMemberPermissions(req.body);if(!permissions)return res.status(400).json({error:'Perfil de empleado inválido'});const result=db.prepare('UPDATE restaurant_members SET position_role=?,can_manage_orders=?,can_manage_products=?,can_view_finance=?,can_use_pos=?,active=? WHERE user_id=? AND restaurant_id=?').run(permissions.positionRole,permissions.orders,permissions.products,permissions.finance,permissions.pos,active,id,req.restaurant.id);if(result.changes!==1)return res.status(404).json({error:'Empleado no encontrado'});db.prepare("UPDATE users SET account_status=? WHERE id=? AND role='restaurant_employee'").run(active?'approved':'suspended',id);audit(req,'restaurant_employee_permissions_updated','user',id);res.json({ok:true,positionRole:permissions.positionRole});});

app.post('/api/restaurant/uploads',auth,restaurantAccess('can_manage_products'),async(req,res)=>{
    const match=String(req.body.dataUrl||'').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if(!match)return res.status(400).json({error:'Selecciona una imagen JPG, PNG o WEBP'});
    const buffer=Buffer.from(match[2],'base64');
    if(!buffer.length||buffer.length>4*1024*1024)return res.status(400).json({error:'La imagen debe pesar menos de 4 MB'});
    const validMagic=(match[1]==='jpeg'&&buffer[0]===0xff&&buffer[1]===0xd8)||(match[1]==='png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(match[1]==='webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP');
    if(!validMagic)return res.status(400).json({error:'El archivo no contiene una imagen válida'});
    try{const imageProcessor=require('sharp');const optimized=await imageProcessor(buffer,{limitInputPixels:40000000,failOn:'error'}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:80,effort:4}).toBuffer();const fileName=`restaurant-${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}.webp`;fs.writeFileSync(path.join(uploadsDir,fileName),optimized,{mode:0o600});res.status(201).json({url:'/uploads/'+fileName,originalBytes:buffer.length,storedBytes:optimized.length});}catch(e){res.status(400).json({error:'No fue posible procesar esta imagen. Prueba con otra fotografía.'});}
});

app.put('/api/restaurant/profile',auth,restaurantAccess(),restaurantOwner,(req,res)=>{
    const image=String(req.body.image||'').trim();
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    const previous=db.prepare('SELECT image FROM restaurants WHERE id=?').get(req.restaurant.id)?.image;
    db.prepare('UPDATE restaurants SET image=? WHERE id=?').run(image,req.restaurant.id);
    if(previous&&previous!==image)deleteLocalImage(previous);
    res.json({ok:true,image});
});
app.put('/api/restaurant/public-settings',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const values=[req.body.publicAddress,req.body.publicPhone,req.body.publicLocation];if(values.some(value=>typeof value!=='boolean'))return res.status(400).json({error:'Selecciona opciones de privacidad válidas'});db.prepare('UPDATE restaurants SET public_address=?,public_phone=?,public_location=? WHERE id=?').run(values[0]?1:0,values[1]?1:0,values[2]?1:0,req.restaurant.id);audit(req,'restaurant_public_info_updated','restaurant',req.restaurant.id);res.json({ok:true,publicAddress:values[0],publicPhone:values[1],publicLocation:values[2]});});
app.get('/api/restaurant/business-hours',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const rows=db.prepare('SELECT weekday,is_closed,opens_at,closes_at FROM restaurant_business_hours WHERE restaurant_id=? ORDER BY weekday').all(req.restaurant.id);res.json({configured:rows.length===7,hours:rows});});
app.put('/api/restaurant/business-hours',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const hours=Array.isArray(req.body.hours)?req.body.hours:[],time=/^(?:[01]\d|2[0-3]):[0-5]\d$/;if(hours.length!==7)return res.status(400).json({error:'Configura los siete días de la semana'});const normalized=[];for(let weekday=0;weekday<7;weekday++){const row=hours.find(item=>Number(item.weekday)===weekday),closed=row?.closed===true,opensAt=String(row?.opensAt||''),closesAt=String(row?.closesAt||'');if(!row||!closed&&(!time.test(opensAt)||!time.test(closesAt)||opensAt>=closesAt))return res.status(400).json({error:'Revisa apertura y cierre del día '+weekday});normalized.push({weekday,closed,opensAt:closed?'09:00':opensAt,closesAt:closed?'20:00':closesAt});}db.transaction(()=>{const save=db.prepare(`INSERT INTO restaurant_business_hours(restaurant_id,weekday,is_closed,opens_at,closes_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(restaurant_id,weekday) DO UPDATE SET is_closed=excluded.is_closed,opens_at=excluded.opens_at,closes_at=excluded.closes_at,updated_at=CURRENT_TIMESTAMP`);normalized.forEach(row=>save.run(req.restaurant.id,row.weekday,row.closed?1:0,row.opensAt,row.closesAt));})();audit(req,'restaurant_business_hours_updated','restaurant',req.restaurant.id);res.json({ok:true,hours:normalized});});
app.get('/api/restaurant/special-hours',auth,restaurantAccess(),restaurantOwner,(req,res)=>res.json(db.prepare("SELECT id,service_date,is_closed,opens_at,closes_at,note FROM restaurant_special_hours WHERE restaurant_id=? AND service_date>=date('now','-1 day') ORDER BY service_date LIMIT 60").all(req.restaurant.id)));
app.post('/api/restaurant/special-hours',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const date=String(req.body.date||''),closed=req.body.closed===true,opensAt=String(req.body.opensAt||''),closesAt=String(req.body.closesAt||''),note=String(req.body.note||'').trim().slice(0,150),time=/^(?:[01]\d|2[0-3]):[0-5]\d$/;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<sayulaDateKey(new Date())||!note||!closed&&(!time.test(opensAt)||!time.test(closesAt)||opensAt>=closesAt))return res.status(400).json({error:'Fecha, motivo u horario especial inválido'});db.prepare(`INSERT INTO restaurant_special_hours(restaurant_id,service_date,is_closed,opens_at,closes_at,note) VALUES(?,?,?,?,?,?) ON CONFLICT(restaurant_id,service_date) DO UPDATE SET is_closed=excluded.is_closed,opens_at=excluded.opens_at,closes_at=excluded.closes_at,note=excluded.note`).run(req.restaurant.id,date,closed?1:0,closed?null:opensAt,closed?null:closesAt,note);audit(req,'restaurant_special_hours_updated','restaurant',req.restaurant.id);res.status(201).json({ok:true});});
app.delete('/api/restaurant/special-hours/:id',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const result=db.prepare('DELETE FROM restaurant_special_hours WHERE id=? AND restaurant_id=?').run(Number(req.params.id),req.restaurant.id);if(!result.changes)return res.status(404).json({error:'Excepción no encontrada'});audit(req,'restaurant_special_hours_deleted','restaurant',req.restaurant.id);res.json({ok:true});});
app.put('/api/restaurant/availability',auth,restaurantAccess(),restaurantOwner,(req,res)=>{
    const status=String(req.body.status||''),prepMinutes=Number(req.body.prepMinutes),specialHours=String(req.body.specialHours||'').trim().slice(0,300),autoEnabled=req.body.autoSaturationEnabled===true,autoLimit=Number(req.body.autoSaturationLimit??5);
    if(!['open','closed','saturated','paused'].includes(status)||!Number.isInteger(prepMinutes)||prepMinutes<5||prepMinutes>180||!Number.isInteger(autoLimit)||autoLimit<1||autoLimit>50)return res.status(400).json({error:'Selecciona un estado, tiempo y límite de saturación válidos'});
    const result=db.prepare('UPDATE restaurants SET operational_status=?,prep_minutes=?,special_hours=?,auto_saturation_enabled=?,auto_saturation_limit=? WHERE id=?').run(status,prepMinutes,specialHours,autoEnabled?1:0,autoLimit,req.restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Restaurante no encontrado'});
    const load=restaurantLoadState({...req.restaurant,operational_status:status,prep_minutes:prepMinutes,auto_saturation_enabled:autoEnabled?1:0,auto_saturation_limit:autoLimit});audit(req,'restaurant_availability_updated','restaurant',req.restaurant.id);res.json({ok:true,status,prepMinutes,estimatedPrepMinutes:load.effectivePrepMinutes,specialHours,autoSaturationEnabled:autoEnabled,autoSaturationLimit:autoLimit,autoSaturated:load.autoSaturated});
});

app.put('/api/restaurant/location',auth,restaurantAccess(),restaurantOwner,(req,res)=>{
    const latitude=Number(req.body.latitude),longitude=Number(req.body.longitude);
    if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180)return res.status(400).json({error:'Ubicación inválida'});
    db.prepare('UPDATE restaurants SET latitude=?,longitude=? WHERE id=?').run(latitude,longitude,req.restaurant.id);
    audit(req,'restaurant_location_updated','restaurant',null);
    res.json({ok:true,latitude,longitude});
});
app.post('/api/restaurant/products',auth,restaurantAccess('can_manage_products'),(req,res)=>{
    const restaurant=req.restaurant;
    const name=String(req.body.name||'').trim();
    const description=String(req.body.description||'').trim();
    const image=String(req.body.image||'').trim();
    const price=Number(req.body.price);
    const category=String(req.body.category||'Comida');
    const stockEnabled=req.body.stockEnabled===true,stockQuantity=Math.max(0,Math.floor(Number(req.body.stockQuantity)||0)),lowStockThreshold=Math.max(0,Math.floor(Number(req.body.lowStockThreshold)||5));
    const variants=normalizeChoices(req.body.variants),addons=normalizeChoices(req.body.addons);
    const allowedCategories=['Comida','Bebidas','Bebidas alcohólicas','Postres','Extras'];
    if(!name||name.length>100||!Number.isFinite(price)||price<=0){
        return res.status(400).json({error:'Escribe un nombre y un precio mayor que cero'});
    }
    if(!allowedCategories.includes(category))return res.status(400).json({error:'Categoría inválida'});
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    const result=db.prepare('INSERT INTO products(restaurant_id,name,description,price,image,category,available,stock_enabled,stock_quantity,low_stock_threshold,variants_json,addons_json) VALUES(?,?,?,?,?,?,1,?,?,?,?,?)')
        .run(restaurant.id,name,description,price,image,category,stockEnabled?1:0,stockQuantity,lowStockThreshold,JSON.stringify(variants),JSON.stringify(addons));
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});

app.get('/api/restaurant/menu-drafts',auth,restaurantAccess('can_manage_products'),(req,res)=>res.json(db.prepare(`SELECT d.*,COUNT(i.id) item_count,SUM(i.validation_error IS NOT NULL) error_count FROM menu_drafts d LEFT JOIN menu_draft_items i ON i.draft_id=d.id WHERE d.restaurant_id=? GROUP BY d.id ORDER BY d.id DESC LIMIT 30`).all(req.restaurant.id)));
app.get('/api/restaurant/menu-drafts/:id',auth,restaurantAccess('can_manage_products'),(req,res)=>{const draft=db.prepare('SELECT * FROM menu_drafts WHERE id=? AND restaurant_id=?').get(+req.params.id,req.restaurant.id);if(!draft)return res.status(404).json({error:'Borrador no encontrado'});res.json({...draft,items:db.prepare('SELECT * FROM menu_draft_items WHERE draft_id=? ORDER BY sort_order,id').all(draft.id)});});
app.post('/api/restaurant/menu-drafts',auth,restaurantAccess('can_manage_products'),rateLimit('menu-draft-import',10,3600000),(req,res)=>{const type=String(req.body.sourceType||'text'),content=String(req.body.content||'');if(!['text','csv','tsv'].includes(type)||!content.trim()||Buffer.byteLength(content)>102400)return res.status(400).json({error:'Contenido inválido, tipo no compatible o mayor de 100 KB'});const result=createMenuDraft(req.restaurant.id,req.user.id,type,req.body.sourceName,content);audit(req,'menu_draft_created','menu_draft',result.id);res.status(201).json(result);});
app.post('/api/restaurant/menu-drafts/pdf',auth,restaurantAccess('can_manage_products'),rateLimit('menu-draft-pdf',5,3600000),async(req,res)=>{const match=String(req.body.dataUrl||'').match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/),sourceName=String(req.body.sourceName||'menu.pdf');if(!match)return res.status(400).json({error:'Selecciona un archivo PDF válido'});const buffer=Buffer.from(match[1],'base64');if(!buffer.length||buffer.length>4*1024*1024||buffer.subarray(0,5).toString()!=='%PDF-')return res.status(400).json({error:'El PDF no es válido o supera 4 MB'});let parser;try{parser=new PDFParse({data:buffer});const info=await parser.getInfo();if(!info.total||info.total>20)return res.status(400).json({error:'El PDF debe tener entre 1 y 20 páginas'});const extracted=String((await parser.getText({first:info.total,pageJoiner:'\n'})).text||'').replace(/\0/g,'').trim();if(extracted.length<3)return res.status(422).json({error:'Este PDF no contiene texto seleccionable. Las fotos y documentos escaneados requerirán OCR.'});if(Buffer.byteLength(extracted)>102400)return res.status(400).json({error:'El texto extraído supera 100 KB'});const result=createMenuDraft(req.restaurant.id,req.user.id,'text',sourceName,extracted);audit(req,'menu_draft_pdf_created','menu_draft',result.id);res.status(201).json({...result,pageCount:info.total});}catch(error){if(!res.headersSent)res.status(400).json({error:'No fue posible leer el PDF. Verifica que no esté protegido o dañado.'});}finally{if(parser)await parser.destroy().catch(()=>{});}});
app.post('/api/restaurant/menu-drafts/ocr',auth,restaurantAccess('can_manage_products'),rateLimit('menu-draft-ocr',3,3600000),async(req,res)=>{const match=String(req.body.dataUrl||'').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/),sourceName=String(req.body.sourceName||'foto-menu').slice(0,120);if(!match)return res.status(400).json({error:'Selecciona una imagen JPG, PNG o WEBP'});const buffer=Buffer.from(match[2],'base64');if(!buffer.length||buffer.length>4*1024*1024)return res.status(400).json({error:'La imagen no es válida o supera 4 MB'});const valid=(match[1]==='jpeg'&&buffer[0]===0xff&&buffer[1]===0xd8)||(match[1]==='png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(match[1]==='webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP');if(!valid)return res.status(400).json({error:'El archivo no contiene una imagen válida'});if(menuOcrBusy)return res.status(429).json({error:'El lector está procesando otra imagen. Intenta nuevamente en un momento.'});let worker,timer;menuOcrBusy=true;try{const image=await require('sharp')(buffer,{limitInputPixels:30000000,failOn:'error'}).rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).grayscale().normalize().sharpen().png().toBuffer();worker=await createWorker(spanishOcrData.code,OEM.LSTM_ONLY,{langPath:spanishOcrData.langPath,gzip:spanishOcrData.gzip,cacheMethod:'none'});await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,preserve_interword_spaces:'1'});const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OCR_TIMEOUT')),45000)}),recognition=await Promise.race([worker.recognize(image),timeout]),text=String(recognition.data?.text||'').replace(/\0/g,'').trim();if(text.length<3)return res.status(422).json({error:'No pudimos reconocer texto. Prueba con una foto más recta, iluminada y cercana.'});if(Buffer.byteLength(text)>102400)return res.status(400).json({error:'El texto reconocido supera 100 KB'});const result=createMenuDraft(req.restaurant.id,req.user.id,'text',sourceName,text);audit(req,'menu_draft_ocr_created','menu_draft',result.id);res.status(201).json({...result,confidence:Math.round(Number(recognition.data?.confidence)||0)});}catch(error){if(!res.headersSent)res.status(error.message==='OCR_TIMEOUT'?504:400).json({error:error.message==='OCR_TIMEOUT'?'La lectura tardó demasiado. Prueba con una imagen más pequeña.':'No fue posible procesar la fotografía.'});}finally{clearTimeout(timer);if(worker)await worker.terminate().catch(()=>{});menuOcrBusy=false;}});
app.patch('/api/restaurant/menu-drafts/:draftId/items/:itemId',auth,restaurantAccess('can_manage_products'),(req,res)=>{const draft=db.prepare("SELECT id FROM menu_drafts WHERE id=? AND restaurant_id=? AND status='draft'").get(+req.params.draftId,req.restaurant.id);if(!draft)return res.status(404).json({error:'Borrador editable no encontrado'});const name=String(req.body.name||'').trim(),price=Number(req.body.price),category=String(req.body.category||'Comida'),error=menuDraftError(name,price,category),result=db.prepare('UPDATE menu_draft_items SET name=?,description=?,price=?,category=?,selected=?,validation_error=? WHERE id=? AND draft_id=?').run(name.slice(0,100),String(req.body.description||'').trim().slice(0,500),Number.isFinite(price)?price:null,category,req.body.selected===false?0:1,error,+req.params.itemId,draft.id);if(!result.changes)return res.status(404).json({error:'Producto no encontrado'});res.json(db.prepare('SELECT * FROM menu_draft_items WHERE id=?').get(+req.params.itemId));});
app.post('/api/restaurant/menu-drafts/:id/publish',auth,restaurantAccess('can_manage_products'),rateLimit('menu-draft-publish',10,3600000),(req,res)=>{const id=+req.params.id;try{const count=db.transaction(()=>{const draft=db.prepare("SELECT id FROM menu_drafts WHERE id=? AND restaurant_id=? AND status='draft'").get(id,req.restaurant.id);if(!draft)throw new Error('El borrador no existe o ya fue publicado');const items=db.prepare('SELECT * FROM menu_draft_items WHERE draft_id=? AND selected=1').all(id);if(!items.length||items.some(i=>i.validation_error))throw new Error('Corrige y selecciona los productos antes de publicar');const insert=db.prepare("INSERT INTO products(restaurant_id,name,description,price,image,category,available,stock_enabled,stock_quantity,low_stock_threshold,variants_json,addons_json) VALUES(?,?,?,?, '',?,1,0,0,5,'[]','[]')");items.forEach(i=>insert.run(req.restaurant.id,i.name,i.description,i.price,i.category));db.prepare("UPDATE menu_drafts SET status='published',published_at=CURRENT_TIMESTAMP WHERE id=?").run(id);return items.length;})();audit(req,'menu_draft_published','menu_draft',id);res.json({ok:true,publishedCount:count});}catch(e){res.status(409).json({error:e.message});}});

app.put('/api/restaurant/products/:id',auth,restaurantAccess('can_manage_products'),(req,res)=>{
    const restaurant=req.restaurant;
    const name=String(req.body.name||'').trim();
    const description=String(req.body.description||'').trim();
    const image=String(req.body.image||'').trim();
    const price=Number(req.body.price);
    const category=String(req.body.category||'Comida');
    const stockEnabled=req.body.stockEnabled===true,stockQuantity=Math.max(0,Math.floor(Number(req.body.stockQuantity)||0)),lowStockThreshold=Math.max(0,Math.floor(Number(req.body.lowStockThreshold)||5));
    const variants=normalizeChoices(req.body.variants),addons=normalizeChoices(req.body.addons);
    const allowedCategories=['Comida','Bebidas','Bebidas alcohólicas','Postres','Extras'];
    if(!name||name.length>100||!Number.isFinite(price)||price<=0){
        return res.status(400).json({error:'Datos del producto inválidos'});
    }
    if(!allowedCategories.includes(category))return res.status(400).json({error:'Categoría inválida'});
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    const previous=db.prepare('SELECT image FROM products WHERE id=? AND restaurant_id=?').get(req.params.id,restaurant.id)?.image;
    const result=db.prepare('UPDATE products SET name=?,description=?,price=?,image=?,category=?,stock_enabled=?,stock_quantity=?,low_stock_threshold=?,variants_json=?,addons_json=?,available=CASE WHEN ?=1 AND ?<=0 THEN 0 ELSE available END WHERE id=? AND restaurant_id=?')
        .run(name,description,price,image,category,stockEnabled?1:0,stockQuantity,lowStockThreshold,JSON.stringify(variants),JSON.stringify(addons),stockEnabled?1:0,stockQuantity,req.params.id,restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Producto no encontrado'});
    if(previous&&previous!==image)deleteLocalImage(previous);
    res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

app.patch('/api/restaurant/products/:id',auth,restaurantAccess('can_manage_products'),(req,res)=>{
    const restaurant=req.restaurant;
    const status=String(req.body.status||'');let availableUntil=null,availabilityStatus='available',available=1;
    if(status==='temporary'){const duration=String(req.body.duration||'');if(!['30','60','120','day'].includes(duration))return res.status(400).json({error:'Selecciona una duración válida'});if(duration==='day')availableUntil=new Date(sayulaDateKey(new Date())+'T23:59:59-06:00').toISOString();else availableUntil=new Date(Date.now()+Number(duration)*60*1000).toISOString();availabilityStatus='temporary';available=0;}
    else if(status==='manual'||req.body.available===false){availabilityStatus='manual';available=0;}
    else if(status==='available'||req.body.available===true){availabilityStatus='available';available=1;}
    else return res.status(400).json({error:'Estado de disponibilidad inválido'});
    const result=db.prepare('UPDATE products SET available=?,availability_status=?,unavailable_until=? WHERE id=? AND restaurant_id=?')
        .run(available,availabilityStatus,availableUntil,req.params.id,restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Producto no encontrado'});
    audit(req,'product_availability_updated','product',Number(req.params.id));res.json({ok:true,available:Boolean(available),availabilityStatus,unavailableUntil:availableUntil});
});
const cashSessionSummary=(restaurantId,sessionId)=>{const session=db.prepare(`SELECT s.*,ou.name opened_by,cu.name closed_by FROM cash_sessions s LEFT JOIN users ou ON ou.id=s.opened_by_user_id LEFT JOIN users cu ON cu.id=s.closed_by_user_id WHERE s.id=? AND s.restaurant_id=?`).get(sessionId,restaurantId);if(!session)return null;const sales=db.prepare(`SELECT COUNT(*) sales_count,ROUND(COALESCE(SUM(total),0),2) cash_sales FROM pos_sales WHERE restaurant_id=? AND created_at>=? AND created_at<=COALESCE(?,CURRENT_TIMESTAMP) AND payment_method='Efectivo' AND status='completed'`).get(restaurantId,session.opened_at,session.closed_at),movements=db.prepare(`SELECT m.*,u.name user_name FROM cash_movements m LEFT JOIN users u ON u.id=m.user_id WHERE m.cash_session_id=? ORDER BY m.id DESC`).all(sessionId),income=movements.filter(m=>m.movement_type==='income').reduce((s,m)=>s+Number(m.amount),0),withdrawals=movements.filter(m=>m.movement_type==='withdrawal').reduce((s,m)=>s+Number(m.amount),0),expected=Math.round((Number(session.opening_amount)+Number(sales.cash_sales)+income-withdrawals)*100)/100;return {...session,...sales,income:Math.round(income*100)/100,withdrawals:Math.round(withdrawals*100)/100,currentExpected:session.status==='closed'?session.expected_amount:expected,movements}};
app.get('/api/restaurant/cash',auth,restaurantAccess('can_use_pos'),(req,res)=>{const open=db.prepare("SELECT id FROM cash_sessions WHERE restaurant_id=? AND status='open'").get(req.restaurant.id),recent=db.prepare("SELECT id FROM cash_sessions WHERE restaurant_id=? ORDER BY id DESC LIMIT 10").all(req.restaurant.id).map(row=>cashSessionSummary(req.restaurant.id,row.id));res.json({open:open?cashSessionSummary(req.restaurant.id,open.id):null,recent});});
app.post('/api/restaurant/cash/open',auth,restaurantAccess('can_use_pos'),(req,res)=>{const amount=Math.round(Number(req.body.openingAmount)*100)/100,note=String(req.body.note||'').trim().slice(0,300);if(!Number.isFinite(amount)||amount<0||amount>100000)return res.status(400).json({error:'Fondo inicial inválido'});if(db.prepare("SELECT id FROM cash_sessions WHERE restaurant_id=? AND status='open'").get(req.restaurant.id))return res.status(409).json({error:'Ya existe una caja abierta'});const result=db.prepare('INSERT INTO cash_sessions(restaurant_id,opened_by_user_id,opening_amount,opening_note) VALUES(?,?,?,?)').run(req.restaurant.id,req.user.id,amount,note);audit(req,'cash_session_opened','cash_session',result.lastInsertRowid);res.status(201).json(cashSessionSummary(req.restaurant.id,result.lastInsertRowid));});
app.post('/api/restaurant/cash/movements',auth,restaurantAccess('can_use_pos'),(req,res)=>{const session=db.prepare("SELECT id FROM cash_sessions WHERE restaurant_id=? AND status='open'").get(req.restaurant.id),type=String(req.body.type||''),amount=Math.round(Number(req.body.amount)*100)/100,reason=String(req.body.reason||'').trim().slice(0,200);if(!session)return res.status(409).json({error:'Primero abre la caja'});if(!['income','withdrawal'].includes(type)||!Number.isFinite(amount)||amount<=0||amount>100000||reason.length<3)return res.status(400).json({error:'Movimiento inválido'});const result=db.prepare('INSERT INTO cash_movements(cash_session_id,user_id,movement_type,amount,reason) VALUES(?,?,?,?,?)').run(session.id,req.user.id,type,amount,reason);audit(req,'cash_movement_created','cash_movement',result.lastInsertRowid);res.status(201).json(cashSessionSummary(req.restaurant.id,session.id));});
app.post('/api/restaurant/cash/close',auth,restaurantAccess('can_use_pos'),(req,res)=>{const session=db.prepare("SELECT id FROM cash_sessions WHERE restaurant_id=? AND status='open'").get(req.restaurant.id),counted=Math.round(Number(req.body.countedAmount)*100)/100,note=String(req.body.note||'').trim().slice(0,300);if(!session)return res.status(409).json({error:'No hay una caja abierta'});if(!Number.isFinite(counted)||counted<0||counted>200000)return res.status(400).json({error:'Efectivo contado inválido'});const summary=cashSessionSummary(req.restaurant.id,session.id),difference=Math.round((counted-summary.currentExpected)*100)/100;db.prepare("UPDATE cash_sessions SET status='closed',closed_by_user_id=?,counted_amount=?,expected_amount=?,difference_amount=?,closing_note=?,closed_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(req.user.id,counted,summary.currentExpected,difference,note,session.id);audit(req,'cash_session_closed','cash_session',session.id);res.json(cashSessionSummary(req.restaurant.id,session.id));});
app.get('/api/restaurant/pos',auth,restaurantAccess('can_use_pos'),(req,res)=>{const sales=db.prepare(`SELECT s.id,s.receipt_number,s.total,s.payment_method,s.status,s.note,s.void_reason,s.created_at,u.name sold_by FROM pos_sales s LEFT JOIN users u ON u.id=s.sold_by_user_id WHERE s.restaurant_id=? ORDER BY s.id DESC LIMIT 50`).all(req.restaurant.id),items=db.prepare('SELECT product_name,category,unit_price,quantity FROM pos_sale_items WHERE sale_id=?'),today=db.prepare(`SELECT COUNT(CASE WHEN status='completed' THEN 1 END) sales_count,ROUND(COALESCE(SUM(CASE WHEN status='completed' THEN total ELSE 0 END),0),2) total,ROUND(COALESCE(SUM(CASE WHEN status='completed' AND payment_method='Efectivo' THEN total ELSE 0 END),0),2) cash,ROUND(COALESCE(SUM(CASE WHEN status='completed' AND payment_method!='Efectivo' THEN total ELSE 0 END),0),2) other,COUNT(CASE WHEN status='voided' THEN 1 END) voided FROM pos_sales WHERE restaurant_id=? AND date(created_at,'localtime')=date('now','localtime')`).get(req.restaurant.id);res.json({today,sales:sales.map(s=>({...s,items:items.all(s.id)}))});});
app.post('/api/restaurant/pos/sales',auth,restaurantAccess('can_use_pos'),rateLimit('pos-sales',120,60*60*1000),(req,res)=>{if(hasSensitiveCardData(req.body))return res.status(400).json({error:'COME SAYULA no recibe ni almacena números de tarjeta o códigos de seguridad'});const items=Array.isArray(req.body.items)?req.body.items:[],paymentMethod=String(req.body.paymentMethod||''),requestId=String(req.body.clientRequestId||''),note=String(req.body.note||'').trim().slice(0,300);if(!items.length||items.length>50||!['Efectivo','Tarjeta','Transferencia'].includes(paymentMethod)||!/^[a-zA-Z0-9-]{16,80}$/.test(requestId))return res.status(400).json({error:'Venta de mostrador inválida'});const existing=db.prepare('SELECT id,receipt_number,total FROM pos_sales WHERE client_request_id=? AND restaurant_id=?').get(requestId,req.restaurant.id);if(existing)return res.json({...existing,repeated:true});const getProduct=db.prepare('SELECT id,name,category,price,available,stock_enabled,stock_quantity,variants_json,addons_json FROM products WHERE id=? AND restaurant_id=?'),normalized=[];let total=0;for(const item of items){const product=getProduct.get(Number(item.productId),req.restaurant.id),quantity=Number(item.quantity);if(!product||!product.available||!Number.isInteger(quantity)||quantity<1||quantity>99)return res.status(400).json({error:'Producto o cantidad inválida'});if(product.stock_enabled&&product.stock_quantity<quantity)return res.status(409).json({error:`Sólo quedan ${product.stock_quantity} unidades de ${product.name}`});let choice;try{choice=productSelection(product,item)}catch(error){return res.status(400).json({error:error.message})}normalized.push({...product,...choice,quantity});total+=choice.unitPrice*quantity;}if(normalized.some(p=>p.category==='Bebidas alcohólicas')&&req.body.ageConfirmed!==true)return res.status(403).json({error:'Confirma que verificaste que el comprador es mayor de 18 años'});total=Math.round(total*100)/100;const sale=db.transaction(()=>{const created=db.prepare("INSERT INTO pos_sales(restaurant_id,sold_by_user_id,subtotal,total,payment_method,note,age_confirmed,client_request_id) VALUES(?,?,?,?,?,?,?,?)").run(req.restaurant.id,req.user.id,total,total,paymentMethod,note,req.body.ageConfirmed?1:0,requestId),id=Number(created.lastInsertRowid),receipt='POS-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+String(id).padStart(6,'0'),insert=db.prepare('INSERT INTO pos_sale_items(sale_id,product_id,product_name,category,unit_price,quantity,options_description) VALUES(?,?,?,?,?,?,?)');for(const item of normalized){insert.run(id,item.id,item.name,item.category,item.unitPrice,item.quantity,item.optionsDescription);if(item.stock_enabled)db.prepare('UPDATE products SET stock_quantity=stock_quantity-?,available=CASE WHEN stock_quantity-?<=0 THEN 0 ELSE available END WHERE id=?').run(item.quantity,item.quantity,item.id);}db.prepare('UPDATE pos_sales SET receipt_number=? WHERE id=?').run(receipt,id);return {id,receiptNumber:receipt,total};})();audit(req,'pos_sale_created','pos_sale',sale.id);res.status(201).json(sale);});
app.post('/api/restaurant/pos/sales/:id/void',auth,restaurantAccess('can_use_pos'),(req,res)=>{const id=Number(req.params.id),reason=String(req.body.reason||'').trim().slice(0,300);if(reason.length<3)return res.status(400).json({error:'Escribe el motivo de cancelación'});const result=db.prepare("UPDATE pos_sales SET status='voided',void_reason=?,voided_at=CURRENT_TIMESTAMP,voided_by_user_id=? WHERE id=? AND restaurant_id=? AND status='completed'").run(reason,req.user.id,id,req.restaurant.id);if(result.changes!==1)return res.status(409).json({error:'La venta no existe o ya fue cancelada'});audit(req,'pos_sale_voided','pos_sale',id);res.json({ok:true,status:'voided'});});
app.post('/api/restaurant/orders/:id/substitutions',auth,restaurantAccess('can_manage_orders'),(req,res)=>{refreshTemporaryAvailability();const orderId=Number(req.params.id),originalItemId=Number(req.body.originalItemId),replacementProductId=Number(req.body.replacementProductId),description=String(req.body.description||'').trim().slice(0,300),order=db.prepare("SELECT id,customer_id,status FROM orders WHERE id=? AND restaurant_id=?").get(orderId,req.restaurant.id);if(!order)return res.status(404).json({error:'Pedido no encontrado'});if(!['received','accepted','preparing'].includes(order.status))return res.status(409).json({error:'Ya no se pueden proponer sustituciones para este pedido'});const original=db.prepare('SELECT id,product_id,product_name,unit_price,quantity FROM order_items WHERE id=? AND order_id=?').get(originalItemId,orderId),replacement=db.prepare('SELECT id,name,price,available,stock_enabled,stock_quantity FROM products WHERE id=? AND restaurant_id=?').get(replacementProductId,req.restaurant.id);if(!original||!replacement||replacement.id===original.product_id)return res.status(400).json({error:'Selecciona el producto original y un sustituto diferente'});if(!replacement.available||(replacement.stock_enabled&&replacement.stock_quantity<original.quantity))return res.status(409).json({error:'El producto sustituto no está disponible en cantidad suficiente'});const difference=Math.round((Number(replacement.price)-Number(original.unit_price))*100)/100;try{const created=db.prepare('INSERT INTO order_substitutions(order_id,original_order_item_id,replacement_product_id,proposed_by_user_id,original_name,replacement_name,original_unit_price,replacement_unit_price,price_difference,description) VALUES(?,?,?,?,?,?,?,?,?,?)').run(orderId,original.id,replacement.id,req.user.id,original.product_name,replacement.name,original.unit_price,replacement.price,difference,description);addNotification(order.customer_id,orderId,'substitution_proposed','Sustitución propuesta',original.product_name+' → '+replacement.name+(difference===0?' sin diferencia':difference>0?' +$'+difference.toFixed(2):' -$'+Math.abs(difference).toFixed(2)),'/tracking.html?order='+orderId);audit(req,'order_substitution_proposed','order_substitution',Number(created.lastInsertRowid));res.status(201).json({id:Number(created.lastInsertRowid),difference});}catch(error){res.status(409).json({error:'Ya existe una sustitución pendiente para ese producto'})}});
app.post('/api/orders/:id/substitutions/:substitutionId/respond',auth,role(['customer']),(req,res)=>{const orderId=Number(req.params.id),substitutionId=Number(req.params.substitutionId),accept=req.body.accept===true,substitution=db.prepare(`SELECT s.*,o.customer_id,o.restaurant_id,o.status order_status,o.payment_status,i.quantity,i.product_id original_product_id,p.available replacement_available,p.stock_enabled replacement_stock_enabled,p.stock_quantity replacement_stock_quantity,r.owner_id FROM order_substitutions s JOIN orders o ON o.id=s.order_id JOIN order_items i ON i.id=s.original_order_item_id JOIN products p ON p.id=s.replacement_product_id JOIN restaurants r ON r.id=o.restaurant_id WHERE s.id=? AND s.order_id=? AND o.customer_id=? AND s.status='pending'`).get(substitutionId,orderId,req.user.id);if(!substitution)return res.status(404).json({error:'La propuesta no existe o ya fue respondida'});if(!['received','accepted','preparing'].includes(substitution.order_status))return res.status(409).json({error:'El pedido ya no admite cambios'});if(accept&&substitution.payment_status==='paid'&&Number(substitution.price_difference)!==0)return res.status(409).json({error:'Un pedido ya pagado sólo puede aceptar sustituciones sin diferencia de precio'});try{db.transaction(()=>{if(accept){if(!substitution.replacement_available||(substitution.replacement_stock_enabled&&substitution.replacement_stock_quantity<substitution.quantity))throw new Error('El sustituto dejó de estar disponible');if(substitution.replacement_stock_enabled){const changed=db.prepare('UPDATE products SET stock_quantity=stock_quantity-?,available=CASE WHEN stock_quantity-?<=0 THEN 0 ELSE available END WHERE id=? AND available=1 AND stock_quantity>=?').run(substitution.quantity,substitution.quantity,substitution.replacement_product_id,substitution.quantity);if(changed.changes!==1)throw new Error('El sustituto dejó de estar disponible')}db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,available=1 WHERE id=? AND stock_enabled=1').run(substitution.quantity,substitution.original_product_id);db.prepare('UPDATE order_items SET product_id=?,product_name=?,unit_price=?,options_description=NULL WHERE id=? AND order_id=?').run(substitution.replacement_product_id,substitution.replacement_name,substitution.replacement_unit_price,substitution.original_order_item_id,orderId);const delta=Math.round(Number(substitution.price_difference)*Number(substitution.quantity)*100)/100;db.prepare('UPDATE orders SET subtotal=ROUND(subtotal+?,2),total=ROUND(total+?,2) WHERE id=?').run(delta,delta,orderId);db.prepare('UPDATE order_financials SET subtotal=ROUND(subtotal+?,2),total_charged=ROUND(total_charged+?,2),restaurant_due=ROUND(restaurant_due+?,2),updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(delta,delta,delta,orderId)}db.prepare("UPDATE order_substitutions SET status=?,responded_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(accept?'accepted':'rejected',substitutionId);})();const message=accept?'El cliente aceptó la sustitución.':'El cliente rechazó la sustitución; comunícate antes de continuar.';addNotification(substitution.owner_id,orderId,'substitution_'+(accept?'accepted':'rejected'),'Respuesta de sustitución',message,'/restaurant.html');for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(substitution.restaurant_id))addNotification(member.user_id,orderId,'substitution_'+(accept?'accepted':'rejected'),'Respuesta de sustitución',message,'/restaurant.html');audit(req,'order_substitution_'+(accept?'accepted':'rejected'),'order_substitution',substitutionId);res.json({ok:true,status:accept?'accepted':'rejected'});}catch(error){res.status(409).json({error:error.message})}});
app.patch('/api/restaurant/orders/:id',auth,restaurantAccess('can_manage_orders'),(req,res)=>{
    const restaurant=req.restaurant;
    const order=db.prepare('SELECT id,status,scheduled_for,estimated_prep_minutes,accepted_prep_minutes,payment_status FROM orders WHERE id=? AND restaurant_id=?')
        .get(req.params.id,restaurant.id);
    if(!order) return res.status(404).json({error:'Pedido no encontrado'});
    if(order.payment_status==='awaiting_online_payment')return res.status(409).json({error:'El pago en línea todavía no ha sido confirmado'});

    if(['delivering','delivered'].includes(order.status)){
        return res.status(409).json({
            error:'El pedido ya fue entregado al repartidor y está bloqueado'
        });
    }

    const transitions={
        received:['accepted','cancelled'],
        accepted:['preparing','cancelled'],
        preparing:['ready','cancelled'],
        ready:[],
        cancelled:[]
    };
    if(!(transitions[order.status]||[]).includes(req.body.status)){
        return res.status(400).json({error:'Ese cambio de estado no está permitido'});
    }
    const prepMinutes=req.body.status==='accepted'&&req.body.prepMinutes==null?Math.max(5,Number(order.estimated_prep_minutes)||30):Number(req.body.prepMinutes);
    if(req.body.status==='accepted'&&(!Number.isInteger(prepMinutes)||prepMinutes<5||prepMinutes>180))return res.status(400).json({error:'Confirma un tiempo de preparación entre 5 y 180 minutos'});
    const prepStart=scheduledPrepStart(order);
    if(req.body.status==='preparing'&&prepStart&&Date.now()<prepStart.getTime())return res.status(409).json({error:'Este pedido es programado. La preparación inicia a la hora indicada en el panel'});
    if(req.body.status==='ready'&&!canOfferScheduledOrder(order))return res.status(409).json({error:'El pedido programado todavía no puede marcarse listo'});

    const acceptedEta=req.body.status==='accepted'?(order.scheduled_for||new Date(Date.now()+prepMinutes*60*1000).toISOString()):null;
    const result=db.transaction(()=>{const changed=db.prepare("UPDATE orders SET status=?,payment_status=CASE WHEN ?='cancelled' THEN 'cancelled' ELSE payment_status END,accepted_prep_minutes=CASE WHEN ?='accepted' THEN ? ELSE accepted_prep_minutes END,accepted_eta_at=CASE WHEN ?='accepted' THEN ? ELSE accepted_eta_at END WHERE id=? AND restaurant_id=? AND status=?").run(req.body.status,req.body.status,req.body.status,prepMinutes,req.body.status,acceptedEta,order.id,restaurant.id,order.status);if(changed.changes===1){if(req.body.status==='cancelled')reverseOrderFinancials(order.id,'Cancelación realizada por el restaurante');recordOrderStatus(order.id,order.status,req.body.status,req.user,req.body.status==='accepted'?'Tiempo confirmado: '+prepMinutes+' minutos':'');}return changed;})();
    if(result.changes!==1) return res.status(409).json({error:'El pedido cambió; actualiza el panel'});
    audit(req,'restaurant_order_'+req.body.status,'order',order.id);
    res.json({ok:true,status:req.body.status,acceptedPrepMinutes:req.body.status==='accepted'?prepMinutes:order.accepted_prep_minutes,acceptedEtaAt:acceptedEta});
});
app.patch('/api/restaurant/orders/:id/payment',auth,restaurantAccess('can_manage_orders'),(req,res)=>{
    const restaurant=req.restaurant;
    const order=db.prepare("SELECT id,payment_method,payment_status,status FROM orders WHERE id=? AND restaurant_id=?").get(req.params.id,restaurant.id);
    if(!order)return res.status(404).json({error:'Pedido no encontrado'});
    if(order.payment_method!=='Transferencia'||order.payment_status!=='awaiting_confirmation')return res.status(409).json({error:'Este pedido no tiene una transferencia pendiente'});
    if(['cancelled','delivered'].includes(order.status))return res.status(409).json({error:'El pedido ya está cerrado'});
    const result=db.prepare("UPDATE orders SET payment_status='confirmed' WHERE id=? AND payment_status='awaiting_confirmation'").run(order.id);
    if(result.changes!==1)return res.status(409).json({error:'El pago ya cambió; actualiza el panel'});
    db.prepare("UPDATE order_financials SET payment_status='confirmed',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(order.id);audit(req,'transfer_confirmed','order',order.id);res.json({ok:true,paymentStatus:'confirmed'});
});
app.put('/api/delivery/location',auth,role(['delivery']),rateLimit('delivery-location',120,60*1000),(req,res)=>{
    const latitude=Number(req.body.latitude),longitude=Number(req.body.longitude),accuracy=Number(req.body.accuracy||0);
    if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180||!Number.isFinite(accuracy)||accuracy<0||accuracy>10000)return res.status(400).json({error:'Ubicación inválida'});
    db.prepare(`INSERT INTO delivery_locations(delivery_user_id,latitude,longitude,accuracy,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(delivery_user_id) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,accuracy=excluded.accuracy,updated_at=CURRENT_TIMESTAMP`)
        .run(req.user.id,latitude,longitude,accuracy);
    db.prepare("INSERT INTO delivery_profiles(delivery_user_id,status,updated_at) VALUES(?,'available',CURRENT_TIMESTAMP) ON CONFLICT(delivery_user_id) DO UPDATE SET status=CASE WHEN delivery_profiles.verification_status='verified' THEN 'available' ELSE delivery_profiles.status END,updated_at=CURRENT_TIMESTAMP").run(req.user.id);
    res.json({ok:true});
});
app.put('/api/delivery/availability',auth,role(['delivery']),(req,res)=>{const status=String(req.body.status||'');if(!['available','offline'].includes(status))return res.status(400).json({error:'Estado inválido'});const active=db.prepare("SELECT da.order_id FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering')").get(req.user.id);if(active&&status==='offline')return res.status(409).json({error:'Termina tu entrega activa antes de desconectarte'});db.prepare('INSERT INTO delivery_profiles(delivery_user_id,status,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(delivery_user_id) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP').run(req.user.id,status);res.json({ok:true,status});});
app.get('/api/delivery/availability',auth,role(['delivery']),(req,res)=>res.json(db.prepare("SELECT COALESCE((SELECT status FROM delivery_profiles WHERE delivery_user_id=?),'offline') status").get(req.user.id)));
app.get('/api/delivery/profile',auth,role(['delivery']),(req,res)=>res.json(db.prepare("SELECT u.name,u.phone,dp.internal_number,dp.vehicle_type,dp.vehicle_description,dp.verification_status,dp.max_active_orders FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.id=?").get(req.user.id)));
app.get('/api/delivery/incentives',auth,role(['delivery']),(req,res)=>{const level=courierLevel(req.user.id),streak=db.prepare('SELECT current_days,best_days,last_delivery_date FROM driver_streaks WHERE delivery_user_id=?').get(req.user.id)||{current_days:0,best_days:0,last_delivery_date:null},today=sayulaDateKey(new Date()),week=weekKey(new Date()),goals=db.prepare("SELECT g.*,COALESCE(p.deliveries,0) progress,p.completed_at FROM driver_goals g LEFT JOIN driver_goal_progress p ON p.goal_id=g.id AND p.delivery_user_id=? AND p.period_key=CASE WHEN g.period_type='daily' THEN ? ELSE ? END WHERE g.active=1 AND datetime(g.starts_at)<=CURRENT_TIMESTAMP AND datetime(g.ends_at)>=CURRENT_TIMESTAMP ORDER BY g.period_type,g.target_deliveries").all(req.user.id,today,week),rewards=db.prepare('SELECT id,amount,reward_type,reason,status,earned_at,paid_at,reference FROM driver_rewards WHERE delivery_user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id),summary=db.prepare("SELECT ROUND(COALESCE(SUM(CASE WHEN status='earned' THEN amount ELSE 0 END),0),2) pending,ROUND(COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0),2) paid FROM driver_rewards WHERE delivery_user_id=?").get(req.user.id),ratings=db.prepare(`SELECT COUNT(rv.delivery_rating) sample_count,ROUND(AVG(rv.delivery_rating),1) overall,ROUND(AVG(rv.punctuality_rating),1) punctuality,ROUND(AVG(rv.courtesy_rating),1) courtesy,ROUND(AVG(rv.delivery_quality_rating),1) delivery_quality FROM order_reviews rv JOIN orders o ON o.id=rv.order_id WHERE rv.delivery_user_id=? AND o.status='delivered' AND o.is_demo=0`).get(req.user.id);res.json({level,streak,goals,rewards,summary,ratings})});
app.put('/api/delivery/profile',auth,role(['delivery']),(req,res)=>{const vehicleType=String(req.body.vehicleType||''),description=String(req.body.vehicleDescription||'').trim().slice(0,120);if(!['bicycle','motorcycle','car','walking'].includes(vehicleType)||description.length<2)return res.status(400).json({error:'Selecciona el vehículo y escribe una descripción breve'});db.prepare("INSERT INTO delivery_profiles(delivery_user_id,status,internal_number,vehicle_type,vehicle_description) VALUES(?,'offline','CS-'||printf('%04d',?),?,?) ON CONFLICT(delivery_user_id) DO UPDATE SET vehicle_type=excluded.vehicle_type,vehicle_description=excluded.vehicle_description,updated_at=CURRENT_TIMESTAMP").run(req.user.id,req.user.id,vehicleType,description);audit(req,'delivery_profile_updated','delivery_profile',req.user.id);res.json({ok:true})});
app.get('/api/delivery/cash-account',auth,role(['delivery']),(req,res)=>{const pending=db.prepare('SELECT COUNT(*) orders_count,ROUND(COALESCE(SUM(cash_collected),0),2) cash_collected,ROUND(COALESCE(SUM(courier_earnings),0),2) courier_earnings,ROUND(COALESCE(SUM(amount_to_remit),0),2) amount_to_remit FROM courier_cash_records c JOIN orders o ON o.id=c.order_id WHERE c.delivery_user_id=? AND c.settlement_id IS NULL AND c.cash_collected>0 AND o.is_demo=0').get(req.user.id),records=db.prepare('SELECT c.order_id,c.cash_collected,c.courier_earnings,c.amount_to_remit,c.created_at,o.payment_method,r.name restaurant_name FROM courier_cash_records c JOIN orders o ON o.id=c.order_id JOIN restaurants r ON r.id=o.restaurant_id WHERE c.delivery_user_id=? AND o.is_demo=0 ORDER BY c.created_at DESC LIMIT 50').all(req.user.id),settlements=db.prepare('SELECT id,expected_amount,reported_amount,difference_amount,status,courier_note,admin_note,reference,reported_at,settled_at FROM courier_cash_settlements WHERE delivery_user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id),tips=db.prepare('SELECT ROUND(COALESCE(SUM(rv.tip_amount),0),2) total FROM order_reviews rv JOIN orders o ON o.id=rv.order_id WHERE rv.delivery_user_id=? AND o.is_demo=0').get(req.user.id);res.json({pending,records,settlements,tips:Number(tips.total)||0})});
app.post('/api/delivery/cash-settlements',auth,role(['delivery']),rateLimit('courier-cash-report',6,60*60*1000),(req,res)=>{const reportedAmount=Math.round(Number(req.body.reportedAmount)*100)/100,note=String(req.body.note||'').trim().slice(0,500);if(!Number.isFinite(reportedAmount)||reportedAmount<0||reportedAmount>100000)return res.status(400).json({error:'Escribe una cantidad de efectivo válida'});if(db.prepare("SELECT id FROM courier_cash_settlements WHERE delivery_user_id=? AND status='review'").get(req.user.id))return res.status(409).json({error:'Ya tienes una conciliación pendiente de revisión'});try{const result=db.transaction(()=>{const rows=db.prepare('SELECT c.order_id,c.amount_to_remit FROM courier_cash_records c JOIN orders o ON o.id=c.order_id WHERE c.delivery_user_id=? AND c.settlement_id IS NULL AND c.cash_collected>0 AND o.is_demo=0 ORDER BY c.order_id').all(req.user.id);if(!rows.length)throw new Error('No tienes efectivo pendiente por reportar');const expected=Math.round(rows.reduce((sum,row)=>sum+Number(row.amount_to_remit),0)*100)/100,difference=Math.round((reportedAmount-expected)*100)/100,created=db.prepare("INSERT INTO courier_cash_settlements(delivery_user_id,expected_amount,reported_amount,difference_amount,status,courier_note) VALUES(?,?,?,?,'review',?)").run(req.user.id,expected,reportedAmount,difference,note),id=Number(created.lastInsertRowid),link=db.prepare('UPDATE courier_cash_records SET settlement_id=? WHERE order_id=? AND delivery_user_id=? AND settlement_id IS NULL');for(const row of rows)if(link.run(id,row.order_id,req.user.id).changes!==1)throw new Error('El saldo cambió; actualiza el panel');return {id,expectedAmount:expected,reportedAmount,differenceAmount:difference,ordersCount:rows.length}})();audit(req,'courier_cash_reported','courier_cash_settlement',result.id);notifyAdmins(null,'courier_cash_reported','Efectivo reportado','Un repartidor envió una conciliación de efectivo.','/admin.html');res.status(201).json(result)}catch(error){res.status(409).json({error:error.message})}});
app.get('/api/admin/courier-cash-settlements',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT s.*,u.name delivery_name,dp.internal_number,(SELECT COUNT(*) FROM courier_cash_records c WHERE c.settlement_id=s.id) orders_count FROM courier_cash_settlements s JOIN users u ON u.id=s.delivery_user_id LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=s.delivery_user_id ORDER BY CASE s.status WHEN 'review' THEN 1 ELSE 2 END,s.id DESC LIMIT 100").all()));
app.get('/api/admin/driver-incentives',auth,role(['admin']),(req,res)=>res.json({goals:db.prepare('SELECT g.*,u.name created_by_name,(SELECT COUNT(*) FROM driver_goal_progress p WHERE p.goal_id=g.id AND p.completed_at IS NOT NULL) completions FROM driver_goals g LEFT JOIN users u ON u.id=g.created_by_user_id ORDER BY g.id DESC').all(),rewards:db.prepare('SELECT w.*,u.name delivery_name,g.name goal_name FROM driver_rewards w JOIN users u ON u.id=w.delivery_user_id LEFT JOIN driver_goals g ON g.id=w.goal_id ORDER BY CASE w.status WHEN \'earned\' THEN 1 ELSE 2 END,w.id DESC LIMIT 100').all()}));
app.post('/api/admin/driver-goals',auth,role(['admin']),rateLimit('driver-goals',20,60*60*1000),(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),periodType=String(req.body.periodType||''),target=Number(req.body.targetDeliveries),bonus=Math.round(Number(req.body.bonusAmount)*100)/100,startsAt=String(req.body.startsAt||''),endsAt=String(req.body.endsAt||'');if(name.length<3||!['daily','weekly'].includes(periodType)||!Number.isInteger(target)||target<1||target>200||!Number.isFinite(bonus)||bonus<0||bonus>10000||!Number.isFinite(Date.parse(startsAt))||!Number.isFinite(Date.parse(endsAt))||Date.parse(endsAt)<=Date.parse(startsAt))return res.status(400).json({error:'Datos de meta inválidos'});const created=db.prepare('INSERT INTO driver_goals(name,period_type,target_deliveries,bonus_amount,starts_at,ends_at,created_by_user_id) VALUES(?,?,?,?,?,?,?)').run(name,periodType,target,bonus,new Date(startsAt).toISOString(),new Date(endsAt).toISOString(),req.user.id);audit(req,'driver_goal_created','driver_goal',Number(created.lastInsertRowid));res.status(201).json({id:Number(created.lastInsertRowid)})});
app.patch('/api/admin/driver-goals/:id',auth,role(['admin']),(req,res)=>{const active=req.body.active===true?1:req.body.active===false?0:null;if(active===null)return res.status(400).json({error:'Estado inválido'});const changed=db.prepare('UPDATE driver_goals SET active=? WHERE id=?').run(active,Number(req.params.id));if(changed.changes!==1)return res.status(404).json({error:'Meta no encontrada'});audit(req,'driver_goal_status','driver_goal',Number(req.params.id));res.json({ok:true,active:Boolean(active)})});
app.post('/api/admin/driver-bonuses',auth,role(['admin']),rateLimit('driver-bonuses',20,60*60*1000),(req,res)=>{const deliveryUserId=Number(req.body.deliveryUserId),amount=Math.round(Number(req.body.amount)*100)/100,reason=String(req.body.reason||'').trim().slice(0,300);if(!Number.isInteger(deliveryUserId)||!Number.isFinite(amount)||amount<=0||amount>10000||reason.length<5||!db.prepare("SELECT id FROM users WHERE id=? AND role='delivery' AND account_status='approved'").get(deliveryUserId))return res.status(400).json({error:'Repartidor, cantidad o motivo inválido'});const created=db.prepare("INSERT INTO driver_rewards(delivery_user_id,amount,reward_type,reason) VALUES(?,?,'manual_bonus',?)").run(deliveryUserId,amount,reason);audit(req,'driver_bonus_created','driver_reward',Number(created.lastInsertRowid));addNotification(deliveryUserId,null,'manual_bonus','Nuevo incentivo','Recibiste un bono de $'+amount.toFixed(2)+'.','/delivery.html');res.status(201).json({id:Number(created.lastInsertRowid),amount})});
app.patch('/api/admin/driver-rewards/:id/pay',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),reference=String(req.body.reference||'').trim().slice(0,120);if(!Number.isInteger(id)||reference.length<3)return res.status(400).json({error:'Escribe una referencia de pago'});const changed=db.prepare("UPDATE driver_rewards SET status='paid',paid_at=CURRENT_TIMESTAMP,paid_by_user_id=?,reference=? WHERE id=? AND status='earned'").run(req.user.id,reference,id);if(changed.changes!==1)return res.status(409).json({error:'El bono ya fue pagado, cancelado o no existe'});const reward=db.prepare('SELECT delivery_user_id,amount FROM driver_rewards WHERE id=?').get(id);audit(req,'driver_reward_paid','driver_reward',id);addNotification(reward.delivery_user_id,null,'bonus_paid','Bono pagado','Se confirmó el pago de tu bono por $'+Number(reward.amount).toFixed(2)+'.','/delivery.html');res.json({ok:true,status:'paid'})});
app.patch('/api/admin/courier-cash-settlements/:id',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),reference=String(req.body.reference||'').trim().slice(0,120),note=String(req.body.adminNote||'').trim().slice(0,500);if(!Number.isInteger(id)||reference.length<3||note.length<3)return res.status(400).json({error:'Escribe referencia y nota de conciliación'});const result=db.prepare("UPDATE courier_cash_settlements SET status='settled',reference=?,admin_note=?,settled_at=CURRENT_TIMESTAMP,settled_by_user_id=? WHERE id=? AND status='review'").run(reference,note,req.user.id,id);if(result.changes!==1)return res.status(409).json({error:'La conciliación ya fue cerrada o no existe'});const settlement=db.prepare('SELECT delivery_user_id,difference_amount FROM courier_cash_settlements WHERE id=?').get(id);audit(req,'courier_cash_settled','courier_cash_settlement',id);addNotification(settlement.delivery_user_id,null,'courier_cash_settled','Efectivo conciliado','Administración revisó y cerró tu reporte de efectivo.','/delivery.html');res.json({ok:true,status:'settled',differenceAmount:settlement.difference_amount})});

app.get('/api/delivery/orders/available',auth,role(['delivery']),(req,res)=>{

    const profile=db.prepare("SELECT status,vehicle_type,COALESCE(max_active_orders,1) max_active_orders FROM delivery_profiles WHERE delivery_user_id=? AND verification_status='verified'").get(req.user.id);
    const activeOrders=db.prepare("SELECT o.delivery_latitude,o.delivery_longitude FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering')").all(req.user.id);
    if(!profile||profile.status==='offline'||activeOrders.length>=Number(profile.max_active_orders))return res.json({locationReady:false,capacityAvailable:false,orders:[]});

    const pedidos = db.prepare(`
        SELECT
            o.id,o.total,o.subtotal,o.delivery_fee,o.distance_km,o.payment_method,
            o.order_timing,o.scheduled_for,o.estimated_prep_minutes,o.created_at,
            r.name AS restaurant_name,
            r.address AS restaurant_address,
            r.phone AS restaurant_phone,
            r.latitude AS restaurant_latitude,
            r.longitude AS restaurant_longitude
        FROM orders o
        JOIN restaurants r
            ON r.id = o.restaurant_id
        LEFT JOIN delivery_assignments da
            ON da.order_id = o.id
        WHERE o.status = 'ready'
        AND (o.scheduled_for IS NULL OR julianday(o.scheduled_for)<=julianday('now','+' || ? || ' minutes'))
        AND NOT EXISTS(SELECT 1 FROM delivery_rejections dr WHERE dr.order_id=o.id AND dr.delivery_user_id=?)
        AND (
            da.id IS NULL
            OR da.status = 'available'
        )
        ORDER BY o.id ASC
    `).all(COURIER_SCHEDULE_WINDOW_MINUTES,req.user.id);

    const items = db.prepare(`
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `);

    const deliveryLocation=db.prepare("SELECT latitude,longitude,updated_at FROM delivery_locations WHERE delivery_user_id=? AND datetime(updated_at)>=datetime('now','-30 minutes')").get(req.user.id);
    const performance=db.prepare("SELECT COUNT(rv.delivery_rating) ratings,ROUND(AVG(rv.delivery_rating),1) rating FROM order_reviews rv JOIN orders o ON o.id=rv.order_id WHERE rv.delivery_user_id=? AND o.is_demo=0").get(req.user.id);
    const result=pedidos.map(p => {
        const pickupDistance=deliveryLocation&&p.restaurant_latitude!=null&&p.restaurant_longitude!=null?Math.round(distanceKm(Number(deliveryLocation.latitude),Number(deliveryLocation.longitude),Number(p.restaurant_latitude),Number(p.restaurant_longitude))*100)/100:null;
        const routeDistance=activeOrders.length&&p.restaurant_latitude!=null&&p.restaurant_longitude!=null?Math.min(...activeOrders.filter(order=>order.delivery_latitude!=null&&order.delivery_longitude!=null).map(order=>distanceKm(Number(order.delivery_latitude),Number(order.delivery_longitude),Number(p.restaurant_latitude),Number(p.restaurant_longitude)))):null;
        const waitingMinutes=Math.max(0,Math.floor((Date.now()-(sqliteInstant(p.created_at)?.getTime()||Date.now()))/60000)),reasons=[];
        let score=60+Math.min(20,waitingMinutes/3)-activeOrders.length*20;
        if(pickupDistance!==null){score-=Math.min(30,pickupDistance*4);reasons.push(pickupDistance<=2?'Recogida cercana':pickupDistance<=5?'Distancia moderada':'Recogida lejana');}else reasons.push('Activa ubicación para mejorar la recomendación');
        if(Number(performance.ratings)>=5){score+=(Number(performance.rating)-4)*8;reasons.push('Considera tu historial de entregas');}
        if(routeDistance!==null&&Number.isFinite(routeDistance)){if(routeDistance<=2){score+=12;reasons.push('Compatible con tu ruta activa');}else if(routeDistance<=5){score+=5;reasons.push('Cerca de tu ruta activa');}}
        if((profile.vehicle_type==='walking'&&Number(p.distance_km)>4)||(profile.vehicle_type==='bicycle'&&Number(p.distance_km)>8)){score-=18;reasons.push('Trayecto largo para tu vehículo');}
        if(waitingMinutes>=15)reasons.push('Pedido con tiempo de espera');
        return {
            ...p,
            items: items.all(p.id),
            distance_to_restaurant_km:pickupDistance,
            recommendation_score:Math.max(0,Math.min(100,Math.round(score))),
            recommendation_reasons:reasons.slice(0,3)
        };
    }).sort((a,b)=>b.recommendation_score-a.recommendation_score||a.id-b.id).map((order,index)=>({...order,recommended:index===0}));
    res.json({locationReady:Boolean(deliveryLocation),capacityAvailable:true,activeOrders:activeOrders.length,maxActiveOrders:Number(profile.max_active_orders),automaticAssignment:false,orders:result});

});


app.post('/api/delivery/orders/:id/accept',auth,role(['delivery']),(req,res)=>{

    const orderId = Number(req.params.id);

    if(!Number.isInteger(orderId) || orderId <= 0){
        return res.status(400).json({
            error:'Pedido inválido'
        });
    }

    try{

        if(hasCorrectiveAction(req.user.id,'temporary_restriction'))return res.status(403).json({error:'Tu cuenta tiene una restricción temporal para aceptar pedidos nuevos. Consulta Mi cuenta o soporte.'});

        const resultado = db.transaction(()=>{
            const profile=db.prepare("SELECT status,verification_status,max_active_orders FROM delivery_profiles WHERE delivery_user_id=?").get(req.user.id);if(!profile||!['available','busy'].includes(profile.status))throw new Error('Activa tu disponibilidad antes de aceptar pedidos');if(profile.verification_status!=='verified')throw new Error('Tu perfil de repartidor debe estar verificado');

            const active=db.prepare("SELECT COUNT(*) total FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering') AND da.order_id<>?").get(req.user.id,orderId);
            if(active.total>=Math.max(1,Number(profile.max_active_orders)||1))throw new Error('Alcanzaste tu límite de entregas activas');

            const pedido = db.prepare(`
                SELECT id,status,scheduled_for
                FROM orders
                WHERE id = ?
            `).get(orderId);

            if(!pedido){
                throw new Error('Pedido no encontrado');
            }

            if(pedido.status !== 'ready'){
                throw new Error(
                    'El pedido todavía no está listo para entrega'
                );
            }
            if(!canOfferScheduledOrder(pedido))throw new Error('El pedido programado todavía no está disponible para reparto');

            const existente = db.prepare(`
                SELECT *
                FROM delivery_assignments
                WHERE order_id = ?
            `).get(orderId);

            if(existente && existente.status === 'accepted'){
                throw new Error(
                    'Este pedido ya fue aceptado por otro repartidor'
                );
            }

            if(existente){

                db.prepare(`
                    UPDATE delivery_assignments
                    SET
                        delivery_user_id = ?,
                        status = 'accepted',
                        accepted_at = CURRENT_TIMESTAMP
                    WHERE order_id = ?
                `).run(req.user.id,orderId);

            }else{

                db.prepare(`
                    INSERT INTO delivery_assignments
                    (
                        order_id,
                        delivery_user_id,
                        status,
                        accepted_at
                    )
                    VALUES(?,?,'accepted',CURRENT_TIMESTAMP)
                `).run(
                    orderId,
                    req.user.id
                );

            }

            const statusChange=db.prepare("UPDATE orders SET status='assigned' WHERE id=? AND status='ready'").run(orderId);
            if(statusChange.changes!==1)throw new Error('El pedido cambió antes de asignarse');
            ensureDeliveryPin(orderId);
            recordOrderStatus(orderId,'ready','assigned',req.user,'Repartidor asignado');
            db.prepare("UPDATE delivery_profiles SET status='busy',updated_at=CURRENT_TIMESTAMP WHERE delivery_user_id=?").run(req.user.id);

            return db.prepare(`
                SELECT *
                FROM delivery_assignments
                WHERE order_id = ?
            `).get(orderId);

        })();

        audit(req,'delivery_order_accepted','order',orderId);
        res.json({
            ok:true,
            assignment:resultado
        });

    }catch(error){

        res.status(409).json({
            error:error.message
        });

    }

});
app.post('/api/delivery/orders/:id/reject',auth,role(['delivery']),(req,res)=>{const id=Number(req.params.id);if(!db.prepare("SELECT id FROM orders WHERE id=? AND status='ready'").get(id))return res.status(409).json({error:'El pedido ya no está disponible'});db.prepare('INSERT OR IGNORE INTO delivery_rejections(order_id,delivery_user_id) VALUES(?,?)').run(id,req.user.id);audit(req,'delivery_order_rejected','order',id);res.json({ok:true});});


app.get('/api/delivery/orders/my',auth,role(['delivery']),(req,res)=>{

    const pedidos = db.prepare(`
        SELECT
            o.*,
            r.name AS restaurant_name,
            r.address AS restaurant_address,
            r.phone AS restaurant_phone,
            u.name AS customer_name,
            u.phone AS customer_phone,
            da.status AS delivery_status,
            da.accepted_at,
            da.delivered_at,
            COALESCE(rv.tip_amount,0) AS tip_amount,
            rv.delivery_rating
        FROM delivery_assignments da
        JOIN orders o
            ON o.id = da.order_id
        JOIN restaurants r
            ON r.id = o.restaurant_id
        JOIN users u
            ON u.id = o.customer_id
        LEFT JOIN order_reviews rv
            ON rv.order_id = o.id
        WHERE da.delivery_user_id = ?
        ORDER BY o.id DESC
    `).all(req.user.id);

    const items = db.prepare(`
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `);

    res.json(
        pedidos.map(p => ({
            ...p,
            address:['delivered','cancelled'].includes(p.status)?'Datos ocultos al cerrar la entrega':p.address,
            delivery_latitude:['delivered','cancelled'].includes(p.status)?null:p.delivery_latitude,
            delivery_longitude:['delivered','cancelled'].includes(p.status)?null:p.delivery_longitude,
            customer_name:['delivered','cancelled'].includes(p.status)?'Cliente':p.customer_name,
            customer_phone:['delivered','cancelled'].includes(p.status)?null:p.customer_phone,
            items:items.all(p.id)
        }))
    );

});

app.patch('/api/delivery/orders/:id',auth,role(['delivery']),(req,res)=>{
    const orderId=Number(req.params.id);
    const nuevoEstado=req.body.status;

    if(!Number.isInteger(orderId)||orderId<=0){
        return res.status(400).json({
            error:'Pedido inválido'
        });
    }

    if(!['delivering','delivered'].includes(nuevoEstado)){
        return res.status(400).json({
            error:'Estado de entrega inválido'
        });
    }

    const asignacion=db.prepare(`
        SELECT *
        FROM delivery_assignments
        WHERE order_id=?
        AND delivery_user_id=?
    `).get(orderId,req.user.id);

    if(!asignacion){
        return res.status(403).json({
            error:'Este pedido no está asignado a este repartidor'
        });
    }

    const pedido=db.prepare(`
        SELECT id,status,delivery_method
        FROM orders
        WHERE id=?
    `).get(orderId);

    if(!pedido){
        return res.status(404).json({
            error:'Pedido no encontrado'
        });
    }

    // 🔒 Una vez entregado, queda bloqueado definitivamente.
    if(pedido.status==='delivered'){
        return res.status(409).json({
            error:'Este pedido ya fue entregado y no puede modificarse'
        });
    }

    if(nuevoEstado==='delivering'){
        if(pedido.status!=='assigned'){
            return res.status(400).json({
                error:'El pedido no está listo para ser recogido'
            });
        }
        const changed=db.transaction(()=>{const result=db.prepare("UPDATE orders SET status='delivering' WHERE id=? AND status='assigned'").run(orderId);if(result.changes===1)recordOrderStatus(orderId,'assigned','delivering',req.user,'Pedido recogido');return result;})();
        if(changed.changes!==1)return res.status(409).json({error:'El pedido cambió; actualiza el panel'});
        audit(req,'order_picked_up','order',orderId);
        return res.json({
            ok:true,
            message:'Recogida confirmada. El pedido está en camino'
        });
    }

    if(nuevoEstado==='delivered'){

        if(pedido.status!=='delivering'){
            return res.status(400).json({
                error:'El pedido debe estar en camino antes de marcarlo como entregado'
            });
        }
        let proofName=null,proofLocation=null;
        if(pedido.delivery_method==='no_contact'){
            const dataUrl=String(req.body.proofDataUrl||''),match=dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
            if(!match)return res.status(400).json({error:'La entrega sin contacto requiere una fotografía PNG, JPG o WEBP'});
            const buffer=Buffer.from(match[2],'base64');
            if(!buffer.length||buffer.length>4*1024*1024)return res.status(400).json({error:'La evidencia debe pesar menos de 4 MB'});
            const valid=(match[1]==='jpeg'&&buffer[0]===0xff&&buffer[1]===0xd8)||(match[1]==='png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(match[1]==='webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP');
            if(!valid)return res.status(400).json({error:'La evidencia no contiene una imagen válida'});
            const latitude=Number(req.body.latitude),longitude=Number(req.body.longitude);
            if(Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180)proofLocation={latitude,longitude};
            proofName=crypto.randomUUID()+'.'+(match[1]==='jpeg'?'jpg':match[1]);
            fs.writeFileSync(path.join(deliveryProofDir,proofName),buffer,{mode:0o600});
        }else if(!verifyDeliveryPin(orderId,req.body.deliveryPin))return res.status(403).json({error:'El código de entrega es incorrecto'});

        let resultado;try{resultado=db.transaction(()=>{

            const cambioAsignacion=db.prepare(`
                UPDATE delivery_assignments
                SET
                    status='delivered',
                    delivered_at=CURRENT_TIMESTAMP,
                    latitude=NULL,
                    longitude=NULL,
                    location_accuracy=NULL,
                    location_updated_at=NULL
                WHERE order_id=?
                AND delivery_user_id=?
                AND status='accepted'
            `).run(
                orderId,
                req.user.id
            );

            if(cambioAsignacion.changes!==1){
                throw new Error(
                    'La asignación del pedido ya no está disponible'
                );
            }

            const cambioPedido=db.prepare(`
                UPDATE orders
                SET status='delivered',payment_status=CASE WHEN payment_status='pay_on_delivery' THEN 'paid' ELSE payment_status END
                WHERE id=?
                AND status='delivering'
            `).run(orderId);

            if(cambioPedido.changes!==1){
                throw new Error(
                    'El pedido ya no puede modificarse'
                );
            }

            if(proofName)db.prepare("INSERT INTO delivery_proofs(order_id,delivery_user_id,proof_type,photo_path,latitude,longitude,delete_after) VALUES(?,?,'no_contact',?,?,?,datetime('now','+30 days'))").run(orderId,req.user.id,proofName,proofLocation?.latitude||null,proofLocation?.longitude||null);
            db.prepare("INSERT OR IGNORE INTO courier_cash_records(order_id,delivery_user_id,cash_collected,courier_earnings,amount_to_remit) SELECT o.id,?,CASE WHEN o.payment_method='Efectivo' THEN o.total ELSE 0 END,MAX(0,f.courier_due),CASE WHEN o.payment_method='Efectivo' THEN MAX(0,o.total-f.courier_due) ELSE 0 END FROM orders o JOIN order_financials f ON f.order_id=o.id WHERE o.id=?").run(req.user.id,orderId);
            const trustActors=db.prepare('SELECT o.customer_id,r.owner_id FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=?').get(orderId);adjustTrust(trustActors.customer_id,1);adjustTrust(trustActors.owner_id,1);adjustTrust(req.user.id,1);rewardDeliveredOrder(orderId);recordCourierAchievement(req.user.id,orderId);
            recordOrderStatus(orderId,'delivering','delivered',req.user,proofName?'Entrega sin contacto con evidencia fotográfica':'PIN del cliente validado');
            db.prepare("UPDATE delivery_profiles SET status='available',updated_at=CURRENT_TIMESTAMP WHERE delivery_user_id=?").run(req.user.id);
            db.prepare("DELETE FROM delivery_locations WHERE delivery_user_id=? AND NOT EXISTS(SELECT 1 FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering'))").run(req.user.id,req.user.id);

            return true;
        })();}catch(error){if(proofName)try{fs.unlinkSync(path.join(deliveryProofDir,proofName))}catch(_){}throw error;}

        db.prepare("UPDATE order_financials SET payment_status=CASE WHEN payment_status='pay_on_delivery' THEN 'paid' ELSE payment_status END,updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);audit(req,'order_delivered','order',orderId);
        return res.json({
            ok:resultado,
            message:'Pedido entregado correctamente'
        });
    }
});
app.get('/api/orders/:id/delivery-proof',auth,(req,res)=>{const orderId=Number(req.params.id);if(!Number.isInteger(orderId))return res.status(400).json({error:'Pedido inválido'});const proof=db.prepare('SELECT p.*,o.customer_id,da.delivery_user_id,r.owner_id FROM delivery_proofs p JOIN orders o ON o.id=p.order_id JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN delivery_assignments da ON da.order_id=o.id WHERE p.order_id=?').get(orderId);if(!proof)return res.status(404).json({error:'Evidencia no encontrada'});const allowed=req.user.role==='admin'||req.user.id===proof.customer_id||req.user.id===proof.owner_id||req.user.id===proof.delivery_user_id;if(!allowed)return res.status(403).json({error:'No puedes consultar esta evidencia'});const file=path.join(deliveryProofDir,path.basename(proof.photo_path||''));if(!proof.photo_path||!fs.existsSync(file))return res.status(404).json({error:'La evidencia ya no está disponible'});res.set('Cache-Control','private, no-store');res.type(path.extname(file));res.sendFile(file)});
app.patch('/api/delivery/orders/:id/location',auth,role(['delivery']),(req,res)=>{
    const orderId=Number(req.params.id);
    const latitude=Number(req.body.latitude);
    const longitude=Number(req.body.longitude);
    const accuracy=Number(req.body.accuracy || 0);

    if(!Number.isInteger(orderId)||orderId<=0||
       !Number.isFinite(latitude)||latitude < -90||latitude > 90||
       !Number.isFinite(longitude)||longitude < -180||longitude > 180){
        return res.status(400).json({error:'Ubicación inválida'});
    }

    const result=db.prepare(`
        UPDATE delivery_assignments
        SET latitude=?, longitude=?, location_accuracy=?,
            location_updated_at=CURRENT_TIMESTAMP
        WHERE order_id=? AND delivery_user_id=? AND status='accepted'
    `).run(latitude,longitude,accuracy,orderId,req.user.id);

    if(result.changes!==1){
        return res.status(403).json({
            error:'No tienes una entrega activa para compartir ubicación'
        });
    }

    res.json({ok:true,latitude,longitude});
});

app.get('/api/orders/:id/messages',auth,(req,res)=>{const orderId=Number(req.params.id),channel=String(req.query.channel||'customer_restaurant');if(!Number.isInteger(orderId)||!['customer_restaurant','customer_delivery'].includes(channel))return res.status(400).json({error:'Conversación inválida'});const access=orderChatAccess(req.user,orderId,channel);if(!access)return res.status(403).json({error:'No puedes ver esta conversación'});if(channel==='customer_delivery'&&!access.order.delivery_user_id)return res.status(409).json({error:'Todavía no hay repartidor asignado'});const messages=db.prepare('SELECT m.id,m.sender_user_id,m.sender_role,m.message,m.created_at,u.name sender_name FROM order_messages m JOIN users u ON u.id=m.sender_user_id WHERE m.order_id=? AND m.channel=? ORDER BY m.id ASC LIMIT 200').all(orderId,channel);res.json({messages,canPost:access.canPost&&!['delivered','cancelled'].includes(access.order.status),status:access.order.status,retentionDays:30});});
app.post('/api/orders/:id/messages',auth,rateLimit('order-chat',40,10*60*1000),(req,res)=>{const orderId=Number(req.params.id),channel=String(req.body.channel||'customer_restaurant'),message=String(req.body.message||'').trim();if(!Number.isInteger(orderId)||!['customer_restaurant','customer_delivery'].includes(channel))return res.status(400).json({error:'Conversación inválida'});if(message.length<1||message.length>500)return res.status(400).json({error:'El mensaje debe tener entre 1 y 500 caracteres'});if(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(message)||/(?:\+?52[\s.-]?)?(?:\d[\s.-]?){10}/.test(message))return res.status(400).json({error:'Por seguridad no compartas correos ni números personales en el chat'});const access=orderChatAccess(req.user,orderId,channel);if(!access||!access.canPost)return res.status(403).json({error:'No puedes escribir en esta conversación'});if(['delivered','cancelled'].includes(access.order.status))return res.status(409).json({error:'La conversación se cerró al terminar el pedido'});if(channel==='customer_delivery'&&!access.order.delivery_user_id)return res.status(409).json({error:'Todavía no hay repartidor asignado'});const result=db.prepare('INSERT INTO order_messages(order_id,sender_user_id,sender_role,channel,message) VALUES(?,?,?,?,?)').run(orderId,req.user.id,req.user.role,channel,message);for(const userId of chatRecipientIds(access.order,channel,req.user.id))addNotification(userId,orderId,'order_message','Nuevo mensaje del pedido #'+orderId,message.slice(0,120),req.user.role==='customer'?(channel==='customer_restaurant'?'/restaurant.html':'/delivery.html'):'/tracking.html?order='+orderId);res.status(201).json({id:Number(result.lastInsertRowid),createdAt:new Date().toISOString()});});

app.get('/api/group-orders/restaurants',auth,role(['customer']),(req,res)=>{refreshTemporaryAvailability();res.json(db.prepare("SELECT r.id,r.name FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.active=1 AND r.operational_status NOT IN ('closed','paused') ORDER BY r.name").all());});
app.post('/api/group-orders',auth,role(['customer']),rateLimit('group-orders',12,60*60*1000),(req,res)=>{const restaurantId=Number(req.body.restaurantId),restaurant=db.prepare("SELECT r.id,r.name FROM restaurants r JOIN users owner ON owner.id=r.owner_id AND owner.account_status='approved' WHERE r.id=? AND r.active=1 AND r.operational_status NOT IN ('closed','paused')").get(restaurantId);if(!restaurant)return res.status(404).json({error:'Restaurante no disponible'});const code=crypto.randomBytes(5).toString('hex').toUpperCase(),expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();const result=db.prepare("INSERT INTO group_orders(invite_code,creator_user_id,restaurant_id,expires_at) VALUES(?,?,?,?)").run(code,req.user.id,restaurantId,expiresAt);res.status(201).json({id:Number(result.lastInsertRowid),code,restaurantName:restaurant.name,expiresAt,url:'/group-order.html?code='+code});});
app.get('/api/group-orders/:code',auth,role(['customer']),(req,res)=>{purgeExperienceData();const code=String(req.params.code||'').trim().toUpperCase(),group=db.prepare('SELECT g.*,r.name restaurant_name,u.name creator_name FROM group_orders g JOIN restaurants r ON r.id=g.restaurant_id JOIN users u ON u.id=g.creator_user_id WHERE g.invite_code=?').get(code);if(!group)return res.status(404).json({error:'Pedido grupal no encontrado'});const products=db.prepare("SELECT id,name,description,price,category,variants_json,addons_json FROM products WHERE restaurant_id=? AND available=1 AND (stock_enabled=0 OR stock_quantity>0) ORDER BY category,name").all(group.restaurant_id).map(p=>({...p,variants:JSON.parse(p.variants_json||'[]'),addons:JSON.parse(p.addons_json||'[]'),variants_json:undefined,addons_json:undefined}));const items=db.prepare('SELECT gi.id,gi.participant_user_id,gi.participant_name,gi.product_id,gi.quantity,gi.variant,gi.addons_json,p.name product_name FROM group_order_items gi JOIN products p ON p.id=gi.product_id WHERE gi.group_order_id=? ORDER BY gi.id').all(group.id).map(i=>({...i,addons:JSON.parse(i.addons_json||'[]'),canRemove:i.participant_user_id===req.user.id||group.creator_user_id===req.user.id,addons_json:undefined}));res.json({id:group.id,code,restaurantId:group.restaurant_id,restaurantName:group.restaurant_name,creatorName:group.creator_name,status:group.status,expiresAt:group.expires_at,isCreator:group.creator_user_id===req.user.id,products,items});});
app.post('/api/group-orders/:code/items',auth,role(['customer']),rateLimit('group-items',50,10*60*1000),(req,res)=>{purgeExperienceData();const group=db.prepare("SELECT * FROM group_orders WHERE invite_code=? AND status='open' AND datetime(expires_at)>CURRENT_TIMESTAMP").get(String(req.params.code||'').trim().toUpperCase());if(!group)return res.status(409).json({error:'El pedido grupal ya no acepta productos'});const product=db.prepare('SELECT * FROM products WHERE id=? AND restaurant_id=? AND available=1').get(Number(req.body.productId),group.restaurant_id),quantity=Number(req.body.quantity);if(!product||product.availability_status==='sold_out'||(product.stock_enabled&&product.stock_quantity<quantity))return res.status(409).json({error:'El producto no está disponible en esa cantidad'});if(!Number.isInteger(quantity)||quantity<1||quantity>20)return res.status(400).json({error:'Cantidad inválida'});try{productSelection(product,{variant:req.body.variant,addons:req.body.addons});}catch(error){return res.status(400).json({error:error.message})}const result=db.prepare('INSERT INTO group_order_items(group_order_id,participant_user_id,participant_name,product_id,quantity,variant,addons_json) VALUES(?,?,?,?,?,?,?)').run(group.id,req.user.id,String(req.user.name||'Participante').slice(0,80),product.id,quantity,String(req.body.variant||'').slice(0,60),JSON.stringify(Array.isArray(req.body.addons)?req.body.addons.slice(0,20):[]));res.status(201).json({id:Number(result.lastInsertRowid)});});
app.delete('/api/group-orders/:code/items/:itemId',auth,role(['customer']),(req,res)=>{const group=db.prepare("SELECT * FROM group_orders WHERE invite_code=? AND status='open'").get(String(req.params.code||'').trim().toUpperCase());if(!group)return res.status(409).json({error:'El pedido grupal está cerrado'});const item=db.prepare('SELECT * FROM group_order_items WHERE id=? AND group_order_id=?').get(Number(req.params.itemId),group.id);if(!item)return res.status(404).json({error:'Producto no encontrado'});if(item.participant_user_id!==req.user.id&&group.creator_user_id!==req.user.id)return res.status(403).json({error:'Sólo puedes quitar tus productos'});db.prepare('DELETE FROM group_order_items WHERE id=?').run(item.id);res.json({ok:true});});
app.post('/api/group-orders/:code/complete',auth,role(['customer']),(req,res)=>{const code=String(req.params.code||'').trim().toUpperCase(),group=db.prepare("SELECT * FROM group_orders WHERE invite_code=? AND creator_user_id=? AND status='open' AND datetime(expires_at)>CURRENT_TIMESTAMP").get(code,req.user.id);if(!group)return res.status(403).json({error:'Sólo quien creó el pedido puede finalizarlo'});const rows=db.prepare('SELECT gi.product_id,gi.quantity,gi.variant,gi.addons_json,gi.participant_name,p.name,p.price,p.category,p.available,p.availability_status,p.stock_enabled,p.stock_quantity,p.variants_json,p.addons_json product_addons_json FROM group_order_items gi JOIN products p ON p.id=gi.product_id WHERE gi.group_order_id=? ORDER BY gi.id').all(group.id);if(!rows.length)return res.status(409).json({error:'Agreguen al menos un producto'});const restaurantName=db.prepare('SELECT name FROM restaurants WHERE id=?').get(group.restaurant_id).name,items=[];try{for(const row of rows){if(!row.available||row.availability_status==='sold_out'||(row.stock_enabled&&row.stock_quantity<row.quantity))throw new Error(row.name+' ya no está disponible');const addons=JSON.parse(row.addons_json||'[]'),choice=productSelection({...row,addons_json:row.product_addons_json},{variant:row.variant,addons});items.push({id:row.product_id,name:row.name,price:choice.unitPrice,category:row.category,quantity:row.quantity,restaurantId:group.restaurant_id,restaurantName,variant:row.variant||'',addons,optionsDescription:choice.optionsDescription,optionKey:(row.variant||'')+'|'+addons.join('|'),participantName:row.participant_name});}}catch(error){return res.status(409).json({error:error.message})}db.prepare("UPDATE group_orders SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(group.id);res.json({items});});

app.get('/api/help/topics',(req,res)=>res.json([{id:'order_status',title:'¿Dónde está mi pedido?',answer:'Consulta Mis pedidos y seguimiento. Ahí verás el estado, tiempo estimado y mapa cuando el repartidor vaya en camino.',url:'/tracking.html'},{id:'change_order',title:'Necesito cambiar o cancelar',answer:'Antes de que el restaurante acepte puedes modificar o cancelar. Después, usa el chat o reporta una incidencia.',url:'/tracking.html'},{id:'missing',title:'Falta o está mal un producto',answer:'Conserva el pedido y crea un reporte ligado a la orden para que administración pueda revisar el historial.',url:'/feedback.html'},{id:'payment',title:'Problema con pago o cobro',answer:'No compartas claves ni datos de tarjeta. Registra el problema en el centro de incidencias.',url:'/feedback.html'},{id:'safety',title:'Seguridad y privacidad',answer:'El chat evita compartir teléfonos. La ubicación deja de mostrarse al cerrar el pedido y la evidencia se elimina según su plazo.',url:'/legal.html'}]));
app.post('/api/orders/:id/survey',auth,role(['customer']),rateLimit('order-survey',20,60*60*1000),(req,res)=>{const orderId=Number(req.params.id),order=db.prepare("SELECT id FROM orders WHERE id=? AND customer_id=? AND status='delivered'").get(orderId,req.user.id);if(!order)return res.status(409).json({error:'La encuesta sólo está disponible al entregar tu pedido'});if(typeof req.body.everythingOk!=='boolean')return res.status(400).json({error:'Selecciona Sí o No'});try{db.prepare('INSERT INTO order_surveys(order_id,customer_id,everything_ok) VALUES(?,?,?)').run(orderId,req.user.id,req.body.everythingOk?1:0);res.status(201).json({ok:true,needsHelp:!req.body.everythingOk,helpUrl:'/feedback.html?order='+orderId});}catch(error){res.status(409).json({error:'Ya respondiste esta encuesta'})}});

app.get('/api/orders/:id/tracking',auth,role(['customer']),(req,res)=>{
    const orderId=Number(req.params.id);
    if(!Number.isInteger(orderId)||orderId<=0){
        return res.status(400).json({error:'Pedido inválido'});
    }

    const tracking=db.prepare(`
        SELECT o.id,o.status,o.address,o.created_at,o.order_timing,o.scheduled_for,o.delivery_latitude,o.delivery_longitude,
               o.payment_method,o.payment_status,o.provider_checkout_url,o.delivery_method,o.distance_km,o.estimated_prep_minutes,o.accepted_prep_minutes,o.accepted_eta_at,r.id AS restaurant_id,r.name AS restaurant_name,r.address AS restaurant_address,
               u.id AS delivery_user_id,u.name AS delivery_name,u.phone AS delivery_phone,dp.internal_number AS delivery_internal_number,dp.vehicle_type AS delivery_vehicle_type,dp.vehicle_description AS delivery_vehicle_description,dp.verification_status AS delivery_verification_status,
               da.latitude,da.longitude,da.location_accuracy,
               da.location_updated_at,da.accepted_at,da.delivered_at,
               rv.restaurant_rating,rv.delivery_rating,rv.food_rating,rv.completeness_rating,rv.preparation_rating,rv.punctuality_rating,rv.courtesy_rating,rv.delivery_quality_rating,rv.comment AS review_comment,rv.tip_amount,os.everything_ok AS survey_everything_ok
        FROM orders o
        JOIN restaurants r ON r.id=o.restaurant_id
        LEFT JOIN delivery_assignments da ON da.order_id=o.id
        LEFT JOIN users u ON u.id=da.delivery_user_id
        LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=da.delivery_user_id
        LEFT JOIN order_reviews rv ON rv.order_id=o.id
        LEFT JOIN order_surveys os ON os.order_id=o.id
        WHERE o.id=? AND o.customer_id=?
    `).get(orderId,req.user.id);

    if(!tracking){
        return res.status(404).json({error:'Pedido no encontrado'});
    }

    if(['delivered','cancelled'].includes(tracking.status)){
        tracking.latitude=null;
        tracking.longitude=null;
        tracking.location_accuracy=null;
        tracking.location_updated_at=null;
        tracking.delivery_phone=null;
    }
    if(tracking.delivery_name)tracking.delivery_name=String(tracking.delivery_name).trim().split(/\s+/)[0];
    tracking.delivery_pin=['assigned','delivering'].includes(tracking.status)?deliveryPinFor(orderId):null;
    tracking.delivery_proof_available=Boolean(db.prepare('SELECT id FROM delivery_proofs WHERE order_id=?').get(orderId));
    tracking.history=db.prepare('SELECT from_status,to_status,actor_role,note,created_at FROM order_status_history WHERE order_id=? ORDER BY id').all(orderId);
    const eta=dynamicDeliveryEstimate(tracking);tracking.estimated_delivery_min_at=eta.minAt;tracking.estimated_delivery_max_at=eta.maxAt;tracking.eta_details=eta.details;
    tracking.delay_review=db.prepare("SELECT d.responsibility,d.decided_at FROM order_issues i JOIN dispute_resolutions d ON d.issue_id=i.id WHERE i.order_id=? AND i.issue_type='delayed' AND i.status='resolved' ORDER BY d.decided_at DESC LIMIT 1").get(orderId)||null;
    tracking.substitutions=db.prepare('SELECT id,original_name,replacement_name,original_unit_price,replacement_unit_price,price_difference,description,status,created_at,responded_at FROM order_substitutions WHERE order_id=? ORDER BY id').all(orderId);
    res.json(tracking);
});

app.post('/api/orders/:id/review',auth,role(['customer']),rateLimit('order-review',12,60*60*1000),(req,res)=>{
    const orderId=Number(req.params.id),restaurantRating=Number(req.body.restaurantRating),deliveryRating=req.body.deliveryRating==null||req.body.deliveryRating===''?null:Number(req.body.deliveryRating),tipAmount=Math.round(Number(req.body.tipAmount||0)*100)/100,comment=String(req.body.comment||'').trim().slice(0,500),optionalRating=name=>req.body[name]==null||req.body[name]===''?null:Number(req.body[name]),details={foodRating:optionalRating('foodRating'),completenessRating:optionalRating('completenessRating'),preparationRating:optionalRating('preparationRating'),punctualityRating:optionalRating('punctualityRating'),courtesyRating:optionalRating('courtesyRating'),deliveryQualityRating:optionalRating('deliveryQualityRating')},invalidDetail=Object.values(details).some(value=>value!==null&&(!Number.isInteger(value)||value<1||value>5));
    if(!Number.isInteger(orderId)||orderId<=0||!Number.isInteger(restaurantRating)||restaurantRating<1||restaurantRating>5||deliveryRating!==null&&(!Number.isInteger(deliveryRating)||deliveryRating<1||deliveryRating>5)||invalidDetail||!Number.isFinite(tipAmount)||tipAmount<0||tipAmount>1000)return res.status(400).json({error:'Calificación o propina inválida'});
    const order=db.prepare(`SELECT o.id,o.restaurant_id,o.status,da.delivery_user_id FROM orders o LEFT JOIN delivery_assignments da ON da.order_id=o.id WHERE o.id=? AND o.customer_id=?`).get(orderId,req.user.id);
    if(!order)return res.status(404).json({error:'Pedido no encontrado'});
    if(order.status!=='delivered')return res.status(409).json({error:'Podrás calificar cuando el pedido haya sido entregado'});
    if(deliveryRating!==null&&!order.delivery_user_id)return res.status(400).json({error:'El pedido no tiene repartidor para calificar'});
    if(tipAmount>0&&!order.delivery_user_id)return res.status(400).json({error:'El pedido no tiene repartidor para recibir propina'});
    try{
        db.prepare(`INSERT INTO order_reviews(order_id,customer_id,restaurant_id,delivery_user_id,restaurant_rating,delivery_rating,food_rating,completeness_rating,preparation_rating,punctuality_rating,courtesy_rating,delivery_quality_rating,comment,tip_amount,tip_method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'cash')`).run(order.id,req.user.id,order.restaurant_id,order.delivery_user_id,restaurantRating,deliveryRating,details.foodRating,details.completenessRating,details.preparationRating,details.punctualityRating,details.courtesyRating,details.deliveryQualityRating,comment,tipAmount);
        db.prepare('UPDATE order_financials SET tip=?,courier_due=delivery_fee+?,updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(tipAmount,tipAmount,order.id);audit(req,'order_review_created','order',order.id);res.status(201).json({ok:true,tipAmount,tipMethod:'cash',details});
    }catch(error){if(String(error.code||'').includes('CONSTRAINT'))return res.status(409).json({error:'Este pedido ya fue calificado'});throw error;}
});

app.get('/api/ai/status',auth,(req,res)=>res.json({enabled:Boolean(OPENAI_API_KEY),model:OPENAI_API_KEY?OPENAI_MODEL:null}));

app.post('/api/ai/chat',auth,rateLimit('ai-chat',20,60*60*1000),async(req,res)=>{
    const message=String(req.body.message||'').trim().slice(0,800);
    if(!OPENAI_API_KEY)return res.status(503).json({error:'El asistente todavía no está activado por el administrador'});
    if(message.length<2)return res.status(400).json({error:'Escribe una pregunta para el asistente'});
    try{
        const moderation=await openAIRequest('moderations',{model:'omni-moderation-latest',input:message});
        if(moderation.results?.[0]?.flagged){
            audit(req,'ai_message_blocked','ai',null);
            return res.status(400).json({error:'No puedo procesar ese mensaje. Reformula tu solicitud.'});
        }
        const context=aiContextFor(req.user);
        const instructions=`Eres el asistente oficial de COME SAYULA, una plataforma local de comida y reparto en Sayula, Jalisco. Responde en español claro y breve. Rol actual: ${req.user.role}. ${aiRoleInstructions[req.user.role]||''}\nUsa únicamente los datos del CONTEXTO para precios, disponibilidad y estados. Si falta un dato, dilo; nunca lo inventes. No solicites contraseñas, códigos, datos bancarios ni ubicación exacta. No afirmes haber modificado pedidos, pagos, cuentas, productos o código: solo orientas y propones pasos. Para emergencias o riesgo físico indica contactar servicios locales. Los pagos, cancelaciones, suspensiones y cambios operativos requieren confirmación humana.`;
        const response=await openAIRequest('responses',{model:OPENAI_MODEL,instructions,input:`CONTEXTO (sin datos personales):\n${JSON.stringify(context)}\n\nPREGUNTA:\n${message}`,max_output_tokens:450,store:false});
        const answer=extractOpenAIText(response);
        if(!answer)throw new Error('OpenAI no devolvió texto');
        audit(req,'ai_assistant_used','ai',null);
        res.json({answer:answer.slice(0,4000)});
    }catch(error){
        console.error('AI ERROR ['+req.requestId+']',error.message);
        res.status(502).json({error:'El asistente no está disponible por el momento',requestId:req.requestId});
    }
});

app.get('/api/health',(req,res)=>{try{const integrity=db.pragma('quick_check',{simple:true});res.json({ok:integrity==='ok',database:integrity,aiConfigured:Boolean(OPENAI_API_KEY),persistentStorageConfigured:persistentStorageConfigured(),automaticBackupEnabled:backupStatus.enabled,lastBackupAt:backupStatus.lastSuccessAt,time:new Date().toISOString()});}catch(error){res.status(503).json({ok:false,requestId:req.requestId});}});
app.get('/api/public-config',(req,res)=>res.json({onlinePaymentEnabled:mercadoPagoConfigured(),onlinePaymentMode:mercadoPagoConfigured()?MERCADOPAGO_MODE:null}));

const backupsDir=path.join(dataDir,'backups');
async function automaticBackup(){
    let target;try{fs.mkdirSync(backupsDir,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');target=path.join(backupsDir,`come_sayula-${stamp}.db`);await db.backup(target);const verified=new Database(target,{readonly:true});try{if(verified.pragma('integrity_check',{simple:true})!=='ok')throw new Error('El respaldo nuevo no pasó integrity_check');}finally{verified.close();}backupStatus.lastSuccessAt=new Date().toISOString();const backups=fs.readdirSync(backupsDir).filter(name=>/^come_sayula-.*\.db$/.test(name)).map(name=>({name,time:fs.statSync(path.join(backupsDir,name)).mtimeMs})).sort((a,b)=>b.time-a.time);for(const old of backups.slice(BACKUP_RETENTION_COUNT))fs.unlinkSync(path.join(backupsDir,old.name));console.log('Respaldo automático verificado: '+target+' · conservados '+Math.min(backups.length,BACKUP_RETENTION_COUNT));}
    catch(error){if(target)try{fs.unlinkSync(target);}catch{}console.error('BACKUP ERROR:',error.message);}
}
if(process.env.DISABLE_AUTOMATIC_BACKUP!=='1'){setTimeout(automaticBackup,5000);setInterval(automaticBackup,24*60*60*1000);}

function notifyUnansweredOrders(){try{const orders=db.prepare(`SELECT o.id,o.customer_id,r.owner_id,r.id restaurant_id,r.name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status='received' AND o.is_demo=0 AND o.payment_status!='awaiting_online_payment' AND datetime(o.created_at,'+' || ? || ' minutes')<=CURRENT_TIMESTAMP AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.order_id=o.id AND n.type='order_unanswered')`).all(ORDER_RESPONSE_MINUTES);for(const order of orders){addNotification(order.customer_id,order.id,'order_unanswered','El restaurante aún no responde','Ya puedes cancelar este pedido sin penalización.','/tracking.html?order='+order.id);addNotification(order.owner_id,order.id,'order_unanswered','Pedido esperando respuesta','El pedido #'+order.id+' necesita atención inmediata.','/restaurant.html');for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(order.restaurant_id))addNotification(member.user_id,order.id,'order_unanswered','Pedido esperando respuesta','El pedido #'+order.id+' necesita atención inmediata.','/restaurant.html');notifyAdmins(order.id,'order_unanswered','Pedido sin respuesta',order.name+' no respondió el pedido #'+order.id+'.');}}catch(e){console.error('UNANSWERED NOTIFICATION ERROR',e.message);}}
setTimeout(notifyUnansweredOrders,Math.min(8000,NOTIFICATION_WORKER_INTERVAL_MS));setInterval(notifyUnansweredOrders,NOTIFICATION_WORKER_INTERVAL_MS);
function notifyScheduledPrep(orderId=null){try{const selected=orderId!==null&&Number.isInteger(Number(orderId))?Number(orderId):null,rows=db.prepare(`SELECT o.id,o.scheduled_for,o.estimated_prep_minutes,r.id restaurant_id,r.owner_id,r.name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.order_timing='scheduled' AND o.status='accepted' AND (? IS NULL OR o.id=?) AND julianday(o.scheduled_for,'-' || MAX(5,COALESCE(o.estimated_prep_minutes,30)) || ' minutes','-10 minutes')<=julianday('now') AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.order_id=o.id AND n.type='scheduled_prep_reminder')`).all(selected,selected);for(const order of rows){const message='El pedido #'+order.id+' debe comenzar a prepararse para cumplir la hora programada.';addNotification(order.owner_id,order.id,'scheduled_prep_reminder','Pedido programado próximo',message,'/restaurant.html');for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(order.restaurant_id))addNotification(member.user_id,order.id,'scheduled_prep_reminder','Pedido programado próximo',message,'/restaurant.html');}}catch(e){console.error('SCHEDULED REMINDER ERROR',e.message);}}
setTimeout(notifyScheduledPrep,Math.min(9000,NOTIFICATION_WORKER_INTERVAL_MS));setInterval(notifyScheduledPrep,NOTIFICATION_WORKER_INTERVAL_MS);

app.use((error,req,res,next)=>{console.error('REQUEST ERROR',req.requestId,error);if(res.headersSent)return next(error);res.status(500).json({error:'Ocurrió un error interno',requestId:req.requestId});});

const PORT=Number(process.env.PORT||3000);
app.listen(PORT,()=>console.log('COME SAYULA: http://localhost:'+PORT));
