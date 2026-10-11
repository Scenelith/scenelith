/** Standalone media entry point: intentionally imports no AI or payment orchestration. */
import { createServer } from 'node:http';
import { mediaMetrics } from './lib/media/metrics';
import { mediaConfig } from './lib/media/config';
import { claimMediaJob,recoverMediaJobs } from './lib/media/repository';
import { cleanupMediaObjects,executeMediaJob,cleanupMediaTemp,mediaTempUsage } from './lib/media/executor';
import { closeRelationalPool } from './lib/relational-db';
import { db } from './lib/postgres-db';

const config=mediaConfig(),workerId=`media:${crypto.randomUUID()}`;
let stopping=false,lastHeartbeat=0,lastError:string|null=null;
const active=new Set<Promise<void>>(),controllers=new Set<AbortController>();
const slots={light:0,transcode:0};
async function tick(){
  if(stopping)return;
  try{
    await db.prepare(`INSERT INTO worker_heartbeats(worker_id,worker_role,started_at,last_seen_at,last_error) VALUES(?,'media',now(),now(),?)
      ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,last_error=excluded.last_error`).run(workerId,lastError);
    lastHeartbeat=Date.now();await recoverMediaJobs();await cleanupMediaObjects();await cleanupMediaTemp();
    if(await mediaTempUsage()>config.maxTempBytes){for(const c of controllers)c.abort();throw new Error("MEDIA_DISK_BUDGET_EXCEEDED");}
    for(const resource of ['light','transcode'] as const){
      const limit=resource==='light'?config.lightConcurrency:config.transcodeConcurrency;
      while(!stopping && slots[resource]<limit){
        if(await mediaTempUsage()>config.maxTempBytes-config.maxFileBytes*2)break;
        const job=await claimMediaJob(workerId,resource);if(!job)break;
        slots[resource]++;const controller=new AbortController();controllers.add(controller);
        const task=executeMediaJob(job,controller.signal).catch(error=>{lastError=error instanceof Error?error.message:'MEDIA_WORKER_ERROR';})
          .finally(()=>{slots[resource]--;active.delete(task);controllers.delete(controller);});
        active.add(task);
      }
    }
    lastError=null;
  }catch(error){lastError=error instanceof Error?error.message:'MEDIA_WORKER_ERROR';console.error('Media worker tick failed',lastError);}
}
const server=createServer(async(request,response)=>{
  if(request.url==='/metrics'){
    const secret=process.env.SCENELITH_INTERNAL_METRICS_SECRET;
    if(!secret || request.headers.authorization!==`Bearer ${secret}`){response.writeHead(401);response.end();return;}
    try{
      const metrics=await mediaMetrics();
      response.writeHead(200,{'content-type':'text/plain; version=0.0.4'});response.end(metrics);
    }catch{response.writeHead(503);response.end();}return;
  }
  const ok=!stopping && Date.now()-lastHeartbeat<30_000;
  response.writeHead(ok?200:503,{'content-type':'application/json'});response.end(JSON.stringify({ok,role:'media',slots,lastError}));
});
// Container-only loopback health endpoint, no published host port.
server.listen(Number(process.env.WORKER_HEALTH_PORT||3001),'127.0.0.1');
let timer:ReturnType<typeof setTimeout>;
let ticking:Promise<void>|undefined;
async function loop(){ticking=tick();await ticking;if(!stopping)timer=setTimeout(loop,1000);}
async function stop(){
  if(stopping)return;stopping=true;clearTimeout(timer);
  const deadline=setTimeout(()=>{for(const controller of controllers)controller.abort();},60_000);
  await ticking;
  await Promise.allSettled([...active]);clearTimeout(deadline);server.close();await closeRelationalPool();
}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
void loop();
