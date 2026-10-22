import assert from 'node:assert/strict';
import {test} from 'node:test';
import {imageEditIdentityId,imageEditSourceInstruction} from '../src/lib/image-edit-context';
import {assetThumbnailUrl} from '../src/lib/asset-preview-url';
import {imagePromptSystemInstruction} from '../src/lib/generation-prompt-system';

test('Edit anchors the original before assistant JSON, even when its text already says IMAGE EDIT MODE',()=>{
  const composed=JSON.stringify({task:'IMAGE EDIT MODE: change hair color',reference_plan:{'@Hair':'hair color only'}});
  const result=imageEditSourceInstruction(composed,['@EditSource','@Hair']);
  assert.ok(result.startsWith('IMAGE EDIT SOURCE CONTRACT:'));
  assert.match(result,/Image 1 is @EditSource/);
  assert.match(result,/Image 2 is @Hair, supplemental evidence only/);
  assert.ok(result.endsWith(composed));
  assert.throws(()=>imageEditSourceInstruction(composed,[]));
  assert.throws(()=>imageEditSourceInstruction(composed,['@Hair','@EditSource']));
  assert.throws(()=>imageEditSourceInstruction(composed,['@EditSource','@EditSource']));
  const system=imagePromptSystemInstruction({editMode:true});
  assert.match(system,/does not automatically replace @EditSource identity/);
  assert.doesNotMatch(system,/The task must say exactly which subject is replaced/);
  assert.doesNotMatch(system,/It must never supply the replacement person's face/);
});

test('Edit inherits identity through a generated chain but does not guess between different identities',()=>{
  const source={id:'edited',data:{assetId:'output'}},parent={id:'generated',data:{}},iris={id:'identity',data:{personaId:'iris'}};
  const nodes=[source,parent,iris],edges=[{source:iris.id,target:parent.id},{source:parent.id,target:source.id},{source:source.id,target:parent.id}];
  assert.equal(imageEditIdentityId(source,nodes,edges,[]),'iris');
  const other={id:'other',data:{personaId:'other'}};
  assert.equal(imageEditIdentityId(source,[...nodes,other],[...edges,{source:other.id,target:source.id}],[]),undefined);
  assert.equal(imageEditIdentityId(source,nodes,edges,[{id:'owner',assets:[{id:'output'}]}]),'owner');
  assert.equal(imageEditIdentityId({...source,data:{personaId:'explicit'}},nodes,edges,[]),'explicit');
  const attached={...source,data:{attachedReferences:[{personaId:'iris'}]}};
  assert.equal(imageEditIdentityId(attached,[attached],[],[]),'iris');
});

test('Edit and assistant previews reuse direct, cached Canvas thumbnails instead of originals',()=>{
  const result=new URL(assetThumbnailUrl('/api/assets/photo?download=1&thumbnail=1'),'https://example.test');
  assert.equal(result.searchParams.get('variant'),'thumbnail');
  assert.equal(result.searchParams.get('delivery'),'direct');
  assert.equal(result.searchParams.get('v'),'4');
  assert.equal(result.searchParams.has('download'),false);
  assert.equal(result.searchParams.has('thumbnail'),false);
  assert.equal(assetThumbnailUrl(result.pathname+result.search),result.pathname+result.search);
  assert.equal(assetThumbnailUrl('blob:upload'),'blob:upload');
});
