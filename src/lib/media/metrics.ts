import {db} from '../postgres-db';

/** Bounded time window; historical completed jobs do not make every scrape scan the archive. */
export async function mediaMetrics() {
  const queue=await db.prepare(`SELECT status,resource_class,count(*) AS count,EXTRACT(EPOCH FROM (now()-min(created_at))) AS age
    FROM media_jobs WHERE status IN ('queued','running','retry_wait') GROUP BY status,resource_class`).all() as Array<{status:string;resource_class:string;count:number;age:number}>;
  const finished=await db.prepare(`SELECT status,count(*) AS count,COALESCE(sum(GREATEST(0,attempts-1)),0) AS retries
    FROM media_jobs WHERE completed_at>now()-interval '24 hours' GROUP BY status`).all() as Array<{status:string;count:number;retries:number}>;
  const paths=await db.prepare(`SELECT result_json->'plan'->>'video' AS path,count(*) AS count FROM media_jobs
    WHERE completed_at>now()-interval '24 hours' AND status='completed' AND result_json->'plan'->>'video' IS NOT NULL GROUP BY 1`).all() as Array<{path:string;count:number}>;
  const timings=await db.prepare(`SELECT step.name,COUNT(*) AS count,AVG((j.metrics_json->>step.name)::numeric)/1000 AS average,
    percentile_cont(.95) WITHIN GROUP(ORDER BY (j.metrics_json->>step.name)::numeric)/1000 AS p95
    FROM media_jobs j CROSS JOIN (VALUES('queueMs'),('downloadMs'),('analysisMs'),('processMs'),('uploadMs'),('executionMs')) step(name)
    WHERE j.completed_at>now()-interval '24 hours' AND j.metrics_json -> step.name IS NOT NULL GROUP BY step.name`).all() as Array<{name:string;count:number;average:number;p95:number}>;
  const expired=await db.prepare("SELECT count(*) AS n FROM media_jobs WHERE status='running' AND lease_until<now()").get() as {n:number};
  return [...queue.flatMap(r=>[
    `scenelith_media_jobs{status="${r.status}",class="${r.resource_class}"} ${r.count}`,
    `scenelith_media_oldest_age_seconds{status="${r.status}",class="${r.resource_class}"} ${r.age}`]),
    ...finished.flatMap(r=>[`scenelith_media_finished_24h{status="${r.status}"} ${r.count}`,`scenelith_media_retries_24h{status="${r.status}"} ${r.retries}`]),
    ...paths.map(r=>`scenelith_media_processing_path_24h{path="${r.path}"} ${r.count}`),
    ...timings.flatMap(r=>[`scenelith_media_stage_seconds_24h{stage="${r.name}",stat="average"} ${r.average}`,`scenelith_media_stage_seconds_24h{stage="${r.name}",stat="p95"} ${r.p95}`]),
    `scenelith_media_expired_leases ${expired.n}`,
    `scenelith_media_worker_rss_bytes ${process.memoryUsage().rss}`,
  ].join('\n')+'\n';
}
