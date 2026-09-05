const CACHE='come-sayula-shell-v10';
const SHELL=['/offline.html','/auth.html','/home3.html','/tracking.html','/feedback.html','/manifest.webmanifest','/pwa-install.js','/notifications.js','/feedback-launcher.js','/admin-delivery.js','/admin-finance.js','/restaurant-finance.js','/restaurant-pos.js','/ui-dialogs.js','/ui-dialogs.css','/ai-assistant.js','/ai-assistant.css','/icons/icon-192.png','/icons/icon-512.png'];
// Abre la pantalla correspondiente cuando el usuario toca una notificación.
self.addEventListener('notificationclick',event=>{event.notification.close();const url=event.notification.data?.url||'/';event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows=>{for(const client of windows){if('focus'in client){client.navigate(url);return client.focus();}}return clients.openWindow?clients.openWindow(url):null;}));});
self.addEventListener('push',event=>{let data={};try{data=event.data?.json()||{};}catch(e){data={title:'COME SAYULA',message:event.data?.text()||'Tienes un nuevo aviso.'};}event.waitUntil(self.registration.showNotification(data.title||'COME SAYULA',{body:data.message||'Tienes un nuevo aviso.',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:'cs-'+(data.id||Date.now()),data:{url:data.url||'/'}}));});
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('come-sayula-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/uploads/'))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;}).catch(async()=>await caches.match(request)||await caches.match('/offline.html')));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;})));
});

