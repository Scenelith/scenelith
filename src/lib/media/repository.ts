import { planProcessing } from './planner';
import type { MediaMetadata } from './probe';
import { db, userCanAccessAsset, userCanAccessProject, userCanAccessWorkspace } from '../postgres-db';
import { MEDIA_VERSION, MediaError, fingerprint, inputIds, mediaJobRequestSchema, type MediaInput, type MediaJob, type MediaSpec } from './contracts';
import { mediaConfig } from './config';

export async function authorizedInputs(userId: string, spec: MediaSpec): Promise<MediaInput[]> {
  const inputs = await Promise.all(inputIds(spec).map(async id => {
    if (!await userCanAccessAsset(userId,id)) throw new MediaError('SOURCE_UNAVAILABLE',404);
    const row = await db.prepare('SELECT id,workspace_id,project_id,storage_path,mime_type,content_hash,size_bytes FROM assets WHERE id=?').get(id) as Omit<MediaInput,'identity'> | undefined;
    if (!row || !/^(video|audio)\//.test(row.mime_type)) throw new MediaError('SOURCE_UNAVAILABLE',404);
    return { ...row, identity: fingerprint([row.id,row.content_hash,row.storage_path,row.size_bytes]) };
  }));
  return inputs.sort((a,b)=>a.id.localeCompare(b.id));
}
export async function assertJobAccess(job: MediaJob, userId = job.user_id) {
  if (job.user_id !== userId || !(job.project_id ? await userCanAccessProject(userId,job.project_id) : await userCanAccessWorkspace(userId,job.workspace_id))) throw new MediaError('JOB_UNAVAILABLE',404);
  const inputs = await authorizedInputs(userId,JSON.parse(job.spec_json));
  const snapshot = JSON.parse(job.inputs_json) as MediaInput[];
  if (fingerprint(inputs.map(i=>[i.id,i.identity])) !== fingerprint(snapshot.map(i=>[i.id,i.identity]))) throw new MediaError('SOURCE_CHANGED',409);
  if (job.result_asset_id && !await userCanAccessAsset(userId,job.result_asset_id)) throw new MediaError('RESULT_UNAVAILABLE',404);
}
export async function createMediaJob(userId: string, raw: unknown): Promise<MediaJob> {
  const parsed = mediaJobRequestSchema.safeParse(raw);
  if (!parsed.success) throw new MediaError('INVALID_MEDIA_REQUEST');
  const { projectId,requestKey,spec } = parsed.data;
  if(spec.operation==='import' && !projectId)throw new MediaError('PROJECT_REQUIRED');
  if (projectId && !await userCanAccessProject(userId,projectId)) throw new MediaError('PROJECT_UNAVAILABLE',404);
  if (spec.operation==='export' && spec.audioMode==='original' && spec.assets.some(a=>!a.audio)) throw new MediaError('ORIGINAL_AUDIO_MISSING');
  const project = projectId ? await db.prepare('SELECT workspace_id FROM projects WHERE id=?').get(projectId) as {workspace_id:string} : {workspace_id:parsed.data.workspaceId!};
  if (!project || !await userCanAccessWorkspace(userId,project.workspace_id)) throw new MediaError('PROJECT_UNAVAILABLE',404);
  const scopeKey=projectId||`workspace:${project.workspace_id}`;
  const inputs = await authorizedInputs(userId,spec);
  const dependencies=[...new Set(parsed.data.dependencies)].sort();
  for(const id of dependencies){const dependency=await getMediaJob(userId,id);if(dependency.workspace_id!==project.workspace_id)throw new MediaError("DEPENDENCY_UNAVAILABLE",404);}
  const metadata=new Map<string,MediaMetadata>();
  await Promise.all(inputs.map(async input=>{
    const cached=await db.prepare('SELECT metadata_json FROM media_asset_analysis WHERE asset_id=? AND content_identity=? AND analyzer_version=?').get(input.id,input.identity,MEDIA_VERSION) as {metadata_json:string}|undefined;
    if(cached)metadata.set(input.id,JSON.parse(cached.metadata_json));
  }));
  let resource:'light'|'transcode'=['analyze','frame'].includes(spec.operation)?'light':'transcode';
  let reuseId:string|undefined,reusePlan:unknown;
  if(spec.operation==='analyze' && metadata.has(spec.assetId))reuseId=spec.assetId;
  if(spec.operation==='preview'){
    const known=metadata.get(spec.assetId);
    if(known?.directPlayback)reuseId=spec.assetId;
    if(known?.video?.codec_name==='h264' && known.video.pix_fmt==='yuv420p')resource='light';
  }
  if(spec.operation==='audio' && metadata.has(spec.assetId)){
    const known=metadata.get(spec.assetId)!;
    const plan=planProcessing([{id:spec.assetId,start:0,end:known.duration,metadata:known}],spec.audio?'original':'none');
    if(plan.video==='copy')resource='light';
  }
  if(spec.operation==='segment' || spec.operation==='export'){
    const ranges=spec.operation==='segment'?[spec.range]:spec.assets;
    if(ranges.every(r=>metadata.has(r.id))){
      if(ranges.some(r=>r.start>=metadata.get(r.id)!.duration || r.end>metadata.get(r.id)!.duration+1e-6))throw new MediaError('RANGE_OUTSIDE_SOURCE');
      const first=metadata.get(ranges[0].id)!;
      const geometry=spec.operation==='segment' && spec.modelId==='seedance-2-5' && Number(first.video?.width)*Number(first.video?.height)>921600;
      const plan=planProcessing(ranges.map(r=>({...r,metadata:metadata.get(r.id)!})),spec.operation==='export'?spec.audioMode:'selected',geometry);
      if(plan.video==='copy' || plan.video==='reuse')resource='light';
      if(plan.video==='reuse'){reuseId=ranges[0].id;reusePlan=plan;}
    }
  }
  const hash = fingerprint({ version: MEDIA_VERSION, projectId:projectId||null, spec, dependencies, inputs: inputs.map(i=>[i.id,i.identity]) });
  const job = await db.transaction(async()=> {
    // Only competing retries serialize. Unrelated orders in one workspace can
    // be admitted concurrently. Always acquire request before operation locks.
    await db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get(`media-request:${userId}:${scopeKey}:${requestKey}`);
    await db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get(`media-operation:${userId}:${project.workspace_id}:${hash}`);
    const previous = await db.prepare('SELECT fingerprint,job_id FROM media_job_requests WHERE user_id=? AND scope_key=? AND request_key=?').get(userId,scopeKey,requestKey) as {fingerprint: string;job_id: string}|undefined;
    if (previous && previous.fingerprint!==hash) throw new MediaError('IDEMPOTENCY_CONFLICT',409);
    let row = await db.prepare('SELECT * FROM media_jobs WHERE user_id=? AND workspace_id=? AND fingerprint=?').get(userId,project.workspace_id,hash) as MediaJob|undefined;
    if (!row) {
      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO media_jobs(id,user_id,workspace_id,project_id,operation,operation_version,fingerprint,spec_json,inputs_json,resource_class)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,userId,project.workspace_id,projectId||null,spec.operation,MEDIA_VERSION,hash,JSON.stringify(spec),JSON.stringify(inputs),resource);
      for (const input of inputs) await db.prepare('INSERT INTO media_job_inputs(job_id,asset_id) VALUES(?,?)').run(id,input.id);
      for(const dependency of dependencies)await db.prepare("INSERT INTO media_job_dependencies(job_id,dependency_id) VALUES(?,?)").run(id,dependency);
      if(dependencies.length)await db.prepare("UPDATE media_jobs SET stage='waiting_dependencies' WHERE id=?").run(id);
      if(reuseId && !dependencies.length){
        const result={asset:{id:reuseId,url:`/api/assets/${reuseId}`,downloadUrl:`/api/assets/${reuseId}?download=1`},metadata:metadata.get(reuseId),plan:reusePlan};
        await db.prepare("UPDATE media_jobs SET status='completed',stage='completed',result_asset_id=?,result_json=?,completed_at=now() WHERE id=?").run(reuseId,JSON.stringify(result),id);
      }
      row = await db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id) as MediaJob;
    }
    await db.prepare('INSERT INTO media_job_requests(user_id,scope_key,request_key,fingerprint,job_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(userId,scopeKey,requestKey,hash,row.id);
    await db.prepare('INSERT INTO media_workspace_turns(workspace_id) VALUES(?) ON CONFLICT DO NOTHING').run(project.workspace_id);
    return row;
  })();
  await assertJobAccess(job,userId);
  return job;
}
export async function getMediaJob(userId: string,id: string) {
  const job = await db.prepare('SELECT * FROM media_jobs WHERE id=? AND user_id=?').get(id,userId) as MediaJob|undefined;
  if (!job) throw new MediaError('JOB_UNAVAILABLE',404);
  await assertJobAccess(job,userId);
  return job;
}
export async function cancelMediaJob(userId: string,id: string) {
  await getMediaJob(userId,id);
  await db.transaction(async()=>{
  await db.prepare(`UPDATE media_jobs SET status='cancelled',stage='cancelled',fence=fence+1,lease_until=NULL,updated_at=now(),completed_at=now()
    WHERE id=? AND user_id=? AND status IN ('queued','retry_wait','running')`).run(id,userId);
  await db.prepare("DELETE FROM media_storage_reservations WHERE job_id=? AND EXISTS(SELECT 1 FROM media_jobs WHERE id=? AND status='cancelled')").run(id,id);
  })();
  return getMediaJob(userId,id);
}
export async function recoverMediaJobs() {
  await db.prepare("DELETE FROM media_storage_reservations r USING media_jobs j WHERE r.job_id=j.id AND (j.status<>'running' OR r.fence<>j.fence OR j.lease_until<now())").run();
  await db.prepare(`UPDATE media_jobs j SET status='failed',stage='failed',error_code='DEPENDENCY_FAILED',updated_at=now(),completed_at=now()
    WHERE j.status IN ('queued','retry_wait') AND EXISTS(SELECT 1 FROM media_job_dependencies d JOIN media_jobs parent ON parent.id=d.dependency_id
      WHERE d.job_id=j.id AND parent.status IN ('failed','cancelled'))`).run();
  return db.prepare(`UPDATE media_jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'retry_wait' END,
    stage=CASE WHEN attempts>=? THEN 'failed' ELSE 'queued' END,error_code='WORKER_LOST',worker_id=NULL,lease_until=NULL,fence=fence+1,
    available_at=now()+interval '5 seconds',updated_at=now(),completed_at=CASE WHEN attempts>=? THEN now() ELSE NULL END
    WHERE status='running' AND lease_until<now()`)
    .run(mediaConfig().maxAttempts,mediaConfig().maxAttempts,mediaConfig().maxAttempts);
}
export async function claimMediaJob(workerId: string,resource: 'light'|'transcode') {
  return db.transaction(async()=> {
    const job = await db.prepare(`SELECT j.* FROM media_jobs j JOIN media_workspace_turns t ON t.workspace_id=j.workspace_id
      WHERE j.status IN ('queued','retry_wait') AND j.available_at<=now() AND j.resource_class=? AND j.operation_version=?
      AND NOT EXISTS(SELECT 1 FROM media_job_dependencies d JOIN media_jobs parent ON parent.id=d.dependency_id WHERE d.job_id=j.id AND parent.status<>'completed')
      ORDER BY t.last_claimed_at,j.created_at,j.id LIMIT 1 FOR UPDATE OF j,t SKIP LOCKED`).get(resource,MEDIA_VERSION) as MediaJob|undefined;
    if (!job) return null;
    await db.prepare('UPDATE media_workspace_turns SET last_claimed_at=now() WHERE workspace_id=?').run(job.workspace_id);
    return await db.prepare(`UPDATE media_jobs SET status='running',stage='preparing',attempts=attempts+1,fence=fence+1,
      worker_id=?,lease_until=now()+make_interval(secs => ?),error_code=NULL,updated_at=now() WHERE id=? RETURNING *`)
      .get(workerId,mediaConfig().leaseSeconds,job.id) as MediaJob;
  })();
}
export async function renewMediaLease(job: MediaJob,stage?: string) {
  const result = await db.prepare(`UPDATE media_jobs SET lease_until=now()+make_interval(secs => ?),stage=COALESCE(?,stage),updated_at=now()
    WHERE id=? AND worker_id=? AND fence=? AND status='running' AND lease_until>now()`)
    .run(mediaConfig().leaseSeconds,stage ?? null,job.id,job.worker_id,job.fence);
  if (!result.changes) throw new MediaError('LEASE_LOST',409);
}
export async function failMediaJob(job: MediaJob,error: MediaError) {
  const retry = error.retryable && job.attempts < mediaConfig().maxAttempts;
  await db.transaction(async()=>{
  await db.prepare(`UPDATE media_jobs SET status=?,stage=?,error_code=?,worker_id=NULL,lease_until=NULL,
    available_at=now()+make_interval(secs => ?),updated_at=now(),completed_at=CASE WHEN ? THEN NULL ELSE now() END
    WHERE id=? AND worker_id=? AND fence=? AND status='running' AND lease_until>now()`)
    .run(retry?'retry_wait':'failed',retry?'queued':'failed',error.code,Math.min(120,5*2**job.attempts),retry,job.id,job.worker_id,job.fence);
  await db.prepare("DELETE FROM media_storage_reservations WHERE job_id=? AND fence=? AND EXISTS(SELECT 1 FROM media_jobs WHERE id=? AND status<>'running')").run(job.id,job.fence,job.id);
  })();
}

/** Explicit user retry only; automatic delivery cannot reset the three-attempt limit. */
export async function retryMediaJob(userId:string,id:string) {
  await getMediaJob(userId,id);
  await db.transaction(async()=>{
    const job=await db.prepare('SELECT * FROM media_jobs WHERE id=? AND user_id=? FOR UPDATE').get(id,userId) as MediaJob;
    if(!['failed','cancelled'].includes(job.status))return;
    await assertJobAccess(job,userId);
    const failedDependency=await db.prepare("SELECT d.dependency_id FROM media_job_dependencies d JOIN media_jobs p ON p.id=d.dependency_id WHERE d.job_id=? AND p.status IN ('failed','cancelled') LIMIT 1").get(id);
    if(failedDependency)throw new MediaError('RETRY_DEPENDENCY_FIRST',409);
    await db.prepare('DELETE FROM media_storage_reservations WHERE job_id=?').run(id);
    await db.prepare("UPDATE media_jobs SET status='queued',stage='queued',attempts=0,fence=fence+1,worker_id=NULL,lease_until=NULL,error_code=NULL,available_at=now(),updated_at=now(),completed_at=NULL WHERE id=?").run(id);
  })();
  return getMediaJob(userId,id);
}
