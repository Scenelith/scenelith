import { db } from '../postgres-db';
import { MediaError } from './contracts';

/** Call inside the asset publication transaction, before inserting any assets. */
export async function retainMediaStaging(jobId:string,fence:number,expected:number) {
  const rows=await db.prepare(`UPDATE media_job_objects SET retained=true
    WHERE job_id=? AND fence=? AND cleanup_claimed_at IS NULL RETURNING ordinal`).all(jobId,fence);
  if(rows.length!==expected)throw new MediaError('STAGING_OWNERSHIP_LOST',503,true);
}

/** A committed claim is irreversible: late publishers must retry with a new object. */
export async function claimMediaCleanup() {
  return db.transaction(async()=>{
    return db.prepare(`WITH candidates AS (
      SELECT o.job_id,o.fence,o.ordinal FROM media_job_objects o LEFT JOIN media_jobs j ON j.id=o.job_id
      WHERE NOT o.retained AND o.protected_until<now() AND o.created_at<now()-interval '10 minutes'
        AND (j.id IS NULL OR j.status IN ('failed','cancelled','completed') OR o.fence<>j.fence)
        AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.storage_path=o.storage_reference)
      ORDER BY o.created_at LIMIT 50 FOR UPDATE OF o SKIP LOCKED
    ) UPDATE media_job_objects o SET cleanup_claimed_at=COALESCE(o.cleanup_claimed_at,now())
      FROM candidates c WHERE o.job_id=c.job_id AND o.fence=c.fence AND o.ordinal=c.ordinal
      RETURNING o.job_id,o.fence,o.ordinal,o.storage_reference`).all() as Promise<Array<{job_id:string;fence:number;ordinal:number;storage_reference:string}>>;
  })();
}
