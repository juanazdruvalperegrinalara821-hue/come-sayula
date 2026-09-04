(()=>{
    function show(message,confirmMode){
        return new Promise(resolve=>{
            const text=String(message||'');
            const success=/^[✅🎉]/.test(text),error=/^[❌⚠️]/.test(text);
            const layer=document.createElement('div');layer.className='cs-dialog-layer';
            layer.innerHTML=`<section class="cs-dialog" role="dialog" aria-modal="true"><div class="cs-dialog-icon">${success?'✅':error?'⚠️':'🍽️'}</div><h2>${confirmMode?'Confirma para continuar':success?'¡Listo!':error?'Revisa lo siguiente':'COME SAYULA'}</h2><p></p><div class="cs-dialog-actions">${confirmMode?'<button class="cs-dialog-secondary" type="button">Cancelar</button>':''}<button class="cs-dialog-primary" type="button">${confirmMode?'Confirmar':'Entendido'}</button></div></section>`;
            layer.querySelector('p').textContent=text.replace(/^[✅🎉❌⚠️]\s*/, '');
            const finish=value=>{layer.remove();resolve(value)};
            layer.querySelector('.cs-dialog-primary').onclick=()=>finish(true);
            layer.querySelector('.cs-dialog-secondary')?.addEventListener('click',()=>finish(false));
            layer.addEventListener('click',event=>{if(event.target===layer)finish(!confirmMode)});
            document.body.appendChild(layer);layer.querySelector('.cs-dialog-primary').focus();
        });
    }
    window.alert=message=>{show(message,false)};
    window.csConfirm=message=>show(message,true);
})();

