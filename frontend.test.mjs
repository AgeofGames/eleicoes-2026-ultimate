import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('./public/app.js',import.meta.url),'utf8');
const theme=readFileSync(new URL('./public/theme-init.js',import.meta.url),'utf8');

// Exercise the production parser and calculations without starting UI or network work.
function loadApp(pathname='/'){
 const context=vm.createContext({location:{pathname},Intl,Date,Map,Set});
 vm.runInContext(app.slice(0,app.indexOf("const themeControl=el('theme-toggle');"))+`
 globalThis.subject={parseResult,aggregateRegion,fillFor,percent,source,endpoint,TURN,ELECTION,STORE,state,failed,setMode(value){mode=value;}};
 `,context);
 return context.subject;
}

// These fixtures are test-only and are never shipped as public election data.
function official({uf='br',turn='2',status='p',lula=60,flavio=40,sections=100,counted=50}={}){
 const votes=lula+flavio;
 return {
  f:'o',ele:turn==='1'?'6257':'6258',t:turn,cdabr:uf,tpabr:uf==='br'?'br':'uf',dv:'s',
  dg:'25/10/2026',hg:'18:05:00',dt:'25/10/2026',ht:'18:05:00',and:status,
  s:{pst:String(100*counted/sections),ts:String(sections),st:String(counted)},v:{vvc:String(votes)},
  carg:[{cd:'1',agr:[{par:[
   {sg:'PT',cand:[{n:'13',nmu:'LULA',nm:'Luiz Inácio Lula da Silva',pvap:String(100*lula/votes),vap:String(lula),dvt:'Válido'}]},
   {sg:'PL',cand:[{n:'22',nmu:'FLAVIO BOLSONARO',nm:'Flávio Bolsonaro',pvap:String(100*flavio/votes),vap:String(flavio),dvt:'Válido'}]}
  ]}]}]
 };
}

test('second-round pending files never become zero-percent results',()=>{
 const app=loadApp();
 const raw=official({status:'n',lula:0,flavio:0,counted:0});
 for(const party of raw.carg[0].agr[0].par)party.cand[0].pvap='0,00';
 const result=app.parseResult(raw,'br');
 assert.equal(app.ELECTION,'6258');
 assert.equal(result.pending,true);
 assert.equal(result.lula.pct,null);
 assert.equal(result.flavio.pct,null);
 assert.equal(result.counted,null);
 assert.equal(app.percent(result.lula.pct),'—');
 app.state.set('br',result);
 assert.equal(app.fillFor('br'),'var(--map-empty)');
});

test('parser rejects another round, year, or unpublished results',()=>{
 const app=loadApp();
 assert.throws(()=>app.parseResult(official({turn:'1'}),'br'),/outra eleição/);
 assert.throws(()=>app.parseResult({...official(),ele:'545',dg:'30/10/2022'},'br'),/outra eleição/);
 assert.throws(()=>app.parseResult({...official(),dg:'30/10/2022'},'br'),/Data oficial/);
 assert.throws(()=>app.parseResult({...official(),dv:'n'},'br'),/não autorizada/);
});

test('first-round route has independent election, source, API query and cache',()=>{
 const first=loadApp('/primeiro-turno'),second=loadApp('/');
 assert.equal(first.TURN,'1');
 assert.equal(first.ELECTION,'6257');
 assert.notEqual(first.STORE,second.STORE);
 assert.match(first.source('br'),/6257\/dados\/br\/br-c0001-e006257-u\.json$/);
 assert.equal(first.endpoint('sp'),'/api/resultados?turno=1&uf=sp');
 assert.equal(first.parseResult(official({turn:'1'}),'br').lula.pct,60);
});

test('map colors follow vote leadership and preserve solid candidate colors',()=>{
 const app=loadApp();
 app.state.set('ac',app.parseResult(official({uf:'ac',lula:51,flavio:49}),'ac'));
 app.state.set('am',app.parseResult(official({uf:'am',lula:20,flavio:80}),'am'));
 app.state.set('ap',app.parseResult(official({uf:'ap',lula:50,flavio:50}),'ap'));
 assert.equal(app.fillFor('ac'),'var(--red)');
 assert.equal(app.fillFor('am'),'var(--blue)');
 assert.equal(app.fillFor('ap'),'var(--map-empty)');
 app.setMode('lula');
 assert.equal(app.fillFor('am'),'var(--red)');
 app.setMode('flavio');
 assert.equal(app.fillFor('ac'),'var(--blue)');
 app.failed.add('ac');
 assert.equal(app.fillFor('ac'),'url(#no-data)');
 assert.equal(app.fillFor('zz'),'url(#no-data)');
});

test('regional percentages use weighted totals and require every state',()=>{
 const app=loadApp(),region={ufs:['ac','am']};
 const records=new Map([
  ['ac',app.parseResult(official({uf:'ac',lula:80,flavio:20,sections:100,counted:50}),'ac')],
  ['am',app.parseResult(official({uf:'am',lula:120,flavio:780,sections:900,counted:900}),'am')]
 ]);
 const result=app.aggregateRegion(region,records);
 assert.equal(result.lula,20);
 assert.equal(result.flavio,80);
 assert.equal(result.counted,95);
 records.delete('am');
 const incomplete=app.aggregateRegion(region,records);
 assert.equal(incomplete.lula,null);
 assert.equal(incomplete.flavio,null);
 assert.equal(incomplete.counted,null);
 assert.deepEqual(Array.from(incomplete.missing),['am']);
});

test('a wholly pending region shows no percentages',()=>{
 const app=loadApp(),region={ufs:['ac','am']};
 const records=new Map(region.ufs.map(uf=>[uf,app.parseResult(official({uf,status:'n',counted:0} ),uf)]));
 const result=app.aggregateRegion(region,records);
 assert.equal(result.pending,true);
 for(const metric of ['lula','flavio','counted'])assert.equal(result[metric],null);
});

function loadTheme({saved=null,systemDark=false,storageFails=false}={}){
 const storage=new Map(saved?[['eleicoes-2026-ultimate-theme',saved]]:[]);
 const mediaListeners=new Map(),windowListeners=new Map();
 const root={dataset:{},style:{}},meta={content:''};
 const context={
  document:{documentElement:root,querySelector:()=>meta},
  localStorage:{getItem(key){if(storageFails)throw Error('storage blocked');return storage.get(key)??null;},setItem(key,value){if(storageFails)throw Error('storage blocked');storage.set(key,value);}},
  window:{matchMedia:()=>({matches:systemDark,addEventListener:(name,cb)=>mediaListeners.set(name,cb)}),addEventListener:(name,cb)=>windowListeners.set(name,cb),dispatchEvent(){}},
  Event:class {constructor(type){this.type=type;}}
 };
 vm.runInNewContext(theme,context);
 return {root,meta,storage,mediaListeners,windowListeners,control:context.window.electionTheme};
}

test('theme follows the system by default, then persists an explicit selection',()=>{
 const theme=loadTheme({systemDark:true});
 assert.equal(theme.root.dataset.theme,'dark');
 theme.mediaListeners.get('change')({matches:false});
 assert.equal(theme.root.dataset.theme,'light');
 theme.control.set('dark');
 assert.equal(theme.storage.get('eleicoes-2026-ultimate-theme'),'dark');
 assert.equal(theme.meta.content,'#101722');
 theme.mediaListeners.get('change')({matches:false});
 assert.equal(theme.root.dataset.theme,'dark');
 assert.equal(loadTheme({saved:'light',systemDark:true}).root.dataset.theme,'light');
});

test('theme remains usable with blocked browser storage',()=>{
 const theme=loadTheme({storageFails:true});
 theme.control.set('dark');
 assert.equal(theme.root.dataset.theme,'dark');
});
