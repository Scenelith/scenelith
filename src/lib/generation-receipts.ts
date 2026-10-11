import { randomBytes } from 'node:crypto';
import { db } from './postgres-db';

export async function prepareProviderReceipt(generationId:string) {
  await db.prepare('INSERT INTO generation_provider_receipts(generation_id,callback_token) VALUES(?,?) ON CONFLICT DO NOTHING').run(generationId,randomBytes(32).toString('base64url'));
  return await db.prepare('SELECT callback_token,submitted_at,provider_task_id FROM generation_provider_receipts WHERE generation_id=?').get(generationId) as
    {callback_token:string;submitted_at:string|null;provider_task_id:string|null};
}
export async function markProviderSubmission(generationId:string,workerId:string,attempt:number) {
  const changed=await db.prepare(`UPDATE generation_provider_receipts SET submitted_at=now(),updated_at=now()
    WHERE generation_id=? AND submitted_at IS NULL AND provider_task_id IS NULL AND EXISTS(
      SELECT 1 FROM generation_dispatch_jobs d WHERE d.generation_id=? AND d.status='dispatching' AND d.locked_by=? AND d.attempts=?)`)
    .run(generationId,generationId,workerId,attempt);
  if(changed.changes!==1)throw new Error('Provider submission requires reconciliation');
}
export async function recordProviderTask(generationId:string,taskId:string) {
  await db.prepare(`UPDATE generation_provider_receipts SET provider_task_id=COALESCE(provider_task_id,?),updated_at=now()
    WHERE generation_id=? AND (provider_task_id IS NULL OR provider_task_id=?)`).run(taskId,generationId,taskId);
}
export async function requireProviderReconciliation(generationId:string,workerId:string,attempt:number) {
  await db.transaction(async()=>{
    const changed=await db.prepare(`UPDATE generation_dispatch_jobs SET status='reconciling',last_error='Checking whether the generation service accepted this request',
      locked_at=NULL,locked_by=NULL,updated_at=now() WHERE generation_id=? AND status='dispatching' AND locked_by=? AND attempts=?`)
      .run(generationId,workerId,attempt);
    if(changed.changes)await db.prepare("UPDATE generations SET status='reconciling',error=NULL,updated_at=now() WHERE id=? AND output_asset_id IS NULL AND provider_task_id IS NULL").run(generationId);
  })();
}
/** A verified callback can bind a task even if the create response was lost. */
export async function bindProviderReceipt(token:string,taskId:string) {
  return db.transaction(async()=>{
    const receipt=await db.prepare('SELECT generation_id,provider_task_id FROM generation_provider_receipts WHERE callback_token=? AND submitted_at IS NOT NULL FOR UPDATE').get(token) as {generation_id:string;provider_task_id:string|null}|undefined;
    if(!receipt || (receipt.provider_task_id && receipt.provider_task_id!==taskId))return null;
    await recordProviderTask(receipt.generation_id,taskId);
    await db.prepare('UPDATE generations SET provider_task_id=COALESCE(provider_task_id,?),updated_at=now() WHERE id=?').run(taskId,receipt.generation_id);
    await db.prepare("UPDATE generation_dispatch_jobs SET status='dispatched',last_error=NULL,locked_by=NULL,locked_at=NULL,updated_at=now() WHERE generation_id=? AND status IN ('dispatching','reconciling')").run(receipt.generation_id);
    return {id:receipt.generation_id};
  })();
}

export async function recoverProviderReceipts(recoveredBefore:string) {
  await db.transaction(async()=>{
    await db.prepare(`UPDATE generations g SET provider_task_id=r.provider_task_id,status=CASE WHEN g.status='reconciling' THEN 'waiting' ELSE g.status END,updated_at=now()
      FROM generation_provider_receipts r WHERE g.id=r.generation_id AND g.provider_task_id IS NULL AND r.provider_task_id IS NOT NULL`).run();
    await db.prepare(`UPDATE generation_dispatch_jobs d SET status='dispatched',locked_by=NULL,locked_at=NULL,last_error=NULL,updated_at=now()
      FROM generation_provider_receipts r WHERE d.generation_id=r.generation_id AND r.provider_task_id IS NOT NULL AND d.status IN ('dispatching','reconciling')`).run();
    await db.prepare(`UPDATE generation_dispatch_jobs d SET status='reconciling',locked_by=NULL,locked_at=NULL,last_error='Checking whether the generation service accepted this request',updated_at=now()
      FROM generation_provider_receipts r WHERE d.generation_id=r.generation_id AND r.submitted_at IS NOT NULL AND r.provider_task_id IS NULL
      AND d.status='dispatching' AND d.locked_at<? AND NOT EXISTS(SELECT 1 FROM worker_heartbeats w WHERE w.worker_id=d.locked_by AND w.last_seen_at>=?)`).run(recoveredBefore,recoveredBefore);
    await db.prepare(`UPDATE generations g SET status='reconciling',error=NULL,updated_at=now() FROM generation_dispatch_jobs d
      WHERE d.generation_id=g.id AND d.status='reconciling' AND g.provider_task_id IS NULL AND g.output_asset_id IS NULL AND g.status IN ('queued','created','waiting')`).run();
  })();
}
