const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const fs=require("fs");
const crypto=require("crypto");
const db=require("./database");
const {OAuth2Client}=require("google-auth-library");

const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||"846821366103-clbjraiah8qvdb5gia3op8h8rsu4c8ba.apps.googleusercontent.com";
const googleClient=new OAuth2Client(GOOGLE_CLIENT_ID);
const OPENAI_API_KEY=String(process.env.OPENAI_API_KEY||'').trim();
const OPENAI_MODEL=String(process.env.OPENAI_MODEL||'gpt-5-mini').trim();
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
const audit=(req,action,type,id)=>{try{db.prepare('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,ip_address) VALUES(?,?,?,?,?)').run(req.user?.id||null,action,type||null,id||null,String(req.ip||'').slice(0,64));}catch(e){console.error('AUDIT ERROR',e.message);}};

function aiContextFor(user){
    if(user.role==='customer'){
        const restaurants=db.prepare("SELECT id,name,description,address FROM restaurants WHERE active=1 ORDER BY name LIMIT 30").all();
        const products=db.prepare("SELECT p.id,p.name,p.description,p.price,r.name restaurant FROM products p JOIN restaurants r ON r.id=p.restaurant_id WHERE p.available=1 AND r.active=1 ORDER BY r.name,p.name LIMIT 100").all();
        const orders=db.prepare("SELECT id,status,payment_method,payment_status,total,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 8").all(user.id);
        return {restaurants,products,myRecentOrders:orders};
    }
    if(user.role==='restaurant'){
        const restaurant=db.prepare('SELECT id,name,description,address,active,latitude,longitude FROM restaurants WHERE owner_id=?').get(user.id);
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
    if(selectedRole&&user.role!==selectedRole){
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

app.get('/api/admin/users',auth,role(['admin']),(req,res)=>{
    res.json(db.prepare("SELECT id,name,email,phone,role,account_status,email_verified,phone_verified,created_at FROM users WHERE role IN ('restaurant','delivery') ORDER BY id DESC").all());
});
app.post('/api/admin/users',auth,role(['admin']),rateLimit('admin-create-user',30,60*60*1000),async(req,res)=>{
    try{
        const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),phone=String(req.body.phone||'').trim().slice(0,30),password=String(req.body.password||''),newRole=String(req.body.role||'');
        if(!name||!email||password.length<10||!['restaurant','delivery'].includes(newRole))return res.status(400).json({error:'Completa los datos; la contraseña temporal debe tener al menos 10 caracteres'});
        const result=db.transaction(()=>{const created=db.prepare("INSERT INTO users(name,email,phone,password_hash,role,account_status) VALUES(?,?,?,?,?,'pending')").run(name,email,phone,bcrypt.hashSync(password,12),newRole);if(newRole==='restaurant')db.prepare("INSERT INTO restaurants(owner_id,name,description,address,phone,active) VALUES(?,?,'Nuevo restaurante en COME SAYULA','Sayula, Jalisco',?,0)").run(created.lastInsertRowid,name,phone);return created;})();
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
app.get('/api/restaurants',(req,res)=>{const registrados=db.prepare(`SELECT r.id,r.name,r.description,r.address,r.phone,r.image,r.category,r.priority,r.featured,
    ROUND(AVG(rv.restaurant_rating),1) AS rating,COUNT(rv.id) AS ratingCount,
    'registered' AS listingType,'Verificado' AS verificationStatus,NULL AS sourceUrl
    FROM restaurants r LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id WHERE r.active=1
    GROUP BY r.id`).all();const directorio=db.prepare("SELECT 'directory-' || id AS id,name,description,address,phone,NULL AS image,category,priority,featured,NULL AS rating,0 AS ratingCount,'directory' AS listingType,verification_status AS verificationStatus,source_url AS sourceUrl FROM directory_entries WHERE active=1").all();res.json([...registrados,...directorio].sort((a,b)=>Number(b.featured)-Number(a.featured)||Number(b.priority)-Number(a.priority)||(Number(b.rating)||0)-(Number(a.rating)||0)||a.name.localeCompare(b.name,'es')))});
app.get('/api/restaurants/:id/menu',(req,res)=>{const id=String(req.params.id);if(id.startsWith('directory-')){const directoryId=Number(id.replace('directory-',''));const r=db.prepare('SELECT id,name,category,description,address,phone,hours,source_url,verification_status FROM directory_entries WHERE id=? AND active=1').get(directoryId);if(!r)return res.status(404).json({error:'No encontrado'});return res.json({restaurant:{...r,id,listingType:'directory',sourceUrl:r.source_url,verificationStatus:r.verification_status},products:[]})}let r=db.prepare(`SELECT r.id,r.name,r.category,r.description,r.address,r.phone,r.image,ROUND(AVG(rv.restaurant_rating),1) rating,COUNT(rv.id) ratingCount FROM restaurants r LEFT JOIN order_reviews rv ON rv.restaurant_id=r.id WHERE r.id=? AND r.active=1 GROUP BY r.id`).get(req.params.id);if(!r)return res.status(404).json({error:'No encontrado'});res.json({restaurant:{...r,listingType:'registered',verificationStatus:'Verificado'},products:db.prepare('SELECT * FROM products WHERE restaurant_id=? AND available=1').all(r.id)})});
const distanceKm=(lat1,lng1,lat2,lng2)=>{const rad=Math.PI/180;const a=Math.sin((lat2-lat1)*rad/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};
const deliveryQuote=(restaurant,lat,lng)=>{
    if(restaurant.latitude===null||restaurant.latitude===undefined||restaurant.longitude===null||restaurant.longitude===undefined||!Number.isFinite(Number(restaurant.latitude))||!Number.isFinite(Number(restaurant.longitude))){return {distanceKm:null,deliveryFee:35};}
    const distance=Math.round(distanceKm(Number(restaurant.latitude),Number(restaurant.longitude),lat,lng)*100)/100;
    return {distanceKm:distance,deliveryFee:Math.round((35+Math.max(0,distance-3)*6)*100)/100};
};

app.post('/api/delivery-quote',auth,role(['customer']),rateLimit('quote',60,60*1000),(req,res)=>{
    const lat=Number(req.body.deliveryLatitude),lng=Number(req.body.deliveryLongitude);
    const restaurant=db.prepare('SELECT id,latitude,longitude FROM restaurants WHERE id=? AND active=1').get(req.body.restaurantId);
    if(!restaurant||!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)return res.status(400).json({error:'Datos de entrega inválidos'});
    res.json(deliveryQuote(restaurant,lat,lng));
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
    const restaurant=db.prepare('SELECT id,latitude,longitude FROM restaurants WHERE id=? AND active=1').get(restaurantId);
    if(!restaurant)return res.status(404).json({error:'Restaurante no disponible'});
    const getProduct=db.prepare('SELECT id,name,price,available FROM products WHERE id=? AND restaurant_id=?');
    const normalized=[];let subtotal=0;
    for(const item of items){const product=getProduct.get(item.productId,restaurantId);const quantity=Number(item.quantity);if(!product||!product.available||!Number.isInteger(quantity)||quantity<1||quantity>30)return res.status(400).json({error:'Producto o cantidad inválida'});subtotal+=Number(product.price)*quantity;normalized.push({...product,quantity});}
    subtotal=Math.round(subtotal*100)/100;
    const quote=deliveryQuote(restaurant,lat,lng);
    const total=Math.round((subtotal+quote.deliveryFee)*100)/100;
    const paymentStatus=paymentMethod==='Transferencia'?'awaiting_confirmation':'pay_on_delivery';
    const orderId=db.transaction(()=>{const order=db.prepare('INSERT INTO orders(customer_id,restaurant_id,address,payment_method,total,delivery_latitude,delivery_longitude,subtotal,delivery_fee,distance_km,payment_status,client_request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(req.user.id,restaurantId,String(address).trim().slice(0,500),paymentMethod,total,lat,lng,subtotal,quote.deliveryFee,quote.distanceKm,paymentStatus,clientRequestId);const insert=db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,?)');normalized.forEach(item=>insert.run(order.lastInsertRowid,item.id,item.name,item.price,item.quantity));return Number(order.lastInsertRowid);})();
    audit(req,'order_created','order',orderId);
    res.status(201).json({orderId,total,subtotal,deliveryFee:quote.deliveryFee,distanceKm:quote.distanceKm,paymentStatus});
});
app.get('/api/orders/my',auth,role(['customer']),(req,res)=>{let os=db.prepare(`SELECT o.*,r.name restaurant_name,rv.restaurant_rating,rv.delivery_rating,rv.comment review_comment,rv.tip_amount,rv.tip_method FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN order_reviews rv ON rv.order_id=o.id WHERE o.customer_id=? ORDER BY o.id DESC`).all(req.user.id);let it=db.prepare('SELECT * FROM order_items WHERE order_id=?');res.json(os.map(o=>({...o,items:it.all(o.id)})))});
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
app.get('/api/restaurant/me',auth,role(['restaurant']),(req,res)=>{let r=db.prepare('SELECT * FROM restaurants WHERE owner_id=?').get(req.user.id);let products=db.prepare('SELECT * FROM products WHERE restaurant_id=?').all(r.id);let orders=db.prepare("SELECT o.*,u.name customer_name,u.phone customer_phone,EXISTS(SELECT 1 FROM delivery_assignments da WHERE da.order_id=o.id AND da.status='accepted') AS delivery_assigned FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.restaurant_id=? ORDER BY o.id DESC").all(r.id);let it=db.prepare('SELECT * FROM order_items WHERE order_id=?');res.json({...r,products,orders:orders.map(o=>({...o,items:it.all(o.id)}))})});

app.post('/api/restaurant/uploads',auth,role(['restaurant']),(req,res)=>{
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

app.put('/api/restaurant/profile',auth,role(['restaurant']),(req,res)=>{
    const image=String(req.body.image||'').trim();
    if(image&&!image.startsWith('/uploads/'))return res.status(400).json({error:'Imagen inválida'});
    db.prepare('UPDATE restaurants SET image=? WHERE owner_id=?').run(image,req.user.id);
    res.json({ok:true,image});
});

app.put('/api/restaurant/location',auth,role(['restaurant']),(req,res)=>{
    const latitude=Number(req.body.latitude),longitude=Number(req.body.longitude);
    if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180)return res.status(400).json({error:'Ubicación inválida'});
    db.prepare('UPDATE restaurants SET latitude=?,longitude=? WHERE owner_id=?').run(latitude,longitude,req.user.id);
    audit(req,'restaurant_location_updated','restaurant',null);
    res.json({ok:true,latitude,longitude});
});
app.post('/api/restaurant/products',auth,role(['restaurant']),(req,res)=>{
    const restaurant=db.prepare('SELECT id FROM restaurants WHERE owner_id=?').get(req.user.id);
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

app.put('/api/restaurant/products/:id',auth,role(['restaurant']),(req,res)=>{
    const restaurant=db.prepare('SELECT id FROM restaurants WHERE owner_id=?').get(req.user.id);
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

app.patch('/api/restaurant/products/:id',auth,role(['restaurant']),(req,res)=>{
    const restaurant=db.prepare('SELECT id FROM restaurants WHERE owner_id=?').get(req.user.id);
    const result=db.prepare('UPDATE products SET available=? WHERE id=? AND restaurant_id=?')
        .run(req.body.available?1:0,req.params.id,restaurant.id);
    if(result.changes!==1)return res.status(404).json({error:'Producto no encontrado'});
    res.json({ok:true});
});
app.patch('/api/restaurant/orders/:id',auth,role(['restaurant']),(req,res)=>{
    const restaurant=db.prepare('SELECT id FROM restaurants WHERE owner_id=?').get(req.user.id);
    const order=db.prepare('SELECT id,status FROM orders WHERE id=? AND restaurant_id=?')
        .get(req.params.id,restaurant.id);
    if(!order) return res.status(404).json({error:'Pedido no encontrado'});

    if(['delivering','delivered'].includes(order.status)){
        return res.status(409).json({
            error:'El pedido ya fue entregado al repartidor y está bloqueado'
        });
    }

    const transitions={
        received:['preparing','cancelled'],
        preparing:['ready','cancelled'],
        ready:[],
        cancelled:[]
    };
    if(!(transitions[order.status]||[]).includes(req.body.status)){
        return res.status(400).json({error:'Ese cambio de estado no está permitido'});
    }

    const result=db.prepare('UPDATE orders SET status=? WHERE id=? AND restaurant_id=? AND status=?')
        .run(req.body.status,order.id,restaurant.id,order.status);
    if(result.changes!==1) return res.status(409).json({error:'El pedido cambió; actualiza el panel'});
    audit(req,'restaurant_order_'+req.body.status,'order',order.id);
    res.json({ok:true,status:req.body.status});
});
app.patch('/api/restaurant/orders/:id/payment',auth,role(['restaurant']),(req,res)=>{
    const restaurant=db.prepare('SELECT id FROM restaurants WHERE owner_id=?').get(req.user.id);
    const order=db.prepare("SELECT id,payment_method,payment_status,status FROM orders WHERE id=? AND restaurant_id=?").get(req.params.id,restaurant.id);
    if(!order)return res.status(404).json({error:'Pedido no encontrado'});
    if(order.payment_method!=='Transferencia'||order.payment_status!=='awaiting_confirmation')return res.status(409).json({error:'Este pedido no tiene una transferencia pendiente'});
    if(['cancelled','delivered'].includes(order.status))return res.status(409).json({error:'El pedido ya está cerrado'});
    const result=db.prepare("UPDATE orders SET payment_status='confirmed' WHERE id=? AND payment_status='awaiting_confirmation'").run(order.id);
    if(result.changes!==1)return res.status(409).json({error:'El pago ya cambió; actualiza el panel'});
    audit(req,'transfer_confirmed','order',order.id);res.json({ok:true,paymentStatus:'confirmed'});
});
app.put('/api/delivery/location',auth,role(['delivery']),rateLimit('delivery-location',120,60*1000),(req,res)=>{
    const latitude=Number(req.body.latitude),longitude=Number(req.body.longitude),accuracy=Number(req.body.accuracy||0);
    if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180||!Number.isFinite(accuracy)||accuracy<0||accuracy>10000)return res.status(400).json({error:'Ubicación inválida'});
    db.prepare(`INSERT INTO delivery_locations(delivery_user_id,latitude,longitude,accuracy,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(delivery_user_id) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,accuracy=excluded.accuracy,updated_at=CURRENT_TIMESTAMP`)
        .run(req.user.id,latitude,longitude,accuracy);
    res.json({ok:true});
});

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
        AND (
            da.id IS NULL
            OR da.status = 'available'
        )
        ORDER BY o.id ASC
    `).all();

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

            const active=db.prepare("SELECT da.order_id FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.delivery_user_id=? AND da.status='accepted' AND o.status IN ('ready','delivering') AND da.order_id<>?").get(req.user.id,orderId);
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

    // El único cambio permitido es:
    // delivering → delivered
    if(nuevoEstado==='delivering'){
        if(pedido.status!=='ready'){
            return res.status(400).json({
                error:'El pedido no está listo para ser recogido'
            });
        }
        db.prepare("UPDATE orders SET status='delivering' WHERE id=? AND status='ready'").run(orderId);
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

            return true;
        })();

        audit(req,'order_delivered','order',orderId);
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
        audit(req,'order_review_created','order',order.id);res.status(201).json({ok:true,tipAmount,tipMethod:'cash'});
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

app.use((error,req,res,next)=>{console.error('REQUEST ERROR',req.requestId,error);if(res.headersSent)return next(error);res.status(500).json({error:'Ocurrió un error interno',requestId:req.requestId});});

const PORT=Number(process.env.PORT||3000);
app.listen(PORT,()=>console.log('COME SAYULA: http://localhost:'+PORT));

