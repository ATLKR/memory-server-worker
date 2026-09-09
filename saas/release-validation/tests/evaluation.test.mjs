import test from 'node:test';import assert from 'node:assert/strict';
let evaluate;try{({evaluate}=await import('../tools/evaluate.mjs'));}catch{}
test('evaluation separates recall from forbidden and stale result leakage',()=>{
 assert.equal(typeof evaluate,'function');const cases=[{id:'a',expectedIds:['good'],forbiddenIds:['private'],staleIds:['old']},{id:'b',expectedIds:[],forbiddenIds:['private'],staleIds:[]}];
 const score=evaluate(cases,[{caseId:'a',results:['old','good'],latencyMs:10},{caseId:'b',results:['private'],latencyMs:20}],5);
 assert.equal(score.recallAtK,1);assert.equal(score.meanReciprocalRank,0.5);assert.equal(score.forbiddenHits,1);assert.equal(score.staleHits,1);assert.equal(score.complete,true);
});
