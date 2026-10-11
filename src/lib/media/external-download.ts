import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MediaError } from './contracts';

export function publicIPv4(address:string) {
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(address))return false;
  const [a,b,c,d]=address.split('.').map(Number);
  if([a,b,c,d].some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||
    (a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||(b===88&&c===99)))||
    (a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
/** Pin a checked public IPv4 address on every hop; never resolve again at connection time. */
export async function externalMediaBody(value:string,signal:AbortSignal,redirects=0):Promise<import('node:http').IncomingMessage> {
  signal.throwIfAborted();
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||redirects>5)throw new MediaError('UNSAFE_MEDIA_URL');
  const addresses=await lookup(url.hostname,{all:true,family:4});
  signal.throwIfAborted();
  if(!addresses.length || addresses.some(a=>!publicIPv4(a.address)))throw new MediaError('UNSAFE_MEDIA_URL');
  const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
    const request=get(url,{signal,agent:false,family:4,lookup:(_hostname,_options,callback)=>callback(null,addresses[0].address,4),headers:{'user-agent':'Scenelith media-worker'}},resolve);
    request.once('error',reject);
  });
  if([301,302,303,307,308].includes(response.statusCode||0)){
    const location=response.headers.location;response.destroy();
    if(!location)throw new MediaError('MEDIA_DOWNLOAD_FAILED',502,true);
    return externalMediaBody(new URL(location,url).href,signal,redirects+1);
  }
  if(response.statusCode!==200){response.destroy();throw new MediaError('MEDIA_DOWNLOAD_FAILED',502,(response.statusCode||0)>=500||response.statusCode===429);}
  return response;
}
export async function downloadExternalMedia(url:string,destination:string,maxBytes:number,signal:AbortSignal) {
  const body=await externalMediaBody(url,signal);
  let size=0;
  const limit=new Transform({transform(chunk,_encoding,done){size+=chunk.length;done(size>maxBytes?new MediaError('MEDIA_FILE_LIMIT'):null,chunk);}});
  await pipeline(body,limit,createWriteStream(destination,{flags:'wx'}),{signal});
  return {size,contentType:String(body.headers['content-type']||'application/octet-stream').split(';')[0]};
}
