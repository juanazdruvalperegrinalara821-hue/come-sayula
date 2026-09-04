const fs=require('fs'),path=require('path'),os=require('os'),Database=require('better-sqlite3');
const root=__dirname,folder=path.join(root,'backups');
const files=fs.existsSync(folder)?fs.readdirSync(folder).filter(name=>/^come_sayula-.*\.db$/.test(name)).sort().reverse():[];
if(!files.length)throw new Error('No existe un respaldo automático para probar');
const source=path.join(folder,files[0]),target=path.join(os.tmpdir(),'come-sayula-restore-test.db');
fs.copyFileSync(source,target);const restored=new Database(target,{readonly:true});
try{const result=restored.pragma('integrity_check',{simple:true});if(result!=='ok')throw new Error('La copia restaurada no pasó integrity_check: '+result);const tables=restored.prepare("SELECT count(*) total FROM sqlite_master WHERE type='table'").get().total;if(tables<1)throw new Error('La restauración no contiene tablas');console.log(`✓ Restauración de prueba correcta: ${files[0]} (${tables} tablas)`)}finally{restored.close();fs.unlinkSync(target)}
