import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search,ftsQuery} from '../../src/release/search.ts';

// Compare the service parser with plain-text input and inspect the real
// indexed lexemes in the generated tsvector. Distractors make dropped
// characters visible as false hits. The durable FTS tokenizer is the 'simple'
// config until the regional engine lands (postgres/migrations/0011).
const cases=[
 {name:'new-currency-symbol',query:'₿budget',bodies:['₿budget','budget'],tokens:['budget'],expected:[0,1],expr:'₿budget:*'},
 {name:'new-emoji-prefix',query:'🫠alpha',bodies:['🫠alpha','alpha'],tokens:['alpha'],expected:[0,1],expr:'🫠alpha:*'},
 {name:'new-emoji-inside',query:'x🫠y',bodies:['x🫠y','xylophone','yellow'],tokens:['x','y'],expected:[0],expr:'x🫠y:*'},
 {name:'new-format-character',query:'a\u061cb',bodies:['a\u061cb','apple','banana'],tokens:['a\u061cb'],expected:[0],expr:'a\u061cb:*'},
 {name:'new-punctuation-character',query:'a\u2e4fb',bodies:['a\u2e4fb','apple','banana'],tokens:['a','b'],expected:[0],expr:'a\u2e4fb:*'},
 {name:'new-combining-character',query:'a\u1ab0b',bodies:['a\u1ab0b','ab','apple','banana'],tokens:['a\u1ab0b'],expected:[0],expr:'a\u1ab0b:*'},
 {name:'new-uppercase-case-preservation',query:'\u1c90bc',bodies:['\u1c90bc','\u10d0bc'],tokens:['\u10d0bc'],expected:[0,1],expr:'\u1c90bc:*'},
 {name:'new-supplementary-case-preservation',query:'\u{1e900}bc',bodies:['\u{1e900}bc','\u{1e922}bc'],tokens:['\u{1e922}bc'],expected:[0,1],expr:'\u{1e900}bc:*'},
 {name:'private-use-only',query:'\ue000',bodies:['\ue000','\ue000project','project'],tokens:[],expected:[],expr:'\ue000:*'},
 {name:'private-use-prefix',query:'\ue000project',bodies:['\ue000project','project'],tokens:['project'],expected:[0,1],expr:'\ue000project:*'},
 {name:'private-use-inside',query:'x\ue000y',bodies:['x\ue000y','xylophone','yellow'],tokens:['x','y'],expected:[0],expr:'x\ue000y:*'},
 {name:'supplementary-private-use',query:'\u{f0000}project',bodies:['\u{f0000}project','project'],tokens:['project'],expected:[0,1],expr:'\u{f0000}project:*'},
 {name:'fullwidth',query:'ＡＢＣ',bodies:['ＡＢＣ','ABC'],tokens:['ａｂｃ'],expected:[0],expr:'ＡＢＣ:*'},
 {name:'ligature',query:'ﬃ',bodies:['ﬃ','ffi'],tokens:['ﬃ'],expected:[0],expr:'ﬃ:*'},
 {name:'decomposed-Latin',query:'caféine',bodies:['caféine','cafeine','cafeteria','ineffable'],tokens:['caféine'],expected:[0],expr:'caféine:*'},
 {name:'leading-mark',query:'́cafe',bodies:['́cafe','cafeteria','tea'],tokens:['cafe'],expected:[0,1],expr:'́cafe:*'},
 {name:'mark-only',query:'́',bodies:['́','cafe'],tokens:[],expected:[],expr:'́:*'},
 {name:'Devanagari-marks',query:'किताब',bodies:['किताब','कम्बल','तारीख','बड़ा'],tokens:['किताब'],expected:[0],expr:'किताब:*'},
 {name:'Hebrew-marks',query:'שָׁלוֹם',bodies:['שָׁלוֹם','שעה','לוח','ם'],tokens:['שָׁלוֹם'],expected:[0],expr:'שָׁלוֹם:*'},
 {name:'Arabic-marks',query:'عَرَبِيّ',bodies:['عَرَبِيّ','عالم','رياض','بيت','يد'],tokens:['عَرَبِيّ'],expected:[0],expr:'عَرَبِيّ:*'},
 {name:'combining-grapheme-joiner',query:'a͏b',bodies:['a͏b','apple','banana'],tokens:['a͏b'],expected:[0],expr:'a͏b:*'},
 {name:'underscore',query:'foo_bar',bodies:['foo_bar','foo barista','foo something bar','foozoo'],tokens:['foo','bar'],expected:[0,1],expr:'foo_bar:*'},
];
for(const entry of cases)test('query preserves native Unicode61 semantics for '+entry.name,async()=>{
 const {db,token,other}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memories=[];
  for(const [n,body] of entry.bodies.entries())memories.push(await store.create(token,'s1',{body},'body-'+n));
  await store.create(other,'s2',{body:entry.query},'foreign');
  const tokens=(await db.raw.prepare('SELECT unnest(tsvector_to_array(search_vector)) AS term FROM memory_content.memories WHERE id=?').all(memories[0].id)).map(r=>r.term).sort();
  assert.deepEqual(tokens,[...entry.tokens].sort());
  const expression=ftsQuery(entry.query);
  const reference=(await db.raw.prepare(`SELECT id AS memory_id FROM memory_content.memories r WHERE r.search_vector @@ to_tsquery('simple',?) AND r.space_id=? AND r.deleted_at IS NULL AND r.erased_at IS NULL AND r.payload_id IS NULL AND NOT EXISTS(SELECT 1 FROM memory_content.memories successor WHERE successor.supersedes_id=r.id)`).all(expression,'s1')).map(r=>r.memory_id).sort();
  assert.deepEqual(reference,entry.expected.map(n=>memories[n].id).sort());
  const actual=await new Search({DB:db},()=>at).query(token,'s1',entry.query,50,'search');
  assert.deepEqual(actual.results.map(r=>r.id).sort(),reference);
  assert.equal(expression,entry.expr,'The input group reaches the tsquery parser without losing marks or private-use characters');
 }finally{db.close();}
});

test('retained Unicode characters count toward the raw31-codepoint guard before metering or providers',async()=>{
 const {db,token}=await fixture();let calls=0;try{
  const search=new Search({DB:db,AI:{async run(){calls++;return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async query(){calls++;return{matches:[]};}}},()=>at);
  for(const query of [''.repeat(32),'\u{f0000}'.repeat(32),'a'+'́'.repeat(31),'क'+'ि'.repeat(31)]){
   await assert.rejects(()=>search.query(token,'s1',query,10,'oversized'),e=>e.status===400&&e.code==='search_token_too_long');
  }
  assert.equal(calls,0);assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,0);
  for(const query of [''.repeat(31),'\u{f0000}'.repeat(31),'a'+'́'.repeat(30)])assert.equal(ftsQuery(query),query+':*');
 }finally{db.close();}
});

test('Unicode groups keep the20-term cap, deduplication, and safe FTS quoting',()=>{
 const terms=Array.from({length:21},(_,n)=>'term'+n+'́');
 assert.equal(ftsQuery(terms[0]+' '+terms.join(' ')),terms.slice(0,20).map(term=>term+':*').join(' | '));
 assert.equal(ftsQuery('"project" OR "caféine"*'),'project:* | OR:* | caféine:*');
});
