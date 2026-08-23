require('dotenv').config();
const db=require('./src/db');
(async()=>{
  const d=await db.query("select created_at, layer, decision, reason, left(coalesce(replied_text,''),190) as said from decisions where created_at > timestamptz '2026-08-23T01:31:40Z' order by created_at");
  if(!d.rows.length){ console.log('no new decisions since the deploy yet'); return; }
  for(const r of d.rows){
    console.log(r.created_at.toISOString()+'  '+r.layer+'/'+r.decision+'  '+r.reason);
    if(r.said) console.log('    "'+r.said.replace(/\n/g,' / ')+'"');
  }
})().catch(e=>console.error('ERR',e.message)).finally(()=>db.pool.end());
