import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stableReferenceToken,missingReferenceMention,assistantFailureMessage} from '../src/lib/prompt-assistant';
import {getAssistantModel} from '../src/lib/assistant-models';
test('reference tokens keep the same image when another selection is added or removed',()=>{
 const a={assetId:'a',url:'/api/assets/a',title:'Portrait',role:'reference-image'},b={...a,assetId:'b',url:'/api/assets/b'};
 assert.notEqual(stableReferenceToken(a),stableReferenceToken(b));
 assert.equal([b,a].map(stableReferenceToken)[1],[a].map(stableReferenceToken)[0]);
 assert.notEqual(stableReferenceToken(a),stableReferenceToken({...a,role:'start-frame'}));
 const refs=[{...a,token:stableReferenceToken(a)}];
 assert.equal(missingReferenceMention('use '+refs[0].token,refs),undefined);
 assert.equal(missingReferenceMention('use '+stableReferenceToken(b),refs),stableReferenceToken(b));
 assert.equal(missingReferenceMention('write to person@example.com',refs),undefined);
});
test('provider price failure remains explicit and does not substitute a model',()=>{
 assert.match(assistantFailureMessage(new Error('No endpoints found that satisfy the max price for this request')),/Choose another assistant model/);
 assert.equal(assistantFailureMessage(new Error('Connection interrupted')),'Connection interrupted');
 assert.throws(()=>getAssistantModel('qwen/qwen3.8-max'),/not available/);
 assert.equal(getAssistantModel().promptUsdPerToken*1e6,.75);
 assert.equal(getAssistantModel().completionUsdPerToken*1e6,3.75);
});
