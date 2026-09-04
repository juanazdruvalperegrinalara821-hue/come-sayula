const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const fs=require("fs");
const crypto=require("crypto");
const webpush=require('web-push');
const db=require("./database");
const {OAuth2Client}=require("google-auth-library");

const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||"846821366103-clbjraiah8qvdb5gia3op8h8rsu4c8ba.apps.googleusercontent.com";
const googleClient=new OAuth2Client(GOOGLE_CLIENT_ID);
const OPENAI_API_KEY=String(process.env.OPENAI_API_KEY||'').trim();
const OPENAI_MODEL=String(process.env.OPENAI_MODEL||'gpt-5-mini').trim();
const ORDER_RESPONSE_MINUTES=Math.min(60,Math.max(3,Number(process.env.ORDER_RESPONSE_MINUTES)||10));
const PLATFORM_COMMISSION_PERCENT=Math.min(100,Math.max(0,Number(process.env.PLATFORM_COMMISSION_PERCENT)||0));
const app=express();
app.set('trust proxy',process.env.TRUST_PROXY==='1'?1:false);
const dataDir=process.env.DATA_DIR||__dirname;
const uploadsDir=process.env.UPLOADS_DIR||path.join(dataDir,'uploads');
fs.mkdirSync(uploadsDir,{recursive:true});
const secretPath=path.join(dataDir,'.come_sayula_secret');
const SECRET=process.env.JWT_SECRET||(
    fs.existsSync(secretPath)
        ? fs.readFileSync(secretPath,'utf8').trim()
        : (()=>{const value=crypto.randomBytes(48).toString('hex');fs.writeFileSync(secretPath,value,{mode:0o600});return value;})()
);
const JWT_OPTIONS={algorithm:'HS256',issuer:'come-sayula',audience:'come-sayula-web'};
const signToken=user=>jwt.sign(user,SECRET,{...JWT_OPTIONS,expiresIn:'8h'});
const normalizeEmail=value=>String(value||'').trim().toLowerCase().slice(0,254);
const publicUser=user=>({id:user.id,name:user.name,email:user.email,phone:user.phone||'',role:user.role,accountStatus:user.account_status});

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
        const current=db.prepare('SELECT id,name,email,phone,role,account_status FROM users WHERE id=?').get(req.user.id);
        if(!current||current.account_status!=='approved')return res.status(403).json({error:'Esta cuenta está pendiente de aprobación o fue suspendida'});
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
    FROM restaurants r LEFT JOIN restaurant_members m ON m.restaurant_id=r.id AND m.user_id=? AND m.active=1
    WHERE r.owner_id=? OR m.user_id=? LIMIT 1`).get(userId,userId,userId,userId,userId,userId,userId);
const restaurantAccess=permission=>(req,res,next)=>{
    if(!['restaurant','restaurant_employee'].includes(req.user.role))return res.status(403).json({error:'Sin permisos'});
    const access=getRestaurantAccess(req.user.id);
    if(!access)return res.status(403).json({error:'La cuenta no está vinculada a un restaurante activo'});
    if(permission&&!access[permission])return res.status(403).json({error:'El dueño no habilitó este permiso para tu cuenta'});
    req.restaurant=access;next();
};
const restaurantOwner=(req,res,next)=>req.restaurant?.is_owner?next():res.status(403).json({error:'Esta acción está reservada al dueño del restaurante'});
const audit=(req,action,type,id)=>{try{db.prepare('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,ip_address) VALUES(?,?,?,?,?)').run(req.user?.id||null,action,type||null,id||null,String(req.ip||'').slice(0,64));}catch(e){console.error('AUDIT ERROR',e.message);}};
const sendPush=(userId,payload)=>{for(const row of db.prepare('SELECT id,subscription_json FROM push_subscriptions WHERE user_id=?').all(userId)){let subscription;try{subscription=JSON.parse(row.subscription_json);}catch(e){db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);continue;}webpush.sendNotification(subscription,JSON.stringify(payload),{TTL:300,urgency:'high'}).catch(error=>{if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);else console.error('PUSH ERROR',error.statusCode||'',error.message);});}};
const addNotification=(userId,orderId,type,title,message,targetUrl)=>{if(userId){const result=db.prepare('INSERT INTO notifications(user_id,order_id,type,title,message,target_url) VALUES(?,?,?,?,?,?)').run(userId,orderId||null,type,String(title).slice(0,120),String(message).slice(0,300),targetUrl||null);sendPush(userId,{id:Number(result.lastInsertRowid),title,message,url:targetUrl||'/'});}};
const notifyAdmins=(orderId,type,title,message,url='/admin.html')=>{for(const admin of db.prepare("SELECT id FROM users WHERE role='admin' AND account_status='approved'").all())addNotification(admin.id,orderId,type,title,message,url);};
function notifyOrderStatus(orderId,status,actor){
    const order=db.prepare('SELECT o.id,o.customer_id,o.restaurant_id,r.owner_id,r.name restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=?').get(orderId);if(!order)return;
    const info={received:['Nuevo pedido','Recibiste un nuevo pedido.','/restaurant.html'],accepted:['Pedido aceptado',`${order.restaurant_name} aceptó tu pedido.`,'/tracking.html?order='+orderId],preparing:['Pedido en preparación','Tu pedido ya se está preparando.','/tracking.html?order='+orderId],ready:['Pedido listo','Tu pedido está listo y busca repartidor.','/tracking.html?order='+orderId],assigned:['Repartidor asignado','Ya hay un repartidor asignado a tu pedido.','/tracking.html?order='+orderId],delivering:['Pedido en camino','Tu pedido salió rumbo a tu domicilio.','/tracking.html?order='+orderId],delivered:['Pedido entregado','Tu pedido fue marcado como entregado.','/home3.html'],cancelled:['Pedido cancelado','El pedido fue cancelado.','/home3.html']}[status];if(!info)return;
    const recipients=new Map();
    if(status==='received'){recipients.set(order.owner_id,'/restaurant.html');for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(order.restaurant_id))recipients.set(member.user_id,'/restaurant.html');}
    else recipients.set(order.customer_id,info[2]);
    if(status==='ready')for(const courier of db.prepare("SELECT u.id FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.role='delivery' AND u.account_status='approved' AND COALESCE(dp.status,'offline')='available'").all())recipients.set(courier.id,'/delivery.html');
    if(['assigned','delivering','delivered'].includes(status)){recipients.set(order.owner_id,'/restaurant.html');const assignment=db.prepare("SELECT delivery_user_id FROM delivery_assignments WHERE order_id=? AND status IN ('accepted','delivered')").get(orderId);if(assignment)recipients.set(assignment.delivery_user_id,'/delivery.html');}
    for(const [userId,url] of recipients)if(userId!==actor?.id)addNotification(userId,orderId,'order_'+status,info[0],info[1],url);
}
const recordOrderStatus=(orderId,fromStatus,toStatus,user,note='')=>{const result=db.prepare('INSERT INTO order_status_history(order_id,from_status,to_status,actor_user_id,actor_role,note) VALUES(?,?,?,?,?,?)').run(orderId,fromStatus||null,toStatus,user?.id||null,user?.role||'system',String(note||'').slice(0,300));notifyOrderStatus(orderId,toStatus,user);return result;};
const deliveryPinFor=orderId=>{const hex=crypto.createHmac('sha256',SECRET).update('delivery:'+orderId).digest('hex');return String(parseInt(hex.slice(0,8),16)%10000).padStart(4,'0');};

function aiContextFor(user){
    if(user.role==='customer'){
        const restaurants=db.prepare("SELECT id,name,description,address FROM restaurants WHERE active=1 ORDER BY name LIMIT 30").all();
        const products=db.prepare("SELECT p.id,p.name,p.description,p.price,r.name restaurant FROM products p JOIN restaurants r ON r.id=p.restaurant_id WHERE p.available=1 AND r.active=1 ORDER BY r.name,p.name LIMIT 100").all();
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
        const available=db.prepare("SELECT o.id,o.status,o.total,o.created_at,r.name restaurant FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN delivery_assignments da ON da.order_id=o.id WHERE o.status='ready' AND (da.id IS NULL OR da.status='available') ORDER BY o.id LIMIT 20").all();
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
app.post('/api/auth/register',rateLimit('register',8,15*60*1000),async(req,res)=>{try{const{name,phone,password}=req.body;const email=normalizeEmail(req.body.email);if(!name||!email||!password||String(password).length<8)return res.status(400).json({error:'Completa los datos y usa una contraseña de al menos 8 caracteres'});if(req.body.termsAccepted!==true)return res.status(400).json({error:'Debes aceptar los términos y el aviso de privacidad'});if(req.body.role&&req.body.role!=='customer')return res.status(403).json({error:'El registro público está disponible únicamente para clientes'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'No fue posible registrar esa cuenta'});const r=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,terms_accepted_at,terms_version) VALUES(?,?,?,?,'customer','approved',CURRENT_TIMESTAMP,'2026-09-02')").run(String(name).trim().slice(0,100),email,String(phone||'').trim().slice(0,30),await bcrypt.hash(password,12));const u=db.prepare('SELECT id,name,email,phone,role,account_status FROM users WHERE id=?').get(r.lastInsertRowid);audit({user:u,ip:req.ip},'customer_registered','user',u.id);res.status(201).json({token:signToken(publicUser(u)),user:publicUser(u)})}catch(e){console.error(e);res.status(500).json({error:'No fue posible crear la cuenta'})}});
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
    res.json({token:signToken(sessionUser),user:sessionUser});
});
app.post('/api/auth/forgot-password',rateLimit('forgot-password',5,30*60*1000),(req,res)=>{
    const email=normalizeEmail(req.body.email);
    const user=db.prepare("SELECT id FROM users WHERE email=? AND account_status='approved'").get(email);
    let developmentToken;
    if(user){
        const token=crypto.randomBytes(32).toString('hex');
        const hash=crypto.createHash('sha256').update(token).digest('hex');
        db.prepare("UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL").run(user.id);
        db.prepare("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 minutes'))").run(user.id,hash);
        audit(req,'password_reset_requested','user',user.id);
        if(process.env.DEV_SHOW_RESET_TOKEN==='1')developmentToken=token;
        else console.log('Recuperación solicitada para '+email+'. Configura un proveedor de correo/SMS para enviar el enlace.');
    }
    res.json({message:'Si la cuenta existe, enviaremos instrucciones para recuperar el acceso.',developmentToken});
});
app.post('/api/auth/reset-password',rateLimit('reset-password',8,30*60*1000),async(req,res)=>{
    const password=String(req.body.password||''),hash=crypto.createHash('sha256').update(String(req.body.token||'')).digest('hex');
    if(password.length<10)return res.status(400).json({error:'La nueva contraseña debe tener al menos 10 caracteres'});
    const record=db.prepare("SELECT id,user_id FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP").get(hash);
    if(!record)return res.status(400).json({error:'El enlace es inválido o ya venció'});
    db.transaction(()=>{db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password,12),record.user_id);db.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(record.id);})();
    audit(req,'password_reset_completed','user',record.user_id);res.json({ok:true});
});
app.get('/api/notifications',auth,(req,res)=>{const after=Math.max(0,Number(req.query.after)||0);const rows=db.prepare('SELECT id,order_id,type,title,message,target_url,read_at,created_at FROM notifications WHERE user_id=? AND id>? ORDER BY id DESC LIMIT 50').all(req.user.id,after);const unread=db.prepare('SELECT COUNT(*) total FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).total;res.json({notifications:rows,unread});});
app.patch('/api/notifications/read',auth,(req,res)=>{const id=req.body.id==null?null:Number(req.body.id);if(id!==null&&(!Number.isInteger(id)||id<=0))return res.status(400).json({error:'Notificación inválida'});if(id===null)db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL').run(req.user.id);else db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(id,req.user.id);res.json({ok:true});});
app.get('/api/push/public-key',auth,(req,res)=>res.json({publicKey:vapidKeys.publicKey}));
app.post('/api/push/subscribe',auth,rateLimit('push-subscribe',20,60*60*1000),(req,res)=>{const subscription=req.body.subscription,endpoint=String(subscription?.endpoint||'');if(!endpoint.startsWith('https://')||!subscription?.keys?.p256dh||!subscription?.keys?.auth)return res.status(400).json({error:'Suscripción inválida'});db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,subscription_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,subscription_json=excluded.subscription_json,updated_at=CURRENT_TIMESTAMP`).run(req.user.id,endpoint,JSON.stringify(subscription));res.status(201).json({ok:true});});
app.delete('/api/push/subscribe',auth,(req,res)=>{const endpoint=String(req.body.endpoint||'');db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id,endpoint);res.json({ok:true});});
app.get('/api/admin/pilot-readiness',auth,role(['admin']),(req,res)=>{const checks=[
    {key:'restaurant',label:'Restaurante aprobado con ubicación y producto',ready:Boolean(db.prepare("SELECT r.id FROM restaurants r JOIN users u ON u.id=r.owner_id JOIN products p ON p.restaurant_id=r.id AND p.available=1 WHERE u.account_status='approved' AND r.active=1 AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL LIMIT 1").get())},
    {key:'courier',label:'Repartidor aprobado',ready:Boolean(db.prepare("SELECT id FROM users WHERE role='delivery' AND account_status='approved' LIMIT 1").get())},
    {key:'zones',label:'Zona de entrega activa',ready:Boolean(db.prepare('SELECT id FROM delivery_zones WHERE available=1 LIMIT 1').get())},
    {key:'notifications',label:'Notificaciones móviles configuradas',ready:Boolean(vapidKeys.publicKey)},
    {key:'backups',label:'Respaldos automáticos habilitados',ready:process.env.DISABLE_AUTOMATIC_BACKUP!=='1'},
    {key:'support',label:'Correo formal de soporte configurado',ready:Boolean(process.env.SUPPORT_EMAIL)},
    {key:'payment',label:'Proveedor de cobro en línea configurado',ready:Boolean(process.env.PAYMENT_PROVIDER_ENABLED==='1')}
];res.json({readyForControlledPilot:checks.filter(c=>['restaurant','courier','zones','notifications','backups'].includes(c.key)).every(c=>c.ready),readyForPublicPayments:checks.every(c=>c.ready),checks});});

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
    db.transaction(()=>{db.prepare('UPDATE users SET account_status=? WHERE id=?').run(status,id);if(user.role==='restaurant')db.prepare('UPDATE restaurants SET active=? WHERE owner_id=?').run(status==='approved'?1:0,id);})();
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
app.get('/api/admin/delivery-couriers',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT u.id,u.name,u.phone,COALESCE(dp.status,'offline') status,(SELECT COUNT(*) FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=u.id AND da.status='accepted' AND o.status IN ('assigned','delivering')) active_orders FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.role='delivery' AND u.account_status='approved' ORDER BY status,name").all()));
app.get('/api/admin/delivery-ready-orders',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT o.id,o.total,r.name restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status='ready' ORDER BY o.id").all()));
app.post('/api/admin/orders/:id/assign',auth,role(['admin']),(req,res)=>{const orderId=Number(req.params.id),courierId=Number(req.body.deliveryUserId);const order=db.prepare("SELECT id,status FROM orders WHERE id=?").get(orderId),courier=db.prepare("SELECT u.id,COALESCE(dp.status,'offline') status FROM users u LEFT JOIN delivery_profiles dp ON dp.delivery_user_id=u.id WHERE u.id=? AND u.role='delivery' AND u.account_status='approved'").get(courierId);if(!order||order.status!=='ready')return res.status(409).json({error:'El pedido no está listo para asignación'});if(!courier||courier.status!=='available')return res.status(409).json({error:'El repartidor no está disponible'});try{db.transaction(()=>{db.prepare("INSERT INTO delivery_assignments(order_id,delivery_user_id,status,accepted_at) VALUES(?,?,'accepted',CURRENT_TIMESTAMP)").run(orderId,courierId);db.prepare("UPDATE orders SET status='assigned' WHERE id=? AND status='ready'").run(orderId);db.prepare("UPDATE delivery_profiles SET status='busy',updated_at=CURRENT_TIMESTAMP WHERE delivery_user_id=?").run(courierId);recordOrderStatus(orderId,'ready','assigned',req.user,'Asignación manual administrativa');})();audit(req,'admin_delivery_assigned','order',orderId);res.json({ok:true,status:'assigned'});}catch(e){res.status(409).json({error:'El pedido ya fue asignado'});}});

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

app.post('/api/admin/demo/create',auth,role(['admin']),rateLimit('demo-create',10,60*60*1000),(req,res)=>{
    const restaurant=db.prepare("SELECT r.id,r.prep_minutes,p.id product_id,p.name product_name,p.price FROM restaurants r JOIN products p ON p.restaurant_id=r.id AND p.available=1 WHERE r.active=1 ORDER BY r.id,p.id LIMIT 1").get();
    if(!restaurant)return res.status(409).json({error:'Necesitas al menos un restaurante activo con un producto disponible'});
    let customer=db.prepare("SELECT id FROM users WHERE email='demo-cliente@come-sayula.local'").get();
    if(!customer){const created=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,email_verified) VALUES('Cliente demostración','demo-cliente@come-sayula.local','',?,'customer','approved',1)").run(bcrypt.hashSync(crypto.randomBytes(18).toString('hex'),10));customer={id:Number(created.lastInsertRowid)};}
    const orderId=db.transaction(()=>{const o=db.prepare("INSERT INTO orders(customer_id,restaurant_id,address,payment_method,total,status,subtotal,delivery_fee,payment_status,client_request_id,estimated_prep_minutes,is_demo) VALUES(?,?,?,'Efectivo',?,'received',?,35,'pay_on_delivery',?,?,1)").run(customer.id,restaurant.id,'Pedido de demostración · Plaza principal',Number(restaurant.price)+35,restaurant.price,'demo-'+crypto.randomUUID(),restaurant.prep_minutes||30);const id=Number(o.lastInsertRowid);db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,1)').run(id,restaurant.product_id,restaurant.product_name,restaurant.price);recordOrderStatus(id,null,'received',req.user,'Pedido de demostración creado');return id;})();
    audit(req,'demo_order_created','order',orderId);res.status(201).json({orderId,status:'received'});
});
app.post('/api/admin/demo/:id/advance',auth,role(['admin']),(req,res)=>{const id=Number(req.params.id),order=db.prepare('SELECT id,status FROM orders WHERE id=? AND is_demo=1').get(id);if(!order)return res.status(404).json({error:'Pedido de demostración no encontrado'});const next={received:'accepted',accepted:'preparing',preparing:'ready',ready:'assigned',assigned:'delivering',delivering:'delivered'}[order.status];if(!next)return res.status(409).json({error:'La demostración ya terminó'});db.transaction(()=>{if(next==='assigned'){const courier=db.prepare("SELECT id FROM users WHERE role='delivery' AND account_status='approved' ORDER BY id LIMIT 1").get();if(!courier)throw new Error('Necesitas un repartidor aprobado');db.prepare("INSERT INTO delivery_assignments(order_id,delivery_user_id,status,accepted_at) VALUES(?,?,'accepted',CURRENT_TIMESTAMP)").run(id,courier.id);}db.prepare('UPDATE orders SET status=?,payment_status=CASE WHEN ?=\'delivered\' THEN \'paid\' ELSE payment_status END WHERE id=? AND status=?').run(next,next,id,order.status);if(next==='delivered')db.prepare("UPDATE delivery_assignments SET status='delivered',delivered_at=CURRENT_TIMESTAMP WHERE order_id=?").run(id);recordOrderStatus(id,order.status,next,req.user,'Simulación administrativa');})();audit(req,'demo_order_advanced','order',id);res.json({ok:true,status:next});});
app.get('/api/admin/demo',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT o.id,o.status,o.total,o.created_at,r.name restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.is_demo=1 ORDER BY o.id DESC").all()));
app.get('/api/admin/unanswered-orders',auth,role(['admin']),(req,res)=>res.json(db.prepare("SELECT o.id,o.created_at,o.total,r.name restaurant_name,u.name customer_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id JOIN users u ON u.id=o.customer_id WHERE o.status='received' AND o.is_demo=0 AND datetime(o.created_at,'+' || ? || ' minutes')<=CURRENT_TIMESTAMP ORDER BY o.created_at").all(ORDER_RESPONSE_MINUTES)));
app.delete('/api/admin/demo',auth,role(['admin']),(req,res)=>{const ids=db.prepare('SELECT id FROM orders WHERE is_demo=1').all().map(x=>x.id);const removed=db.transaction(()=>{for(const id of ids){db.prepare('DELETE FROM order_issues WHERE order_id=?').run(id);db.prepare('DELETE FROM order_reviews WHERE order_id=?').run(id);db.prepare('DELETE FROM delivery_assignments WHERE order_id=?').run(id);db.prepare('DELETE FROM order_status_history WHERE order_id=?').run(id);db.prepare('DELETE FROM orders WHERE id=? AND is_demo=1').run(id);}return ids.length;})();audit(req,'demo_orders_reset','order',null);res.json({ok:true,removed});});
app.get('/api/restaurants',(req,res)=>{const registrados=db.prepare(`SELECT r.id,r.name,r.description,r.address,r.phone,r.image,r.category,r.priority,r.featured,r.operational_status,r.prep_minutes,r.special_hours,
    ROUND(AVG(rv.restaurant_rating),1) AS rating,COUNT(rv.id) AS ratingCount,
    'registered' AS listingType,'Verificado' AS verificationStatus,NULL AS sourceUrl
    FROM restaurants r LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id WHERE r.active=1
    GROUP BY r.id`).all();const directorio=db.prepare("SELECT 'directory-' || id AS id,name,description,address,phone,NULL AS image,category,priority,featured,NULL AS rating,0 AS ratingCount,'directory' AS listingType,verification_status AS verificationStatus,source_url AS sourceUrl FROM directory_entries WHERE active=1").all();res.json([...registrados,...directorio].sort((a,b)=>Number(b.featured)-Number(a.featured)||Number(b.priority)-Number(a.priority)||(Number(b.rating)||0)-(Number(a.rating)||0)||a.name.localeCompare(b.name,'es')))});
app.get('/api/restaurants/:id/menu',(req,res)=>{const id=String(req.params.id);if(id.startsWith('directory-')){const directoryId=Number(id.replace('directory-',''));const r=db.prepare('SELECT id,name,category,description,address,phone,hours,source_url,verification_status FROM directory_entries WHERE id=? AND active=1').get(directoryId);if(!r)return res.status(404).json({error:'No encontrado'});return res.json({restaurant:{...r,id,listingType:'directory',sourceUrl:r.source_url,verificationStatus:r.verification_status},products:[]})}let r=db.prepare(`SELECT r.id,r.name,r.category,r.description,r.address,r.phone,r.image,r.operational_status,r.prep_minutes,r.special_hours,ROUND(AVG(rv.restaurant_rating),1) rating,COUNT(rv.id) ratingCount FROM restaurants r LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id WHERE r.id=? AND r.active=1 GROUP BY r.id`).get(req.params.id);if(!r)return res.status(404).json({error:'No encontrado'});res.json({restaurant:{...r,estimatedPrepMinutes:Number(r.prep_minutes)+(r.operational_status==='saturated'?20:0),listingType:'registered',verificationStatus:'Verificado'},products:db.prepare('SELECT * FROM products WHERE restaurant_id=? AND available=1').all(r.id)})});
const distanceKm=(lat1,lng1,lat2,lng2)=>{const rad=Math.PI/180;const a=Math.sin((lat2-lat1)*rad/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};
const deliveryQuote=(restaurant,lat,lng)=>{
    if(restaurant.latitude===null||restaurant.latitude===undefined||restaurant.longitude===null||restaurant.longitude===undefined||!Number.isFinite(Number(restaurant.latitude))||!Number.isFinite(Number(restaurant.longitude))){return {distanceKm:null,deliveryFee:35,zoneName:'Tarifa base provisional'};}
    const distance=Math.round(distanceKm(Number(restaurant.latitude),Number(restaurant.longitude),lat,lng)*100)/100;
    const zone=db.prepare('SELECT * FROM delivery_zones WHERE available=1 AND ? >= min_distance_km AND ? <= max_distance_km ORDER BY priority DESC,max_distance_km LIMIT 1').get(distance,distance);
    if(!zone)return {distanceKm:distance,unavailable:true};
    return {distanceKm:distance,deliveryFee:Math.round((Number(zone.base_fee)+Math.max(0,distance-Number(zone.min_distance_km))*Number(zone.surcharge_per_km))*100)/100,zoneName:zone.name,minimumOrder:Number(zone.minimum_order)};
};

app.post('/api/delivery-quote',auth,role(['customer']),rateLimit('quote',60,60*1000),(req,res)=>{
    const lat=Number(req.body.deliveryLatitude),lng=Number(req.body.deliveryLongitude);
    const restaurant=db.prepare('SELECT id,latitude,longitude FROM restaurants WHERE id=? AND active=1').get(req.body.restaurantId);
    if(!restaurant||!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)return res.status(400).json({error:'Datos de entrega inválidos'});
    const quote=deliveryQuote(restaurant,lat,lng);if(quote.unavailable)return res.status(409).json({error:'La entrega no está disponible para esa ubicación',...quote});res.json(quote);
});

app.post('/api/orders',auth,role(['customer']),rateLimit('orders',12,10*60*1000),(req,res)=>{
    const {restaurantId,items,address,deliveryLatitude,deliveryLongitude,clientRequestId}=req.body;
    const paymentMethod=String(req.body.paymentMethod||'Efectivo');
    const allowedPayments=['Efectivo','Transferencia','Tarjeta al recibir'];
    if(!restaurantId||!Array.isArray(items)||!items.length||items.length>50||!String(address||'').trim()||!allowedPayments.includes(paymentMethod))return res.status(400).json({error:'Datos del pedido inválidos'});
    if(!/^[a-zA-Z0-9-]{16,80}$/.test(String(clientRequestId||'')))return res.status(400).json({error:'Identificador de pedido inválido'});
    const existing=db.prepare('SELECT id,total,subtotal,delivery_fee,distance_km,payment_status FROM orders WHERE customer_id=? AND client_request_id=?').get(req.user.id,clientRequestId);
    if(existing)return res.json({orderId:existing.id,total:existing.total,subtotal:existing.subtotal,deliveryFee:existing.delivery_fee,distanceKm:existing.distance_km,paymentStatus:existing.payment_status,repeated:true});
    const lat=Number(deliveryLatitude),lng=Number(deliveryLongitude);
    if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)return res.status(400).json({error:'Selecciona una ubicación válida para la entrega'});
    const restaurant=db.prepare('SELECT id,latitude,longitude,operational_status,prep_minutes FROM restaurants WHERE id=? AND active=1').get(restaurantId);
    if(!restaurant)return res.status(404).json({error:'Restaurante no disponible'});
    if(['closed','paused'].includes(restaurant.operational_status))return res.status(409).json({error:restaurant.operational_status==='paused'?'El restaurante pausó temporalmente los pedidos':'El restaurante está cerrado'});
    const getProduct=db.prepare('SELECT id,name,price,available FROM products WHERE id=? AND restaurant_id=?');
    const normalized=[];let subtotal=0;
    for(const item of items){const product=getProduct.get(item.productId,restaurantId);const quantity=Number(item.quantity);if(!product||!product.available||!Number.isInteger(quantity)||quantity<1||quantity>30)return res.status(400).json({error:'Producto o cantidad inválida'});subtotal+=Number(product.price)*quantity;normalized.push({...product,quantity});}
    subtotal=Math.round(subtotal*100)/100;
    const quote=deliveryQuote(restaurant,lat,lng);
    if(quote.unavailable)return res.status(409).json({error:'La entrega no está disponible para esa ubicación'});
    if(subtotal<Number(quote.minimumOrder||0))return res.status(409).json({error:'El pedido mínimo para '+quote.zoneName+' es de $'+Number(quote.minimumOrder).toFixed(2)});
    const total=Math.round((subtotal+quote.deliveryFee)*100)/100;
    const paymentStatus=paymentMethod==='Transferencia'?'awaiting_confirmation':'pay_on_delivery';
    const estimatedPrepMinutes=Math.min(180,Math.max(5,Number(restaurant.prep_minutes)||30)+(restaurant.operational_status==='saturated'?20:0));
    const orderId=db.transaction(()=>{const order=db.prepare('INSERT INTO orders(customer_id,restaurant_id,address,payment_method,total,delivery_latitude,delivery_longitude,subtotal,delivery_fee,distance_km,payment_status,client_request_id,estimated_prep_minutes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(req.user.id,restaurantId,String(address).trim().slice(0,500),paymentMethod,total,lat,lng,subtotal,quote.deliveryFee,quote.distanceKm,paymentStatus,clientRequestId,estimatedPrepMinutes);const id=Number(order.lastInsertRowid),commission=Math.round(subtotal*PLATFORM_COMMISSION_PERCENT)/100;const insert=db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,?)');normalized.forEach(item=>insert.run(id,item.id,item.name,item.price,item.quantity));db.prepare('INSERT INTO order_financials(order_id,subtotal,delivery_fee,platform_commission,tip,discount,total_charged,payment_method,payment_status,restaurant_due,courier_due) VALUES(?,?,?,?,0,0,?,?,?,?,?)').run(id,subtotal,quote.deliveryFee,commission,total,paymentMethod,paymentStatus,subtotal-commission,quote.deliveryFee);recordOrderStatus(id,null,'received',req.user,'Pedido creado por el cliente');return id;})();
    audit(req,'order_created','order',orderId);
    res.status(201).json({orderId,total,subtotal,deliveryFee:quote.deliveryFee,distanceKm:quote.distanceKm,zoneName:quote.zoneName,paymentStatus,estimatedPrepMinutes});
});
app.get('/api/orders/my',auth,role(['customer']),(req,res)=>{let os=db.prepare(`SELECT o.*,r.name restaurant_name,rv.restaurant_rating,rv.delivery_rating,rv.comment review_comment,rv.tip_amount,rv.tip_method FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN order_reviews rv ON rv.order_id=o.id WHERE o.customer_id=? ORDER BY o.id DESC`).all(req.user.id);let it=db.prepare('SELECT * FROM order_items WHERE order_id=?');res.json(os.map(o=>({...o,responseDeadline:o.status==='received'?new Date(new Date(o.created_at+'Z').getTime()+ORDER_RESPONSE_MINUTES*60000).toISOString():null,items:it.all(o.id)})))});
app.post('/api/orders/:id/cancel-no-response',auth,role(['customer']),(req,res)=>{const id=Number(req.params.id),order=db.prepare('SELECT id,status,created_at FROM orders WHERE id=? AND customer_id=?').get(id,req.user.id);if(!order)return res.status(404).json({error:'Pedido no encontrado'});if(order.status!=='received')return res.status(409).json({error:'El restaurante ya respondió o el pedido ya fue cerrado'});if(Date.now()-new Date(order.created_at+'Z').getTime()<ORDER_RESPONSE_MINUTES*60000)return res.status(409).json({error:'El tiempo de respuesta todavía no termina'});const changed=db.transaction(()=>{const result=db.prepare("UPDATE orders SET status='cancelled',payment_status=CASE WHEN payment_status='awaiting_confirmation' THEN 'cancelled' ELSE payment_status END WHERE id=? AND status='received'").run(id);if(result.changes===1)recordOrderStatus(id,'received','cancelled',req.user,'Cancelación sin penalización por falta de respuesta');return result;})();if(changed.changes!==1)return res.status(409).json({error:'El pedido cambió; actualiza la pantalla'});audit(req,'order_cancelled_no_response','order',id);res.json({ok:true,status:'cancelled'});});
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
            'SELECT id,name,email,phone,role,google_id,account_status FROM users WHERE google_id=?'
        ).get(googleId);

        if(!user){
            user=db.prepare(
                'SELECT id,name,email,phone,role,google_id,account_status FROM users WHERE email=?'
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
                VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,'2026-09-02')
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

        const token=signToken(sessionUser);

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
app.get('/api/restaurant/me',auth,restaurantAccess(),(req,res)=>{const r=req.restaurant,products=db.prepare('SELECT * FROM products WHERE restaurant_id=?').all(r.id),orders=db.prepare("SELECT o.*,u.name customer_name,u.phone customer_phone,EXISTS(SELECT 1 FROM delivery_assignments da WHERE da.order_id=o.id AND da.status='accepted') AS delivery_assigned FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.restaurant_id=? ORDER BY o.id DESC").all(r.id),it=db.prepare('SELECT * FROM order_items WHERE order_id=?');const access={isOwner:Boolean(r.is_owner),canManageOrders:Boolean(r.can_manage_orders),canManageProducts:Boolean(r.can_manage_products),canViewFinance:Boolean(r.can_view_finance)};res.json({...r,access,products:access.canManageProducts||access.isOwner?products:[],orders:access.canManageOrders?orders.map(o=>{const closed=['delivered','cancelled'].includes(o.status);return {...o,customer_phone:closed?null:o.customer_phone,address:closed?'Datos ocultos al cerrar el pedido':o.address,delivery_latitude:closed?null:o.delivery_latitude,delivery_longitude:closed?null:o.delivery_longitude,items:it.all(o.id)}}):[]})});
app.get('/api/restaurant/settlement',auth,restaurantAccess('can_view_finance'),(req,res)=>{const rows=db.prepare(`SELECT date(o.created_at) day,COUNT(*) orders_count,ROUND(SUM(f.subtotal),2) sales,ROUND(SUM(f.platform_commission),2) commission,ROUND(SUM(CASE WHEN f.payment_method='Efectivo' THEN f.total_charged ELSE 0 END),2) cash_orders,ROUND(SUM(CASE WHEN f.payment_method!='Efectivo' THEN f.total_charged ELSE 0 END),2) digital_orders,ROUND(SUM(f.restaurant_due),2) restaurant_due,ROUND(SUM(CASE WHEN o.status='cancelled' THEN 1 ELSE 0 END),0) cancellations FROM orders o JOIN order_financials f ON f.order_id=o.id WHERE o.restaurant_id=? AND o.is_demo=0 GROUP BY date(o.created_at) ORDER BY day DESC LIMIT 60`).all(req.restaurant.id);res.json({commissionPercent:PLATFORM_COMMISSION_PERCENT,days:rows});});

app.get('/api/restaurant/employees',auth,restaurantAccess(),restaurantOwner,(req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.account_status,m.can_manage_orders,m.can_manage_products,m.can_view_finance,m.active,m.created_at FROM restaurant_members m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? ORDER BY m.created_at DESC`).all(req.restaurant.id)));
app.post('/api/restaurant/employees',auth,restaurantAccess(),restaurantOwner,rateLimit('restaurant-employees',12,60*60*1000),async(req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),phone=String(req.body.phone||'').trim().slice(0,30),password=String(req.body.password||'');if(!name||!email||password.length<10)return res.status(400).json({error:'Completa nombre, correo y una contraseña de al menos 10 caracteres'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'Ese correo ya pertenece a otra cuenta'});const id=db.transaction(()=>{const created=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status,email_verified) VALUES(?,?,?,?, 'restaurant_employee','approved',0)").run(name,email,phone,bcrypt.hashSync(password,12));db.prepare('INSERT INTO restaurant_members(user_id,restaurant_id,can_manage_orders,can_manage_products,can_view_finance) VALUES(?,?,?,?,?)').run(created.lastInsertRowid,req.restaurant.id,req.body.canManageOrders===false?0:1,req.body.canManageProducts?1:0,req.body.canViewFinance?1:0);return Number(created.lastInsertRowid)})();audit(req,'restaurant_employee_created','user',id);res.status(201).json({id});});
app.patch('/api/restaurant/employees/:id',auth,restaurantAccess(),restaurantOwner,(req,res)=>{const id=Number(req.params.id),active=req.body.active===false?0:1;const result=db.prepare('UPDATE restaurant_members SET can_manage_orders=?,can_manage_products=?,can_view_finance=?,active=? WHERE user_id=? AND restaurant_id=?').run(req.body.canManageOrders?1:0,req.body.canManageProducts?1:0,req.body.canViewFinance?1:0,active,id,req.restaurant.id);if(result.changes!==1)return res.status(404).json({error:'Empleado no encontrado'});db.prepare("UPDATE users SET account_status=? WHERE id=? AND role='restaurant_employee'").run(active?'approved':'suspended',id);audit(req,'restaurant_employee_permissions_updated','user',id);res.json({ok:true});});

app.post('/api/restaurant/uploads',auth,restaurantAccess('can_manage_products'),(req,res)=>{
    const match=String(req.body.dataUrl||'').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if(!match)return res.status(400).json({error:'Selecciona una imagen JPG, PNG o WEBP'});
    const buffer=Buffer.from(match[2],'base64');
    if(!buffer.length||buffer.length>4*1024*1024)return res.status(400).json({error:'La imagen debe pesar menos de 4 MB'});
    const validMagic=(match[1]==='jpeg'&&buffer[0]===0xff&&buffer[1]===0xd8)||(match[1]==='png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(match[1]==='webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP');
    if(!validMagic)return res.status(400).json({error:'El archivo no contiene una imagen válida'});
    const extension=match[1]==='jpeg'?'jpg':match[1];
    const fileName=`restaurant-${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${extension}`;
    fs.writeFileSync(path.join(uploadsDir,fileName),buffer);
    res.status(201).json({url:'/uploads/'+fileName});
});

app.put('/api/restaurant/profile',auth,restaurantAccess(),restaurantOwner,(req,res)=>{
    const image=String(req.body.image||'').trim();
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    db.prepare('UPDATE restaurants SET image=? WHERE id=?').run(image,req.restaurant.id);
    res.json({ok:true,image});
});
app.put('/api/restaurant/availability',auth,restaurantAccess(),restaurantOwner,(req,res)=>{
    const status=String(req.body.status||''),prepMinutes=Number(req.body.prepMinutes),specialHours=String(req.body.specialHours||'').trim().slice(0,300);
    if(!['open','closed','saturated','paused'].includes(status)||!Number.isInteger(prepMinutes)||prepMinutes<5||prepMinutes>180)return res.status(400).json({error:'Selecciona un estado y un tiempo entre 5 y 180 minutos'});
    const result=db.prepare('UPDATE restaurants SET operational_status=?,prep_minutes=?,special_hours=? WHERE id=?').run(status,prepMinutes,specialHours,req.restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Restaurante no encontrado'});
    audit(req,'restaurant_availability_updated','restaurant',null);res.json({ok:true,status,prepMinutes,estimatedPrepMinutes:prepMinutes+(status==='saturated'?20:0),specialHours});
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
    if(!name||name.length>100||!Number.isFinite(price)||price<=0){
        return res.status(400).json({error:'Escribe un nombre y un precio mayor que cero'});
    }
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    const result=db.prepare('INSERT INTO products(restaurant_id,name,description,price,image,available) VALUES(?,?,?,?,?,1)')
        .run(restaurant.id,name,description,price,image);
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});

app.put('/api/restaurant/products/:id',auth,restaurantAccess('can_manage_products'),(req,res)=>{
    const restaurant=req.restaurant;
    const name=String(req.body.name||'').trim();
    const description=String(req.body.description||'').trim();
    const image=String(req.body.image||'').trim();
    const price=Number(req.body.price);
    if(!name||name.length>100||!Number.isFinite(price)||price<=0){
        return res.status(400).json({error:'Datos del producto inválidos'});
    }
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    const result=db.prepare('UPDATE products SET name=?,description=?,price=?,image=? WHERE id=? AND restaurant_id=?')
        .run(name,description,price,image,req.params.id,restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Producto no encontrado'});
    res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

app.patch('/api/restaurant/products/:id',auth,restaurantAccess('can_manage_products'),(req,res)=>{
    const restaurant=req.restaurant;
    const result=db.prepare('UPDATE products SET available=? WHERE id=? AND restaurant_id=?')
        .run(req.body.available?1:0,req.params.id,restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Producto no encontrado'});
    res.json({ok:true});
});
app.patch('/api/restaurant/orders/:id',auth,restaurantAccess('can_manage_orders'),(req,res)=>{
    const restaurant=req.restaurant;
    const order=db.prepare('SELECT id,status FROM orders WHERE id=? AND restaurant_id=?')
        .get(req.params.id,restaurant.id);
    if(!order) return res.status(404).json({error:'Pedido no encontrado'});

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

    const result=db.transaction(()=>{const changed=db.prepare('UPDATE orders SET status=? WHERE id=? AND restaurant_id=? AND status=?').run(req.body.status,order.id,restaurant.id,order.status);if(changed.changes===1)recordOrderStatus(order.id,order.status,req.body.status,req.user);return changed;})();
    if(result.changes!==1) return res.status(409).json({error:'El pedido cambió; actualiza el panel'});
    audit(req,'restaurant_order_'+req.body.status,'order',order.id);
    res.json({ok:true,status:req.body.status});
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
    db.prepare("INSERT INTO delivery_profiles(delivery_user_id,status,updated_at) VALUES(?,'available',CURRENT_TIMESTAMP) ON CONFLICT(delivery_user_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP").run(req.user.id);
    res.json({ok:true});
});
app.put('/api/delivery/availability',auth,role(['delivery']),(req,res)=>{const status=String(req.body.status||'');if(!['available','offline'].includes(status))return res.status(400).json({error:'Estado inválido'});const active=db.prepare("SELECT da.order_id FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering')").get(req.user.id);if(active&&status==='offline')return res.status(409).json({error:'Termina tu entrega activa antes de desconectarte'});db.prepare('INSERT INTO delivery_profiles(delivery_user_id,status,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(delivery_user_id) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP').run(req.user.id,status);res.json({ok:true,status});});
app.get('/api/delivery/availability',auth,role(['delivery']),(req,res)=>res.json(db.prepare("SELECT COALESCE((SELECT status FROM delivery_profiles WHERE delivery_user_id=?),'offline') status").get(req.user.id)));

app.get('/api/delivery/orders/available',auth,role(['delivery']),(req,res)=>{

    const pedidos = db.prepare(`
        SELECT
            o.*,
            r.name AS restaurant_name,
            r.address AS restaurant_address,
            r.phone AS restaurant_phone,
            r.latitude AS restaurant_latitude,
            r.longitude AS restaurant_longitude,
            u.name AS customer_name,
            u.phone AS customer_phone
        FROM orders o
        JOIN restaurants r
            ON r.id = o.restaurant_id
        JOIN users u
            ON u.id = o.customer_id
        LEFT JOIN delivery_assignments da
            ON da.order_id = o.id
        WHERE o.status = 'ready'
        AND COALESCE((SELECT status FROM delivery_profiles WHERE delivery_user_id=?),'offline')='available'
        AND NOT EXISTS(SELECT 1 FROM delivery_rejections dr WHERE dr.order_id=o.id AND dr.delivery_user_id=?)
        AND (
            da.id IS NULL
            OR da.status = 'available'
        )
        ORDER BY o.id ASC
    `).all(req.user.id,req.user.id);

    const items = db.prepare(`
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `);

    const deliveryLocation=db.prepare('SELECT latitude,longitude,updated_at FROM delivery_locations WHERE delivery_user_id=?').get(req.user.id);
    const result=pedidos.map(p => ({
            ...p,
            items: items.all(p.id),
            distance_to_restaurant_km:deliveryLocation&&p.restaurant_latitude!=null&&p.restaurant_longitude!=null
                ? Math.round(distanceKm(Number(deliveryLocation.latitude),Number(deliveryLocation.longitude),Number(p.restaurant_latitude),Number(p.restaurant_longitude))*100)/100
                : null
        })).sort((a,b)=>(a.distance_to_restaurant_km??Number.MAX_VALUE)-(b.distance_to_restaurant_km??Number.MAX_VALUE)||a.id-b.id);
    res.json({locationReady:Boolean(deliveryLocation),orders:result});

});


app.post('/api/delivery/orders/:id/accept',auth,role(['delivery']),(req,res)=>{

    const orderId = Number(req.params.id);

    if(!Number.isInteger(orderId) || orderId <= 0){
        return res.status(400).json({
            error:'Pedido inválido'
        });
    }

    try{

        const resultado = db.transaction(()=>{
            const profile=db.prepare("SELECT status FROM delivery_profiles WHERE delivery_user_id=?").get(req.user.id);if(!profile||profile.status!=='available')throw new Error('Activa tu disponibilidad antes de aceptar pedidos');

            const active=db.prepare("SELECT da.order_id FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('assigned','delivering') AND da.order_id<>?").get(req.user.id,orderId);
            if(active)throw new Error('Termina tu entrega activa antes de aceptar otra');

            const pedido = db.prepare(`
                SELECT id,status
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
        SELECT id,status
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
        if(!/^\d{4}$/.test(String(req.body.deliveryPin||''))||String(req.body.deliveryPin)!==deliveryPinFor(orderId))return res.status(403).json({error:'El código de entrega es incorrecto'});

        const resultado=db.transaction(()=>{

            const cambioAsignacion=db.prepare(`
                UPDATE delivery_assignments
                SET
                    status='delivered',
                    delivered_at=CURRENT_TIMESTAMP
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

            recordOrderStatus(orderId,'delivering','delivered',req.user,'PIN del cliente validado');
            db.prepare("UPDATE delivery_profiles SET status='available',updated_at=CURRENT_TIMESTAMP WHERE delivery_user_id=?").run(req.user.id);

            return true;
        })();

        db.prepare("UPDATE order_financials SET payment_status=CASE WHEN payment_status='pay_on_delivery' THEN 'paid' ELSE payment_status END,updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);audit(req,'order_delivered','order',orderId);
        return res.json({
            ok:resultado,
            message:'Pedido entregado correctamente'
        });
    }
});
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

app.get('/api/orders/:id/tracking',auth,role(['customer']),(req,res)=>{
    const orderId=Number(req.params.id);
    if(!Number.isInteger(orderId)||orderId<=0){
        return res.status(400).json({error:'Pedido inválido'});
    }

    const tracking=db.prepare(`
        SELECT o.id,o.status,o.address,o.created_at,o.delivery_latitude,o.delivery_longitude,
               r.name AS restaurant_name,r.address AS restaurant_address,
               u.name AS delivery_name,u.phone AS delivery_phone,
               da.latitude,da.longitude,da.location_accuracy,
               da.location_updated_at,da.accepted_at,da.delivered_at,
               rv.restaurant_rating,rv.delivery_rating,rv.comment AS review_comment,rv.tip_amount
        FROM orders o
        JOIN restaurants r ON r.id=o.restaurant_id
        LEFT JOIN delivery_assignments da ON da.order_id=o.id
        LEFT JOIN users u ON u.id=da.delivery_user_id
        LEFT JOIN order_reviews rv ON rv.order_id=o.id
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
    tracking.delivery_pin=['assigned','delivering'].includes(tracking.status)?deliveryPinFor(orderId):null;
    tracking.history=db.prepare('SELECT from_status,to_status,actor_role,note,created_at FROM order_status_history WHERE order_id=? ORDER BY id').all(orderId);
    res.json(tracking);
});

app.post('/api/orders/:id/review',auth,role(['customer']),rateLimit('order-review',12,60*60*1000),(req,res)=>{
    const orderId=Number(req.params.id),restaurantRating=Number(req.body.restaurantRating),deliveryRating=req.body.deliveryRating==null||req.body.deliveryRating===''?null:Number(req.body.deliveryRating),tipAmount=Math.round(Number(req.body.tipAmount||0)*100)/100,comment=String(req.body.comment||'').trim().slice(0,500);
    if(!Number.isInteger(orderId)||orderId<=0||!Number.isInteger(restaurantRating)||restaurantRating<1||restaurantRating>5||deliveryRating!==null&&(!Number.isInteger(deliveryRating)||deliveryRating<1||deliveryRating>5)||!Number.isFinite(tipAmount)||tipAmount<0||tipAmount>1000)return res.status(400).json({error:'Calificación o propina inválida'});
    const order=db.prepare(`SELECT o.id,o.restaurant_id,o.status,da.delivery_user_id FROM orders o LEFT JOIN delivery_assignments da ON da.order_id=o.id WHERE o.id=? AND o.customer_id=?`).get(orderId,req.user.id);
    if(!order)return res.status(404).json({error:'Pedido no encontrado'});
    if(order.status!=='delivered')return res.status(409).json({error:'Podrás calificar cuando el pedido haya sido entregado'});
    if(deliveryRating!==null&&!order.delivery_user_id)return res.status(400).json({error:'El pedido no tiene repartidor para calificar'});
    if(tipAmount>0&&!order.delivery_user_id)return res.status(400).json({error:'El pedido no tiene repartidor para recibir propina'});
    try{
        db.prepare(`INSERT INTO order_reviews(order_id,customer_id,restaurant_id,delivery_user_id,restaurant_rating,delivery_rating,comment,tip_amount,tip_method) VALUES(?,?,?,?,?,?,?,?, 'cash')`).run(order.id,req.user.id,order.restaurant_id,order.delivery_user_id,restaurantRating,deliveryRating,comment,tipAmount);
        db.prepare('UPDATE order_financials SET tip=?,courier_due=delivery_fee+?,updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(tipAmount,tipAmount,order.id);audit(req,'order_review_created','order',order.id);res.status(201).json({ok:true,tipAmount,tipMethod:'cash'});
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

app.get('/api/health',(req,res)=>{try{const integrity=db.pragma('quick_check',{simple:true});res.json({ok:integrity==='ok',database:integrity,aiConfigured:Boolean(OPENAI_API_KEY),time:new Date().toISOString()});}catch(error){res.status(503).json({ok:false,requestId:req.requestId});}});

const backupsDir=path.join(dataDir,'backups');
async function automaticBackup(){
    try{fs.mkdirSync(backupsDir,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const target=path.join(backupsDir,`come_sayula-${stamp}.db`);await db.backup(target);console.log('Respaldo automático verificado: '+target);}
    catch(error){console.error('BACKUP ERROR:',error.message);}
}
if(process.env.DISABLE_AUTOMATIC_BACKUP!=='1'){setTimeout(automaticBackup,5000);setInterval(automaticBackup,24*60*60*1000);}

function notifyUnansweredOrders(){try{const orders=db.prepare(`SELECT o.id,o.customer_id,r.owner_id,r.id restaurant_id,r.name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status='received' AND o.is_demo=0 AND datetime(o.created_at,'+' || ? || ' minutes')<=CURRENT_TIMESTAMP AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.order_id=o.id AND n.type='order_unanswered')`).all(ORDER_RESPONSE_MINUTES);for(const order of orders){addNotification(order.customer_id,order.id,'order_unanswered','El restaurante aún no responde','Ya puedes cancelar este pedido sin penalización.','/tracking.html?order='+order.id);addNotification(order.owner_id,order.id,'order_unanswered','Pedido esperando respuesta','El pedido #'+order.id+' necesita atención inmediata.','/restaurant.html');for(const member of db.prepare('SELECT user_id FROM restaurant_members WHERE restaurant_id=? AND active=1 AND can_manage_orders=1').all(order.restaurant_id))addNotification(member.user_id,order.id,'order_unanswered','Pedido esperando respuesta','El pedido #'+order.id+' necesita atención inmediata.','/restaurant.html');notifyAdmins(order.id,'order_unanswered','Pedido sin respuesta',order.name+' no respondió el pedido #'+order.id+'.');}}catch(e){console.error('UNANSWERED NOTIFICATION ERROR',e.message);}}
setTimeout(notifyUnansweredOrders,8000);setInterval(notifyUnansweredOrders,60*1000);

app.use((error,req,res,next)=>{console.error('REQUEST ERROR',req.requestId,error);if(res.headersSent)return next(error);res.status(500).json({error:'Ocurrió un error interno',requestId:req.requestId});});

const PORT=Number(process.env.PORT||3000);
app.listen(PORT,()=>console.log('COME SAYULA: http://localhost:'+PORT));

