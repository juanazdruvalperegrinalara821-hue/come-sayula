(()=>{
  let user=null;try{user=JSON.parse(sessionStorage.getItem('cs_user')||'null')}catch(e){}
  if(!user||!['customer','restaurant','delivery'].includes(user.role)||location.pathname==='/feedback.html')return;
  const button=document.createElement('button');button.type='button';button.textContent='💬 Ayúdanos a mejorar';button.setAttribute('aria-label','Enviar una opinión a Come Sayula');
  Object.assign(button.style,{position:'fixed',right:'16px',bottom:'84px',zIndex:'900',border:'0',borderRadius:'999px',padding:'11px 15px',background:'#482307',color:'#fff',fontWeight:'700',boxShadow:'0 8px 22px #0003',cursor:'pointer'});
  button.onclick=()=>location.href='/feedback.html';document.body.appendChild(button);
})();

