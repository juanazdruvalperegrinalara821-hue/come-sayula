const fs=require('fs'),path=require('path'),os=require('os'),Database=require('better-sqlite3');
const backupDir=path.resolve(process.env.BACKUP_DIR||path.join(process.env.DATA_DIR||__dirname,'backups'));
const configuredDatabase=path.resolve(process.env.DB_FILE||path.join(process.env.DATA_DIR||__dirname,'come_sayula.db'));
const files=fs.existsSync(backupDir)?fs.readdirSync(backupDir).filter(name=>/^come_sayula-.*\.db$/.test(name)).map(name=>({name,path:path.join(backupDir,name),time:fs.statSync(path.join(backupDir,name)).mtimeMs})).sort((a,b)=>b.time-a.time):[];
const source=process.env.BACKUP_FILE?path.resolve(process.env.BACKUP_FILE):files[0]?.path;
if(!source||!fs.existsSync(source))throw new Error('No existe un respaldo para probar. Define BACKUP_FILE o BACKUP_DIR.');
if(path.extname(source).toLowerCase()!=='.db')throw new Error('El respaldo debe ser una base SQLite con extensión .db');
const restoreDir=fs.mkdtempSync(path.join(os.tmpdir(),'come-sayula-restore-')),target=path.join(restoreDir,'restored.db');
if(path.resolve(target)===configuredDatabase)throw new Error('La restauración de prueba nunca puede usar la base configurada');
try{
  fs.copyFileSync(source,target);
  const restored=new Database(target,{readonly:true});
  try{
    const integrity=restored.pragma('integrity_check',{simple:true});
    if(integrity!=='ok')throw new Error('La copia restaurada no pasó integrity_check: '+integrity);
    const required=['users','restaurants','products','orders','order_status_history'],found=new Set(restored.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)),missing=required.filter(name=>!found.has(name));
    if(missing.length)throw new Error('La restauración no contiene tablas requeridas: '+missing.join(', '));
    console.log(`✓ Restauración temporal correcta: ${path.basename(source)} (${found.size} tablas)`);
  }finally{restored.close();}
}finally{fs.rmSync(restoreDir,{recursive:true,force:true});}
