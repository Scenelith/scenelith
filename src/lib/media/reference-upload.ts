import { Readable } from 'node:stream';
import { statStorageObject,streamStorageObject } from '../storage';

/** Stream video/audio references to the provider without materializing a Blob in RAM. */
export async function referenceMultipart(path:string,mimeType:string,filename:string,signal:AbortSignal) {
  if(!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) || !/^[a-z0-9.-]+$/i.test(filename))throw new Error('Invalid reference content type');
  const boundary=`scenelith-${crypto.randomUUID()}`;
  const prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="uploadPath"\r\n\r\nscenelith/references\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${filename}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const suffix=Buffer.from(`\r\n--${boundary}--\r\n`),info=await statStorageObject(path);
  const source=await streamStorageObject(path,undefined,signal),reader=source.getReader();
  const body=Readable.from((async function*(){
    let bytes=0;
    try{
      yield prefix;
      for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>info.size)throw new Error('Reference changed during upload');yield value;}
      if(bytes!==info.size)throw new Error('Reference changed during upload');yield suffix;
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  })());
  return {body,headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(prefix.length+info.size+suffix.length)}};
}
