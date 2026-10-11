// Run against an isolated test account with a synthetic source and a live worker.
// No generation/provider endpoint is called. Never use a customer's workspace.
import {writeFile} from 'node:fs/promises';
const {MEDIA_TEST_ORIGIN:origin,MEDIA_TEST_COOKIE:cookie,MEDIA_TEST_PROJECT_ID:projectId,MEDIA_TEST_ASSET_ID:assetId}=process.env;
if(!origin||!cookie||!projectId||!assetId||process.env.MEDIA_TEST_SYNTHETIC_ACCOUNT!=='true')throw new Error('Supply an isolated synthetic account, origin, cookie, project and a >= 3 second video asset.');
const headers={cookie,'content-type':'application/json'},report={version:1,createdAt:new Date().toISOString(),jobs:[],baseline:[],underLoad:[]};
const percent=(samples,p)=>[...samples].sort((a,b)=>a-b)[Math.max(0,Math.ceil(samples.length*p)-1)];
const control=process.env.MEDIA_TEST_CONTROL_PATH||'/api/account/context';
async function request(path,init={}){const start=performance.now(),response=await fetch(new URL(path,origin),{...init,headers:{...headers,...init.headers},signal:AbortSignal.timeout(30000)});const data=await response.json();return {response,data,ms:performance.now()-start};}
for(let n=0;n<30;n++){const r=await request(control);if(!r.response.ok)throw new Error('Control request failed');report.baseline.push(r.ms);}
// Verify cached analysis before measuring known-metadata admission.
const analysis=await request('/api/media/jobs',{method:'POST',body:JSON.stringify({projectId,requestKey:crypto.randomUUID(),spec:{operation:'analyze',assetId}})});
if(analysis.data.status!=='completed')throw new Error('Wait for source analysis before the controlled test.');
let measuring=true,controlError;const controls=(async()=>{while(measuring){const r=await request(control);if(!r.response.ok)throw new Error('Control request failed under load');report.underLoad.push(r.ms);await new Promise(r=>setTimeout(r,200));}})().catch(error=>{controlError=error;});
try{
 const batch=crypto.randomUUID();
 const admissions=await Promise.allSettled(Array.from({length:100},async(_,i)=>{
  const spec=i%2?{operation:'frame',assetId,time:.011*i,maxWidth:640}:{operation:'segment',range:{id:assetId,start:.011*i,end:.011*i+1.5}};
  const r=await request('/api/media/jobs',{method:'POST',body:JSON.stringify({projectId,requestKey:`load:${batch}:${i}`,spec})});
  if(!r.response.ok)throw new Error(`Admission failed: ${r.response.status}`);
  const job={id:r.data.id,admissionMs:r.ms,status:r.data.status,stage:r.data.stage,resource:i%2?'light':'transcode'};report.jobs.push(job);
  if(job.status==='completed')throw new Error('Use a fresh synthetic asset so the benchmark cannot reuse completed operations');
  return job;
 }));
 const failure=admissions.find(r=>r.status==='rejected');if(failure)throw failure.reason;
 const admitted=admissions.map(r=>r.value);
 if(new Set(admitted.map(j=>j.id)).size!==100)throw new Error('The workload did not create 100 distinct operations');
 report.jobs=admitted;
 const deadline=Date.now()+Number(process.env.MEDIA_TEST_TIMEOUT_MS||3600000);
 while(report.jobs.some(j=>!['completed','failed','cancelled'].includes(j.status))){
  if(Date.now()>deadline)throw new Error('Timed out; retained job IDs in report allow recovery inspection');
  for(const job of report.jobs.filter(j=>!['completed','failed','cancelled'].includes(j.status))){const r=await request(`/api/media/jobs/${job.id}`);if(!r.response.ok)throw new Error('Status failed');job.status=r.data.status;job.stage=r.data.stage;job.error=r.data.error;job.resultAssetId=r.data.result?.asset?.id;}
  await new Promise(r=>setTimeout(r,1000));
 }
 report.summary={admissionP95Ms:percent(report.jobs.map(j=>j.admissionMs),.95),controlBaselineP95Ms:percent(report.baseline,.95),controlLoadP95Ms:percent(report.underLoad,.95),completed:report.jobs.filter(j=>j.status==='completed').length};
 report.summary.controlRatio=report.summary.controlLoadP95Ms/report.summary.controlBaselineP95Ms;
 if(controlError)throw controlError;
 report.pass=report.summary.completed===100&&report.summary.admissionP95Ms<=2000&&report.summary.controlRatio<=1.2;
 console.log(JSON.stringify(report.summary));if(!report.pass)process.exitCode=1;
}finally{measuring=false;await controls;await writeFile(process.env.MEDIA_TEST_REPORT||'/tmp/scenelith-media-load.json',JSON.stringify(report,null,2));}
