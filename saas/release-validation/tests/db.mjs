import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { digest } from '../../src/release/util.ts';
import { sqliteClock } from '../../dev/sqlite-clock.mjs';
export const at=Date.UTC(2026,8,8,12);
export class DB {
  raw;
  constructor(clock=()=>at){this.raw=new DatabaseSync(':memory:'); this.setClock=sqliteClock(this.raw,clock); this.raw.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;'); for(const file of ['schema.sql','memory-schema.sql','product-schema.sql','auth-schema.sql','hierarchy-schema.sql']) this.raw.exec(readFileSync(new URL('../../'+file,import.meta.url),'utf8'));}
  migrate(through=21){for(const [version,source] of [[6,'release'],[7,'maintenance'],[8,'checkout'],[9,'job-progress'],[10,'protocol'],[11,'pagination'],[12,'lookup'],[13,'key-lookup'],[14,'tenant-queue'],[15,'workspace-lookup'],[16,'retrieval-progress'],[17,'vector-reconciliation'],[18,'outbound-share'],[19,'execution-time'],[20,'domain-verification'],[21,'domain-retention']])if(version<=through)this.raw.exec(readFileSync(new URL('../../migrations/'+String(version).padStart(4,'0')+'_'+source+'-schema.sql',import.meta.url),'utf8'));}
  prepare(sql){let values=[];const db=this;return {bind(...v){values=v;return this;},async first(){return db.raw.prepare(sql).get(...values)??null;},async all(){return {success:true,results:db.raw.prepare(sql).all(...values),meta:{}};},async run(){const r=db.raw.prepare(sql).run(...values);return {success:true,results:[],meta:{changes:Number(r.changes)}};}};}
  withSession(){return this;}
  async batch(statements){this.raw.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements){results.push(await s.all());}this.raw.exec('COMMIT');return results;}catch(e){this.raw.exec('ROLLBACK');throw e;}}
  close(){this.raw.close();}
}
export async function fixture({clock=()=>at}={}){
 const db=new DB(clock);db.migrate();
 const token='a'.repeat(64),other='b'.repeat(64),key='c'.repeat(64);
 db.raw.exec(`INSERT INTO accounts(id) VALUES('alice'),('bob'); INSERT INTO organizations(id) VALUES('org');
 INSERT INTO account_emails VALUES('e1','alice','alice@example.com','example.com',${at},NULL),('e2','bob','bob@example.com','example.com',${at},NULL);
 INSERT INTO memberships VALUES('m1','org','alice','e1','owner',9007199254740991,NULL),('m2','org','bob','e2','member',9007199254740991,NULL);`);
 for(const [id,account,t,kind] of [['session:alice','alice',token,'session'],['session:bob','bob',other,'session'],['key:alice','alice',key,'personal_key']]){
 db.raw.prepare('INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES(?,?,?,?,?,?,?)').run(id,account,kind,await digest(t),at+900000,at,'write');
 }
 db.raw.exec(`INSERT INTO spaces VALUES('s1','Personal','alice',NULL,'managed',${at},'session:alice'),('s2','Other','bob',NULL,'managed',${at},'session:bob'),('so','Team',NULL,'org','managed',${at},'session:alice');
 INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES('key:alice','["read","create"]','["s1"]');`);
 return {db,token,other,key};
}
