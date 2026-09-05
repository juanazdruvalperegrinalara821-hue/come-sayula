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
    window.csPrompt=(title,{label='',value='',type='text',placeholder='',required=false}={})=>new Promise(resolve=>{
        const layer=document.createElement('div');layer.className='cs-dialog-layer';
        layer.innerHTML=`<section class="cs-dialog" role="dialog" aria-modal="true"><div class="cs-dialog-icon">✍️</div><h2></h2><p></p><input class="cs-dialog-input" type="${type}" placeholder="${placeholder}" style="width:100%;box-sizing:border-box;margin-top:15px;border:1px solid #d8cbc2;border-radius:12px;padding:13px;font-size:16px"><div class="cs-dialog-actions"><button class="cs-dialog-secondary" type="button">Cancelar</button><button class="cs-dialog-primary" type="button">Continuar</button></div></section>`;
        layer.querySelector('h2').textContent=String(title||'Completa la información');layer.querySelector('p').textContent=label;const input=layer.querySelector('input');input.value=String(value??'');
        const finish=result=>{layer.remove();resolve(result)};layer.querySelector('.cs-dialog-secondary').onclick=()=>finish(null);layer.querySelector('.cs-dialog-primary').onclick=()=>{if(required&&!input.value.trim()){input.focus();return}finish(input.value)};input.addEventListener('keydown',event=>{if(event.key==='Enter')layer.querySelector('.cs-dialog-primary').click();if(event.key==='Escape')finish(null)});layer.addEventListener('click',event=>{if(event.target===layer)finish(null)});document.body.appendChild(layer);input.focus();input.select();
    });
})();

