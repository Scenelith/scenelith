import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { putStorageFile, safeExtension, storageFileDestination } from '../storage';
import { db } from '../postgres-db';
import { mediaConfig } from './config';
import { MediaError } from './contracts';

/** A crashed provider transfer cannot live beyond the maximum configured
 * transfer deadline (two hours). Do not follow links or touch other temp data. */
export async function cleanupProviderTemp(root=tmpdir(),now=Date.now()) {
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    if(!entry.isDirectory() || !/^scenelith-provider-[A-Za-z0-9]+$/.test(entry.name))continue;
    const path=join(root,entry.name),info=await lstat(path).catch(()=>null);
    if(info && !info.isSymbolicLink() && now-info.mtimeMs>7_500_000)await rm(path,{recursive:true,force:true});
  }
}

/** Provider reconciliation stores the immutable result. Decoding belongs to media-worker. */
export async function storeProviderVideo(url:string,keyPrefix:string,stagingId:string) {
  const dir=await mkdtemp(join(tmpdir(),'scenelith-provider-'));
  const signal=AbortSignal.timeout(mediaConfig().transferTimeoutMs);
  try {
    let body:Readable,contentType='video/mp4';
    if (/^https?:\/\//i.test(url)) {
      const response=await fetch(url,{signal});
      if(!response.ok || !response.body)throw new MediaError('PROVIDER_DOWNLOAD_FAILED',502,true);
      contentType=response.headers.get('content-type')?.split(';')[0]||contentType;
      if(contentType==='application/octet-stream')contentType='video/mp4';
      body=Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    } else {
      // Decode provider base64 incrementally, including data URLs.
      let start=0;
      if(url.startsWith('data:')){const header=/^data:(video\/[a-z0-9.+-]+);base64,/i.exec(url);if(!header)throw new MediaError('INVALID_PROVIDER_MEDIA');contentType=header[1];start=header[0].length;}
      body=Readable.from((function*(){for(let i=start;i<url.length;i+=65536)yield Buffer.from(url.slice(i,i+65536),'base64');})());
    }
    if(!contentType.startsWith('video/'))throw new MediaError('INVALID_PROVIDER_MEDIA');
    let bytes=0;
    const limit=new Transform({transform(chunk,_encoding,done){
      bytes+=chunk.length;done(bytes>mediaConfig().maxFileBytes?new MediaError('MEDIA_FILE_LIMIT'):null,chunk);
    }});
    const path=join(dir,'source');
    await pipeline(body,limit,createWriteStream(path,{flags:'wx'}),{signal});
    const extension=safeExtension(/^https?:\/\//i.test(url)?new URL(url).pathname:'generated',contentType);
    const key=`${keyPrefix}${extension}`;
    await db.prepare("INSERT INTO media_job_objects(job_id,fence,ordinal,storage_reference,protected_until) VALUES(?,0,0,?,now()+(? * interval '1 millisecond'))")
      .run(stagingId,storageFileDestination(key).reference,mediaConfig().transferTimeoutMs+90_000);
    const stored=await putStorageFile(path,key,{contentType},signal);
    return {stored,extension,contentType};
  } finally {await rm(dir,{recursive:true,force:true});}
}
