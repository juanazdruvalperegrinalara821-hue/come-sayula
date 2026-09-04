(()=>{
  if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1'))navigator.serviceWorker.register('/sw.js').catch(()=>{});
  if(matchMedia('(display-mode: standalone)').matches||navigator.standalone)return;
  let promptInstalacion=null;
  const esIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
  const crearBoton=()=>{if(document.getElementById('instalarComeSayula'))return;const boton=document.createElement('button');boton.id='instalarComeSayula';boton.type='button';boton.textContent='📲 Instalar aplicación';boton.setAttribute('aria-label','Instalar COME SAYULA en este teléfono');boton.style.cssText='position:fixed;right:14px;bottom:14px;z-index:3000;border:0;border-radius:999px;padding:12px 16px;background:#3b2417;color:#fff;font-weight:bold;box-shadow:0 8px 25px #0004;cursor:pointer';boton.onclick=async()=>{if(promptInstalacion){promptInstalacion.prompt();await promptInstalacion.userChoice;promptInstalacion=null;boton.remove();return;}if(esIOS)alert('Para instalar en iPhone:\n1. Toca el botón Compartir de Safari.\n2. Elige “Agregar a inicio”.\n3. Confirma “Agregar”.');else alert('Abre el menú del navegador y elige “Instalar aplicación” o “Agregar a pantalla principal”.');};document.body.appendChild(boton);};
  addEventListener('beforeinstallprompt',event=>{event.preventDefault();promptInstalacion=event;crearBoton();});
  addEventListener('appinstalled',()=>document.getElementById('instalarComeSayula')?.remove());
  addEventListener('load',()=>{if(esIOS||location.search.includes('mostrarInstalacion=1'))crearBoton();});
})();
