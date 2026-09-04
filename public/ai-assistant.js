(()=>{
    const token=sessionStorage.getItem('cs_token');
    let user=null;
    try{user=JSON.parse(sessionStorage.getItem('cs_user')||'null')}catch(e){}
    if(!token||!user?.role)return;

    const examples={
        customer:['¿Qué puedo pedir con $150?','Ayúdame con mi carrito','¿Cómo va mi pedido?'],
        restaurant:['¿Qué le falta a mi menú?','Resume mis pedidos','Sugiere una promoción'],
        delivery:['Resume mis entregas','¿Qué pedido está disponible?','Ayúdame con un incidente'],
        admin:['Resume la operación','¿Hay cuentas pendientes?','Detecta posibles problemas']
    };
    const wrapper=document.createElement('div');
    wrapper.innerHTML=`<button class="cs-ai-toggle" type="button" hidden aria-label="Abrir asistente">✨ Asistente</button>
    <section class="cs-ai-panel" hidden role="dialog" aria-label="Asistente de COME SAYULA">
      <header class="cs-ai-head"><strong>✨ Asistente COME SAYULA</strong><button class="cs-ai-close" type="button" aria-label="Cerrar">×</button></header>
      <div class="cs-ai-messages" aria-live="polite"></div>
      <div class="cs-ai-suggestions"></div>
      <form class="cs-ai-form"><textarea maxlength="800" rows="2" placeholder="Escribe tu pregunta…" aria-label="Pregunta para el asistente"></textarea><button class="cs-ai-send" type="submit">Enviar</button></form>
      <div class="cs-ai-note">La IA orienta, pero no modifica pagos, cuentas ni pedidos.</div>
    </section>`;
    document.body.appendChild(wrapper);
    const toggle=wrapper.querySelector('.cs-ai-toggle'),panel=wrapper.querySelector('.cs-ai-panel'),close=wrapper.querySelector('.cs-ai-close'),messages=wrapper.querySelector('.cs-ai-messages'),form=wrapper.querySelector('form'),input=wrapper.querySelector('textarea'),send=wrapper.querySelector('.cs-ai-send'),suggestions=wrapper.querySelector('.cs-ai-suggestions');
    const add=(text,type='bot')=>{const item=document.createElement('div');item.className='cs-ai-message '+type;item.textContent=text;messages.appendChild(item);messages.scrollTop=messages.scrollHeight;return item};
    const ask=async text=>{
        text=String(text||'').trim();if(text.length<2||send.disabled)return;
        add(text,'user');input.value='';send.disabled=true;input.disabled=true;
        const pending=add('Pensando…','bot');
        try{
            const response=await fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({message:text})});
            const data=await response.json();pending.remove();
            if(!response.ok)throw new Error(data.error||'No fue posible responder');
            add(data.answer,'bot');
        }catch(error){pending.remove();add(error.message,'error')}
        finally{send.disabled=false;input.disabled=false;input.focus()}
    };
    (examples[user.role]||[]).forEach(text=>{const button=document.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',()=>ask(text));suggestions.appendChild(button)});
    toggle.addEventListener('click',()=>{panel.hidden=false;toggle.hidden=true;if(!messages.children.length)add('Hola, soy el asistente de COME SAYULA. ¿En qué te ayudo?');input.focus()});
    close.addEventListener('click',()=>{panel.hidden=true;toggle.hidden=false});
    form.addEventListener('submit',event=>{event.preventDefault();ask(input.value)});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.requestSubmit()}});
    fetch('/api/ai/status',{headers:{'Authorization':'Bearer '+token}}).then(r=>r.json()).then(data=>{if(data.enabled)toggle.hidden=false}).catch(()=>{});
})();

