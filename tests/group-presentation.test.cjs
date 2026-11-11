const test=require('node:test');
const assert=require('node:assert/strict');

const memoryStore=(initial={})=>{
  let data=structuredClone(initial);
  return {read:async()=>structuredClone(data),update:async fn=>{const next=structuredClone(data),result=fn(next);data=next;return structuredClone(result);}};
};

test('último grupo fixado entra primeiro e a ordem persiste',async()=>{
  const {createGroupPresentation}=require('../lib/group-presentation.cjs'),store=memoryStore();
  const first=createGroupPresentation({store});
  await first.setPinned('111@g.us',true);
  await first.setPinned('222@g.us',true);
  assert.deepEqual(await first.read(),{version:1,pinned:['222@g.us','111@g.us'],normal:[]});
  assert.deepEqual(await createGroupPresentation({store}).read(),{version:1,pinned:['222@g.us','111@g.us'],normal:[]});
});

test('reordenação não cruza o limite fixado nem aceita duplicatas',async()=>{
  const {createGroupPresentation}=require('../lib/group-presentation.cjs'),service=createGroupPresentation({store:memoryStore()});
  await service.reconcile(['111@g.us','222@g.us']);
  await service.setPinned('111@g.us',true);
  await assert.rejects(service.reorder({pinned:[],normal:['111@g.us','222@g.us']}),error=>error.status===409);
  await assert.rejects(service.reorder({pinned:['111@g.us'],normal:['222@g.us','222@g.us']}),error=>error.status===422);
  await assert.rejects(service.setPinned('5511999999999@s.whatsapp.net',true),error=>error.status===422);
});

test('desafixar insere primeiro nos normais e reconciliação inclui novos grupos',async()=>{
  const {createGroupPresentation}=require('../lib/group-presentation.cjs'),service=createGroupPresentation({store:memoryStore()});
  await service.reconcile(['111@g.us','222@g.us']);
  await service.setPinned('222@g.us',true);
  assert.deepEqual(await service.setPinned('222@g.us',false),{version:1,pinned:[],normal:['222@g.us','111@g.us']});
  assert.deepEqual(await service.reconcile(['111@g.us','222@g.us','333@g.us']),{version:1,pinned:[],normal:['222@g.us','111@g.us','333@g.us']});
});
