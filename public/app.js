'use strict';
/* Fonte: EA20 oficial/TSE. Pleito 3220. Eleições 6257 (1º turno) e 6258 (2º turno).
   Somente arquivos oficiais; nenhuma carga simulada ou de eleições anteriores é aceita.
   O mapa do IBGE está incorporado e não depende de uma biblioteca ou CDN externa. */
const TURN=/^\/primeiro-turno\/?$/.test(location.pathname)?'1':'2';
const ELECTION=TURN==='1'?'6257':'6258',CYCLE='ele2026',POLL=30000,STORE='apuracao-tse-2026-'+ELECTION+'-v2';
const BASE='https://resultados.tse.jus.br/oficial/'+CYCLE+'/'+ELECTION+'/dados/';
const UF=[['ac','Acre',-70,-9.2],['al','Alagoas',-36.7,-9.6],['ap','Amapá',-52,1.4],['am','Amazonas',-64,-4],['ba','Bahia',-41.8,-12.8],['ce','Ceará',-39.7,-4.2],['df','Distrito Federal',-47.8,-15.8],['es','Espírito Santo',-40.5,-19.5],['go','Goiás',-49.8,-16.4],['ma','Maranhão',-45.1,-5.3],['mt','Mato Grosso',-56.4,-12.3],['ms','Mato Grosso do Sul',-54.5,-20.4],['mg','Minas Gerais',-44.7,-18.3],['pa','Pará',-53.6,-3.5],['pb','Paraíba',-36.7,-7.1],['pr','Paraná',-51.9,-24.7],['pe','Pernambuco',-38.5,-8.4],['pi','Piauí',-42.8,-8],['rj','Rio de Janeiro',-42.8,-22.6],['rn','Rio Grande do Norte',-36.8,-5.7],['rs','Rio Grande do Sul',-53.4,-29.8],['ro','Rondônia',-62.7,-11.2],['rr','Roraima',-61.3,1.8],['sc','Santa Catarina',-50.5,-27.4],['sp','São Paulo',-49.4,-22.2],['se','Sergipe',-37.4,-10.6],['to','Tocantins',-48.3,-9.5]];
const NAMES=Object.fromEntries([['br','Brasil'],...UF.map(s=>[s[0],s[1]])]);
const REGIONS=[
 {id:'norte',name:'Norte',ufs:['ac','am','ap','pa','ro','rr','to']},
 {id:'nordeste',name:'Nordeste',ufs:['al','ba','ce','ma','pb','pe','pi','rn','se']},
 {id:'centro-oeste',name:'Centro-Oeste',ufs:['df','go','mt','ms']},
 {id:'sudeste',name:'Sudeste',ufs:['es','mg','rj','sp']},
 {id:'sul',name:'Sul',ufs:['pr','rs','sc']}
];
const CALLOUTS={rn:[752,110],pb:[752,190],pe:[752,270],al:[752,350],se:[752,430],es:[654,510],rj:[654,590],df:[752,665]};
const LABEL_POSITIONS={ma:[507,175],pi:[568,255],ba:[563,335],mg:[540,420],sp:[449,479],pr:[360,535],sc:[443,573],rs:[355,625]};
const state=new Map(),rawCache={},failed=new Set(),retryAfter=new Map();
let selected='br',mode='both',busy=false,hasRun=false,lastChecked=0,nextAt=0,timer=0,failures=0,cooldownUntil=0,completed=0;
const el=id=>document.getElementById(id),fmt=new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const percent=n=>Number.isFinite(n)?fmt.format(n)+'%':'—';
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const num=v=>{if(v===null||v===undefined||v==='')return null;const s=String(v).trim();const n=Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'):s);return Number.isFinite(n)?n:null;};
const bounded=v=>{const n=num(v);return n!==null&&n>=0&&n<=100?n:null;};
const integer=v=>{const n=num(v);return Number.isSafeInteger(n)&&n>=0?n:null;};
const source=uf=>BASE+uf+'/'+uf+'-c0001-e'+ELECTION.padStart(6,'0')+'-u.json';
const endpoint=uf=>'/api/resultados?turno='+TURN+'&uf='+encodeURIComponent(uf);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const localTime=t=>new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'America/Sao_Paulo'});
function parseResult(j,uf,checkedAt=Date.now()){
 if(!j||j.f!=='o'||String(j.ele)!==ELECTION||String(j.t)!==TURN||norm(j.cdabr)!==uf||j.tpabr!==(uf==='br'?'br':'uf'))throw new Error('Arquivo de outra eleição, fase ou abrangência.');
 if(j.dv!=='s')throw new Error('Divulgação ainda não autorizada pelo TSE.');
 if(!/^\d{2}\/\d{2}\/2026$/.test(j.dg||''))throw new Error('Data oficial não reconhecida.');
 const office=(j.carg||[]).find(c=>String(c.cd)==='1');if(!office)throw new Error('Cargo de presidente ausente.');
 const pending=j.and==='n';
 const candidates=(office.agr||[]).flatMap(a=>(a.par||[]).flatMap(p=>(p.cand||[]).map(c=>({...c,party:p.sg}))));
 const findCandidate=kind=>{const matches=candidates.filter(c=>{const name=norm(c.nmu)+' '+norm(c.nm);return kind==='lula'?String(c.n)==='13'&&/\blula\b/.test(name):String(c.n)==='22'&&/\bflavio\b/.test(name)&&/\bbolsonaro\b/.test(name)});if(matches.length!==1)return null;const c=matches[0];return{pct:pending?null:bounded(c.pvap),precise:pending?null:(bounded(c.pvapn)??bounded(c.pvap)),votes:pending?null:num(c.vap),destination:String(c.dvt||''),name:String(c.nmu||c.nm)};};
 return{uf,pending,lula:findCandidate('lula'),flavio:findCandidate('flavio'),counted:pending?null:bounded(j.s?.pst),sectionsTotal:integer(j.s?.ts),sectionsCounted:integer(j.s?.st),candidateVotesTotal:integer(j.v?.vvc),date:j.dg,time:j.hg,totalDate:j.dt,totalTime:j.ht,final:j.and==='f',checkedAt,idg:String(j.idg||'')};
}
function aggregateRegion(region,records){
 const rows=region.ufs.map(uf=>records.get(uf));
 const missing=region.ufs.filter((uf,i)=>!rows[i]);
 const result={missing,pending:rows.every(r=>r?.pending),received:rows.filter(Boolean).length,lula:null,flavio:null,counted:null,votesTotal:null,sectionsTotal:null,sectionsCounted:null};
 // Uma UF ausente nunca equivale a zero: evita mostrar uma parte como se fosse a região inteira.
 if(missing.length||result.pending)return result;
 if(rows.every(r=>integer(r.sectionsTotal)!==null&&integer(r.sectionsCounted)!==null&&r.sectionsCounted<=r.sectionsTotal)){
  result.sectionsTotal=rows.reduce((sum,r)=>sum+r.sectionsTotal,0);
  result.sectionsCounted=rows.reduce((sum,r)=>sum+r.sectionsCounted,0);
  if(result.sectionsTotal>0)result.counted=100*result.sectionsCounted/result.sectionsTotal;
 }
 // EA20: pvap usa votos a votáveis concorrentes (vvc), incluindo TODOS os candidatos.
 if(rows.every(r=>integer(r.candidateVotesTotal)!==null)){
  result.votesTotal=rows.reduce((sum,r)=>sum+r.candidateVotesTotal,0);
  if(result.votesTotal>0)for(const candidate of['lula','flavio']){
   if(rows.every(r=>r[candidate]&&integer(r[candidate].votes)!==null&&r[candidate].votes<=r.candidateVotesTotal))result[candidate]=100*rows.reduce((sum,r)=>sum+r[candidate].votes,0)/result.votesTotal;
  }
 }
 return result;
}
function isStale(uf){const r=state.get(uf);return !!r&&(failed.has(uf)||Date.now()-r.checkedAt>120000);}
function status(kind,message){el('connection').dataset.kind=kind;el('connection-text').textContent=message;}
function notify(message){el('notice').hidden=!message;el('notice').textContent=message||'';}
function text(id,s){el(id).textContent=s;}
function createSVG(tag,attrs,parent){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);parent.appendChild(n);return n;}
function point(lon,lat){return[16+(lon+73.9833)*17,16+(5.2718-lat)*17];}
function initMap(){
 const paths=JSON.parse(el('map-data').textContent);
 for(const[uf,name,lon,lat]of UF){
  const shape=createSVG('path',{id:'shape-'+uf,d:paths[uf],class:'state','data-uf':uf},el('state-shapes'));
  createSVG('title',{},shape).textContent=name;
  let[x,y]=point(lon,lat);const to=CALLOUTS[uf];
  if(to){createSVG('path',{d:`M${x} ${y}L${to[0]-48} ${to[1]}L${to[0]-40} ${to[1]}`,class:'map-line'},el('map-lines'));[x,y]=to;}
  if(LABEL_POSITIONS[uf])[x,y]=LABEL_POSITIONS[uf];
  const label=createSVG('g',{id:'label-'+uf,transform:`translate(${x} ${y})`,class:'map-label','data-uf':uf,role:'button',tabindex:'0','aria-label':name},el('map-labels'));
  createSVG('rect',{x:-41,y:-30,width:82,height:74,rx:8,class:'label-box'},label);
  createSVG('text',{x:0,y:-15,'text-anchor':'middle',class:'label-uf'},label).textContent=uf.toUpperCase();
  createSVG('text',{x:0,y:2,'text-anchor':'middle',class:'label-percent label-lula',id:'map-lula-'+uf},label).textContent='L —';
  createSVG('text',{x:0,y:19,'text-anchor':'middle',class:'label-percent label-flavio',id:'map-flavio-'+uf},label).textContent='F —';
  createSVG('text',{x:0,y:36,'text-anchor':'middle',class:'label-counted',id:'map-counted-'+uf},label).textContent='AP. —';
  for(const target of[shape,label])target.addEventListener('click',()=>selectState(uf));
  label.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectState(uf);}});
 }
}
function initList(){
 for(const[uf,name]of UF){
  const option=document.createElement('option');option.value=uf;option.textContent=name+' · '+uf.toUpperCase();el('state-select').appendChild(option);
  const card=document.createElement('button');card.type='button';card.className='state-card';card.id='card-'+uf;card.dataset.uf=uf;card.setAttribute('aria-pressed','false');
  card.innerHTML='<div class="state-card-top"><span class="state-name"></span><span class="uf-chip"></span></div><div class="state-pair"><div class="red"><span>LULA</span><strong id="list-lula-'+uf+'">—</strong></div><div class="blue"><span>FLÁVIO</span><strong id="list-flavio-'+uf+'">—</strong></div></div><div class="state-counted"><span>Urnas apuradas</span><strong id="list-counted-'+uf+'">—</strong></div><div class="counted-track" aria-hidden="true"><div id="counted-bar-'+uf+'"></div></div><div class="state-meta" id="meta-'+uf+'">Aguardando TSE</div>';
  card.querySelector('.state-name').textContent=name;card.querySelector('.uf-chip').textContent=uf.toUpperCase();card.addEventListener('click',()=>{selectState(uf);el('detail-name').scrollIntoView({behavior:'smooth',block:'center'});});el('states-grid').appendChild(card);
 }
}
function initRegions(){
 for(const region of REGIONS){
  const card=document.createElement('article');card.className='region-card';card.id='region-'+region.id;card.setAttribute('aria-labelledby','region-name-'+region.id);
  card.innerHTML='<div class="region-head"><h3 id="region-name-'+region.id+'"></h3><span class="region-size"></span></div><div class="region-metrics"><div class="region-candidate red"><span class="region-label">Lula</span><strong class="region-value" id="region-lula-'+region.id+'">—</strong></div><div class="region-candidate blue"><span class="region-label">Flávio Bolsonaro</span><strong class="region-value" id="region-flavio-'+region.id+'">—</strong></div><div class="region-progress"><div class="region-progress-head"><span>Urnas apuradas</span><strong id="region-counted-'+region.id+'">—</strong></div><div class="counted-track" aria-hidden="true"><div id="region-bar-'+region.id+'"></div></div></div></div><p class="region-status" id="region-status-'+region.id+'">Aguardando os estados</p><p class="region-time" id="region-time-'+region.id+'"></p><p class="region-states"></p>';
  card.querySelector('h3').textContent=region.name;card.querySelector('.region-size').textContent=region.ufs.length+' UFs';card.querySelector('.region-states').textContent=region.ufs.map(uf=>uf.toUpperCase()).join(' · ');el('regions-grid').appendChild(card);
 }
}
function renderRegions(){
 for(const region of REGIONS){
  const r=aggregateRegion(region,state),stale=region.ufs.filter(uf=>isStale(uf)),rows=region.ufs.map(uf=>state.get(uf)).filter(Boolean),card=el('region-'+region.id),statusEl=el('region-status-'+region.id);
  for(const key of['lula','flavio','counted'])text('region-'+key+'-'+region.id,percent(r[key]));
  el('region-bar-'+region.id).style.width=(r.counted??0)+'%';card.classList.toggle('stale',stale.length>0);
  let message,kind;
  if(r.missing.length){message='Aguardando '+r.missing.map(uf=>uf.toUpperCase()).join(', ')+' · '+r.received+'/'+region.ufs.length+' UFs';kind='wait';}
  else if(stale.length){message='Dados anteriores em '+stale.map(uf=>uf.toUpperCase()).join(', ');kind='warn';}
  else if(r.pending){message='Aguardando início da apuração';kind='wait';}
  else if(r.votesTotal===0){message='Ainda sem votos divulgados';kind='wait';}
  else if([r.lula,r.flavio,r.counted].some(n=>n===null)){message='Aguardando totais completos do TSE';kind='wait';}
  else{message=rows.every(row=>row.final)?'Totalização final nas UFs':'Apuração parcial · '+region.ufs.length+'/'+region.ufs.length+' UFs';kind='ok';}
  statusEl.textContent=message;statusEl.dataset.kind=kind;
  const ordered=rows.slice().sort((a,b)=>(a.date.split('/').reverse().join('-')+'T'+a.time).localeCompare(b.date.split('/').reverse().join('-')+'T'+b.time));
  if(ordered.length){const first=ordered[0],last=ordered[ordered.length-1];text('region-time-'+region.id,'Horários TSE: '+(first.date===last.date?(first.time===last.time?first.time:first.time+'–'+last.time):first.date+' '+first.time+' a '+last.date+' '+last.time));}
  else text('region-time-'+region.id,'Horários TSE: aguardando');
 }
}
function selectState(uf){if(!(uf in NAMES))return;selected=uf;el('state-select').value=uf;render();}
function fillFor(uf){
 const r=state.get(uf);if(!r||isStale(uf))return 'url(#no-data)';
 if(r.pending)return 'var(--map-empty)';
 const l=r.lula?.pct,f=r.flavio?.pct;
 if(mode==='both'){
  if(!Number.isFinite(l)||!Number.isFinite(f))return 'var(--map-empty)';
  const lv=r.lula?.votes,fv=r.flavio?.votes,compare=Number.isFinite(lv)&&Number.isFinite(fv)?lv-fv:l-f;
  return compare>0?'var(--red)':compare<0?'var(--blue)':'var(--map-empty)';
 }
 const value=mode==='lula'?l:f;
 return !Number.isFinite(value)?'var(--map-empty)':mode==='lula'?'var(--red)':'var(--blue)';
}
function render(){
 const br=state.get('br');
 for(const c of['lula','flavio']){text('national-'+c,percent(br?.[c]?.pct));el('bar-'+c).style.width=(br?.[c]?.pct??0)+'%';const destination=br?.[c]?.destination;el('dest-'+c).hidden=!destination||norm(destination)==='valido';text('dest-'+c,destination||'');}
 text('national-counted',percent(br?.counted));el('national-progress').style.width=(br?.counted??0)+'%';
 text('national-stage',br?(isStale('br')?'Dados anteriores':br.pending?'Aguardando início da apuração':br.final?'Totalização final no TSE':'Apuração parcial'):'Aguardando consulta');
 text('national-time',br?'TSE · '+br.date+' '+br.time:'Horário do TSE: aguardando');
 for(const[uf,name]of UF){
  const r=state.get(uf),stale=isStale(uf),chosen=uf===selected;
  el('shape-'+uf).style.fill=fillFor(uf);el('shape-'+uf).classList.toggle('selected',chosen);el('label-'+uf).classList.toggle('selected',chosen);
  for(const c of['lula','flavio']){const n=el('map-'+c+'-'+uf);n.textContent=(mode==='both'?(c==='lula'?'L ':'F '):'')+percent(r?.[c]?.pct);n.style.display=mode==='both'||mode===c?'':'none';n.setAttribute('y',mode==='both'?(c==='lula'?2:19):12);text('list-'+c+'-'+uf,percent(r?.[c]?.pct));}
  text('map-counted-'+uf,'AP. '+percent(r?.counted));text('list-counted-'+uf,percent(r?.counted));el('counted-bar-'+uf).style.width=(r?.counted??0)+'%';
  const label=name+(r?.pending?': aguardando início da apuração. ':': ')+'Lula '+percent(r?.lula?.pct)+', Flávio '+percent(r?.flavio?.pct)+', urnas apuradas '+percent(r?.counted)+(stale?', dados anteriores':'');el('label-'+uf).setAttribute('aria-label',label);
  el('card-'+uf).setAttribute('aria-label',label);el('card-'+uf).setAttribute('aria-pressed',String(chosen));el('card-'+uf).classList.toggle('stale',stale);
  text('meta-'+uf,r?(stale?'Dados anteriores · ':r.pending?'Aguardando apuração · ':'TSE · ')+r.time.slice(0,5):failed.has(uf)?'Sem atualização · tentando novamente':'Aguardando TSE');
 }
 const r=state.get(selected);text('detail-name',NAMES[selected]);for(const c of['lula','flavio'])text('detail-'+c,percent(r?.[c]?.pct));
 text('detail-counted','Urnas apuradas: '+percent(r?.counted));text('detail-time',r?'TSE: '+r.date+' '+r.time:'TSE: aguardando');
 const missing=r&&(!r.lula||!r.flavio);text('detail-state',r?(isStale(selected)?'Dados anteriores — atualização pendente':r.pending?'Aguardando início da apuração':missing?'Candidato não localizado no arquivo':r.final?'Totalização final desta abrangência':'Resultado parcial'):'Aguardando dados oficiais');el('detail-state').classList.toggle('stale-mark',isStale(selected));
 const destinations=['lula','flavio'].filter(c=>r?.[c]?.destination&&norm(r[c].destination)!=='valido').map(c=>(c==='lula'?'Lula: ':'Flávio: ')+r[c].destination).join(' · ');text('detail-dest',destinations);el('detail-dest').hidden=!destinations;
 el('detail-source').href=source(selected);
 text('map-legend',mode==='both'?'Cor = liderança entre os dois · cinza = empate ou sem apuração':'Cor = candidato selecionado · percentual nos rótulos');
 renderRegions();
}
function restore(){try{const data=JSON.parse(localStorage.getItem(STORE)||'null');if(!data||data.election!==ELECTION)return;for(const[uf,entry]of Object.entries(data.files||{})){if(!(uf in NAMES)||Date.now()-entry.checkedAt>86400000)continue;const r=parseResult(entry.raw,uf,entry.checkedAt);state.set(uf,r);rawCache[uf]=entry;failed.add(uf);}}catch(e){/* O armazenamento local é opcional. */}}
function save(){try{localStorage.setItem(STORE,JSON.stringify({election:ELECTION,files:rawCache}));}catch(e){/* Alguns visualizadores não oferecem armazenamento. */}}
async function fetchState(uf){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),14000);
 try{
  const response=await fetch(endpoint(uf),{credentials:'same-origin',cache:'no-cache',referrerPolicy:'no-referrer',signal:controller.signal});
  if(response.status===403||response.status===429){const retry=Number(response.headers.get('Retry-After'));cooldownUntil=Date.now()+(Number.isFinite(retry)&&retry>0?retry*1000:610000);throw new Error('Acesso temporariamente limitado pelo TSE.');}
  if(response.status===404){retryAfter.set(uf,Date.now()+180000);throw new Error('Arquivo ainda não disponível.');}
  if(!response.ok)throw new Error('TSE HTTP '+response.status);
  const raw=await response.json(),now=Date.now(),serverCheckedAt=Number(response.headers.get('X-Data-Checked-At')),checkedAt=Number.isFinite(serverCheckedAt)&&serverCheckedAt>0&&serverCheckedAt<=now+60000?serverCheckedAt:now,r=parseResult(raw,uf,checkedAt);
  state.set(uf,r);rawCache[uf]={raw,checkedAt};failed.delete(uf);retryAfter.delete(uf);return true;
 }catch(e){failed.add(uf);return false;}finally{clearTimeout(timeout);completed++;}
}
function schedule(ms){clearTimeout(timer);nextAt=Date.now()+ms;if(!document.hidden)timer=setTimeout(refresh,ms);}
async function refresh(){
 if(busy||document.hidden)return;
 if(cooldownUntil>Date.now()){schedule(cooldownUntil-Date.now());status('warn','Consulta temporariamente pausada');notify('O TSE limitou temporariamente as consultas. A próxima tentativa será automática.');tick();return;}
 if(!navigator.onLine){failed.clear();for(const k of state.keys())failed.add(k);hasRun=true;status('warn','Sem conexão');notify('Sem internet. Os números disponíveis são da última consulta. Reconecte para atualizar.');render();schedule(POLL);return;}
 busy=true;completed=0;clearTimeout(timer);el('refresh').disabled=true;status('busy','Consultando o TSE');notify('');
 const started=Date.now(),queue=['br',...UF.map(s=>s[0])].filter(uf=>(retryAfter.get(uf)||0)<=Date.now());let ok=0;
 try{
  for(let i=0;i<queue.length;i+=4){if(cooldownUntil>Date.now())break;const results=await Promise.all(queue.slice(i,i+4).map(fetchState));ok+=results.filter(Boolean).length;render();text('poll-status','Consultando o TSE · '+completed+'/'+queue.length);if(i+4<queue.length)await delay(300);}
  hasRun=true;lastChecked=Date.now();failures=ok?0:failures+1;save();
  const unavailable=UF.filter(([uf])=>!state.has(uf)||isStale(uf)).length;
  if(cooldownUntil>Date.now()){status('warn','Consulta temporariamente pausada');notify('O TSE limitou temporariamente as consultas. A próxima tentativa será automática.');}
  else if(!ok){status('warn','Atualização indisponível');notify('Não foi possível atualizar os arquivos do TSE. '+(state.size?'Os números exibidos são de consultas anteriores. ':'Nenhum percentual será estimado. ')+'Verifique sua conexão. Uma nova tentativa será automática.');}
  else if(unavailable||!state.has('br')||isStale('br')){status('warn','Atualização parcial');notify((unavailable?unavailable+' UF(s) ainda sem atualização. ':'')+'Os estados sem dados recentes ficam hachurados. Os horários disponíveis aparecem em cada consulta.');}
  else if(state.get('br')?.pending){status('ok','Aguardando apuração');notify('O TSE ainda não iniciou a apuração do '+TURN+'º turno. Os percentuais aparecerão assim que os resultados oficiais forem divulgados.');}
  else{status('ok','Dados recebidos do TSE');notify('');}
 }finally{
  busy=false;el('refresh').disabled=false;render();const wait=cooldownUntil>Date.now()?cooldownUntil-Date.now():Math.max(1000,(failures?Math.min(300000,POLL*2**Math.min(failures,4)):POLL)-(Date.now()-started));schedule(wait);tick();
 }
}
function tick(){
 if(busy)return;
 const remaining=Math.max(0,Math.ceil((nextAt-Date.now())/1000));
 text('poll-status',document.hidden?'Atualização pausada em segundo plano':cooldownUntil>Date.now()?'Nova tentativa em '+Math.ceil(remaining/60)+' min':nextAt?'Próxima consulta em '+remaining+' s':'Preparando a consulta');
 text('checked-time',lastChecked?'Última tentativa: '+localTime(lastChecked)+' · Brasília':'Atualização automática a cada 30 segundos');
 el('refresh').disabled=cooldownUntil>Date.now();
}
const themeControl=el('theme-toggle');
function syncThemeControl(){const dark=document.documentElement.dataset.theme==='dark';themeControl.setAttribute('aria-pressed',String(dark));themeControl.querySelector('.theme-status').textContent=dark?'Ativo':'Inativo';}
themeControl.addEventListener('click',()=>{window.electionTheme.set(document.documentElement.dataset.theme==='dark'?'light':'dark');syncThemeControl();});
window.addEventListener('election-theme-change',syncThemeControl);syncThemeControl();
initMap();initList();initRegions();restore();render();
el('state-select').addEventListener('change',e=>selectState(e.target.value));
el('refresh').addEventListener('click',()=>{if(!busy&&Date.now()-lastChecked>5000)refresh();});
for(const b of document.querySelectorAll('[data-mode]'))b.addEventListener('click',()=>{mode=b.dataset.mode;for(const c of document.querySelectorAll('[data-mode]'))c.setAttribute('aria-pressed',String(c===b));render();});
el('zoom').addEventListener('click',()=>{const zoomed=el('map-canvas').classList.toggle('zoomed');el('zoom').setAttribute('aria-pressed',String(zoomed));text('zoom',zoomed?'Reduzir −':'Ampliar +');text('map-help',zoomed?'Arraste para explorar. Toque em uma UF para consultar.':'Toque em uma UF para ver os dois percentuais.');if(!zoomed){el('map-scroll').scrollLeft=0;el('map-scroll').scrollTop=0;}});
el('search').addEventListener('input',e=>{const query=norm(e.target.value);let shown=0;for(const[uf,name]of UF){const visible=norm(name+' '+uf).includes(query);el('card-'+uf).hidden=!visible;if(visible)shown++;}el('no-match').hidden=shown>0;});
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(document.hidden){tick();return;}render();if(Date.now()-lastChecked>=POLL||!hasRun)refresh();else schedule(Math.max(1000,nextAt-Date.now()));});
window.addEventListener('online',()=>{if(cooldownUntil<=Date.now())refresh();});
window.addEventListener('offline',()=>{for(const k of state.keys())failed.add(k);status('warn','Sem conexão');notify('Sem internet. Os números exibidos são da última consulta disponível.');render();});
setInterval(tick,1000);refresh();
