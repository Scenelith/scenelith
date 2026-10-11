import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {downloadStorageFile,putStorageFile,deleteStorageObject} from '../../src/lib/storage';

test('storage outage and hanging verification/deletion obey the transfer deadline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'media-storage-fault-'));let heads=0,deletes=0;
 const server=createServer((request,response)=>{
  if(request.method==='GET'){response.writeHead(503,{'content-type':'application/xml'});response.end('<Error><Code>ServiceUnavailable</Code></Error>');}
  else if(request.method==='PUT'){request.resume();request.once('end',()=>{response.writeHead(200,{etag:'"fixture"'});response.end();});}
  else if(request.method==='HEAD'){heads++;/* intentionally hang */}
  else if(request.method==='DELETE'){deletes++;/* intentionally hang */}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const names=['STORAGE_PROVIDER','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_FORCE_PATH_STYLE','AWS_MAX_ATTEMPTS'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 Object.assign(process.env,{STORAGE_PROVIDER:'s3',S3_ENDPOINT:`http://127.0.0.1:${(server.address() as {port:number}).port}`,S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture',S3_FORCE_PATH_STYLE:'true',AWS_MAX_ATTEMPTS:'1'});
 try{
  await assert.rejects(downloadStorageFile('s3://fixture/source',join(dir,'download'),1000,AbortSignal.timeout(2000)),(error:unknown)=>Boolean(error&&typeof error==='object'&&'$metadata' in error&&(error.$metadata as {httpStatusCode:number}).httpStatusCode===503));
  const file=join(dir,'source');await writeFile(file,'fixture');
  const started=Date.now();
  await assert.rejects(putStorageFile(file,'verification',{bucket:'fixture'},AbortSignal.timeout(500)));
  assert.equal(heads,1,'deadline must cover post-upload verification');assert.ok(Date.now()-started<2000);
  await assert.rejects(deleteStorageObject('s3://fixture/orphan',AbortSignal.timeout(500)));
  assert.equal(deletes,1,'cleanup deletion must be cancellable');
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  await rm(dir,{recursive:true,force:true});
 }
});
