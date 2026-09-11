import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search,ftsQuery} from '../../src/release/search.ts';

// Compare the service parser with quoted Unicode61 input and inspect the real
// indexed tokens. Distractors make dropped characters visible as false hits.
const cases=[
 {name:'new-currency-symbol',query:'₿budget',bodies:['₿budget','budget'],tokens:['₿budget'],expected:[0]},
 {name:'new-emoji-prefix',query:'🫠alpha',bodies:['🫠alpha','alpha'],tokens:['🫠alpha'],expected:[0]},
 {name:'new-emoji-inside',query:'x🫠y',bodies:['x🫠y','xylophone','yellow'],tokens:['x🫠y'],expected:[0]},
 {name:'new-format-character',query:'a\u061cb',bodies:['a\u061cb','apple','banana'],tokens:['a\u061cb'],expected:[0]},
 {name:'new-punctuation-character',query:'a\u2e4fb',bodies:['a\u2e4fb','apple','banana'],tokens:['a\u2e4fb'],expected:[0]},
 {name:'new-combining-character',query:'a\u1ab0b',bodies:['a\u1ab0b','ab','apple','banana'],tokens:['a\u1ab0b'],expected:[0]},
 {name:'new-uppercase-case-preservation',query:'\u1c90bc',bodies:['\u1c90bc','\u10d0bc'],tokens:['\u1c90bc'],expected:[0]},
 {name:'new-supplementary-case-preservation',query:'\u{1e900}bc',bodies:['\u{1e900}bc','\u{1e922}bc'],tokens:['\u{1e900}bc'],expected:[0]},
 {name:'private-use-only',query:'\ue000',bodies:['\ue000','\ue000project','project'],tokens:['\ue000'],expected:[0,1]},
 {name:'private-use-prefix',query:'\ue000project',bodies:['\ue000project','project'],tokens:['\ue000project'],expected:[0]},
 {name:'private-use-inside',query:'x\ue000y',bodies:['x\ue000y','xylophone','yellow'],tokens:['x\ue000y'],expected:[0]},
 {name:'supplementary-private-use',query:'\u{f0000}project',bodies:['\u{f0000}project','project'],tokens:['\u{f0000}project'],expected:[0]},
 {name:'fullwidth',query:'ＡＢＣ',bodies:['ＡＢＣ','ABC'],tokens:['ａｂｃ'],expected:[0]},
 {name:'ligature',query:'ﬃ',bodies:['ﬃ','ffi'],tokens:['ﬃ'],expected:[0]},
 {name:'decomposed-Latin',query:'cafe\u0301ine',bodies:['cafe\u0301ine','cafeine','cafeteria','ineffable'],tokens:['cafeine'],expected:[0,1]},
 {name:'leading-mark',query:'\u0301cafe',bodies:['\u0301cafe','cafeteria','tea'],tokens:['cafe'],expected:[0,1]},
 {name:'mark-only',query:'\u0301',bodies:['\u0301','cafe'],tokens:[],expected:[]},
 {name:'Devanagari-marks',query:'किताब',bodies:['किताब','कम्बल','तारीख','बड़ा'],tokens:['क','त','ब'],expected:[0]},
 {name:'Hebrew-marks',query:'שָׁלוֹם',bodies:['שָׁלוֹם','שעה','לוח','ם'],tokens:['ש','לו','ם'],expected:[0]},
 {name:'Arabic-marks',query:'عَرَبِيّ',bodies:['عَرَبِيّ','عالم','رياض','بيت','يد'],tokens:['ع','ر','ب','ي'],expected:[0]},
 {name:'combining-grapheme-joiner',query:'a\u034fb',bodies:['a\u034fb','apple','banana'],tokens:['a','b'],expected:[0]},
 {name:'underscore',query:'foo_bar',bodies:['foo_bar','foo barista','foo something bar','foozoo'],tokens:['foo','bar'],expected:[0,1]},
];
for(const entry of cases)test('query preserves native Unicode61 semantics for '+entry.name,async()=>{
 const {db,token,other}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memories=[];
  for(const [n,body] of entry.bodies.entries())memories.push(await store.create(token,'s1',{body},'body-'+n));
  await store.create(other,'s2',{body:entry.query},'foreign');
  db.raw.exec("CREATE VIRTUAL TABLE unicode_tokens USING fts5vocab(release_fts,'instance')");
  const tokens=db.raw.prepare("SELECT term FROM unicode_tokens WHERE doc=(SELECT id FROM release_fts_rows WHERE memory_id=?) AND col='body' ORDER BY offset").all(memories[0].id).map(r=>r.term);
  assert.deepEqual(tokens,entry.tokens);
  const phrase='"'+entry.query.replaceAll('"','""')+'"*';
  const reference=db.raw.prepare('SELECT memory_id FROM release_fts WHERE release_fts MATCH ? AND space_id=?').all('tenant : "t7331" AND body : ('+phrase+')','s1').map(r=>r.memory_id).sort();
  assert.deepEqual(reference,entry.expected.map(n=>memories[n].id).sort());
  const actual=await new Search({DB:db},()=>at).query(token,'s1',entry.query,50,'search');
  assert.deepEqual(actual.results.map(r=>r.id).sort(),reference);
  assert.equal(ftsQuery(entry.query),phrase,'The input group reaches SQLite without losing marks or private-use characters');
 }finally{db.close();}
});

test('retained Unicode characters count toward the raw31-codepoint guard before metering or providers',async()=>{
 const {db,token}=await fixture();let calls=0;try{
  const search=new Search({DB:db,AI:{async run(){calls++;return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async query(){calls++;return{matches:[]};}}},()=>at);
  for(const query of ['\ue000'.repeat(32),'\u{f0000}'.repeat(32),'a'+'\u0301'.repeat(31),'क'+'ि'.repeat(31)]){
   await assert.rejects(()=>search.query(token,'s1',query,10,'oversized'),e=>e.status===400&&e.code==='search_token_too_long');
  }
  assert.equal(calls,0);assert.equal(db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,0);
  for(const query of ['\ue000'.repeat(31),'\u{f0000}'.repeat(31),'a'+'\u0301'.repeat(30)])assert.equal(ftsQuery(query),'"'+query+'"*');
 }finally{db.close();}
});

test('Unicode groups keep the20-term cap, deduplication, and safe FTS quoting',()=>{
 const terms=Array.from({length:21},(_,n)=>'\ue000term'+n+'\u0301');
 assert.equal(ftsQuery(terms[0]+' '+terms.join(' ')),terms.slice(0,20).map(term=>'"'+term+'"*').join(' OR '));
 assert.equal(ftsQuery('"\ue000project" OR "cafe\u0301ine"*'),'"\ue000project"* OR "OR"* OR "cafe\u0301ine"*');
});
