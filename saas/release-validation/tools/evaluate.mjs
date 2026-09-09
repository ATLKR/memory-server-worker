#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function evaluate(cases,responses,k=5){
 if(!Number.isInteger(k)||k<1||k>50)throw Error('k must be 1–50');
 const byId=new Map(responses.map(x=>[x.caseId,x]));if(byId.size!==responses.length)throw Error('Duplicate case responses');
 const known=new Set(cases.map(x=>x.id));if(known.size!==cases.length||responses.some(x=>!known.has(x.caseId)))throw Error('Duplicate or unknown case IDs');
 let positives=0,recall=0,mrr=0,forbiddenHits=0,staleHits=0,negativeFalsePositives=0;const latencies=[];
 for(const c of cases){const r=byId.get(c.id);if(!r)continue;if(!Array.isArray(r.results))throw Error('Invalid result list');
  const ids=r.results.map(x=>typeof x==='string'?x:x?.id);if(ids.some(x=>typeof x!=='string'))throw Error('Invalid result ID');
  const top=ids.slice(0,k);forbiddenHits+=ids.filter(x=>(c.forbiddenIds??[]).includes(x)).length;staleHits+=ids.filter(x=>(c.staleIds??[]).includes(x)).length;
  if(c.expectedIds.length){positives++;recall+=c.expectedIds.filter(x=>top.includes(x)).length/c.expectedIds.length;const rank=top.findIndex(x=>c.expectedIds.includes(x));mrr+=rank<0?0:1/(rank+1);}else if(ids.length)negativeFalsePositives++;
  if(typeof r.latencyMs==='number'&&Number.isFinite(r.latencyMs)&&r.latencyMs>=0)latencies.push(r.latencyMs);
 }
 latencies.sort((a,b)=>a-b);
 return {cases:cases.length,evaluated:responses.length,complete:responses.length===cases.length,k,recallAtK:positives?recall/positives:null,meanReciprocalRank:positives?mrr/positives:null,forbiddenHits,staleHits,negativeFalsePositives,p95LatencyMs:latencies.length?latencies[Math.ceil(latencies.length*0.95)-1]:null,notice:'Metrics apply only to the supplied responses. No live search was run by this scorer.'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const input=process.argv.slice(2);if(input.length!==2)throw Error('Usage: node tools/evaluate.mjs CASES.jsonl RESPONSES.jsonl');
 const parse=x=>x.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));console.log(JSON.stringify(evaluate(parse(await readFile(input[0],'utf8')),parse(await readFile(input[1],'utf8'))),null,2));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
