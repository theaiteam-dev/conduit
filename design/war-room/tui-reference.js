// War Room TUI cell-grid reference, exported from the Claude Design "War Room TUI" page (2026-09-28).
// Design reference only: this is the mock scenario and the drawing rules the design used, one glyph +
// one foreground + one background + bold flag per cell on a 160x45 grid. The real TUI renders from the
// journal projection with @opentui/react; use this for layout, colors, glyph choices, and golden frames.

const W=160,H=45,CPX=7.2;
const BG='#000000',FG='#E2E8F0',MU='#94A3B8',DI='#5B6475',BD='#2F3542',DOT='#3A4150',SEL='#0F1018',BAR='#141824',NRB='#1A1E27';
const G='#3BE37A',AM='#F5B940',CO='#FF6B6B',CY='#00BFFF',TRK='#7B8599',B=144,THR=12;
const ST=[['decompose','#E8967A','#744B3D','#462D25'],['test','#EC4F8E','#762847','#47182B'],['implement','#9D6CF5','#4F367B','#2F204A'],['review','#4C7BF4','#263E7A','#172549'],['probe','#00BFFF','#006080','#00394D'],['deliver','#2DD4BF','#176A60','#0E4039']];
const TOOL={Read:['#343B4A',FG],Grep:['#566078',FG],Edit:[FG,'#000000'],Bash:['#8A94A7','#000000']};
const LB=['','▏','▎','▍','▌','▋','▊','▉'];
const pad=n=>String(n).padStart(2,'0');
const clk=m=>{const s=Math.round(m*60),h=Math.floor(s/3600),mm=Math.floor(s%3600/60),ss=s%60;return h?`${h}:${pad(mm)}:${pad(ss)}`:`${pad(mm)}:${pad(ss)}`;};
const adj=m=>Number.isInteger(m)?m+((m*37+11)%60)/60:m;
const ev=m=>clk(adj(m));
const PE=(s,n)=>s.length>=n?s:s+' '.repeat(n-s.length);
const CARDS=[
 {id:'PRD-014',t:'range-queries',v:[[0,0,6],[5,127,134]],done:134},
 {id:'WI-201',t:'range-schema',v:[[1,6,10],[2,10,17],[3,17,20],[4,20,22.6],[5,22.6,25]],done:25},
 {id:'WI-202',t:'cli-flags',v:[[1,6.5,11],[2,11,20],[3,20,22.8],[4,22.8,27],[5,27,29]],done:29},
 {id:'WI-203',t:'date-parse',v:[[1,7,12],[2,12,22],[3,22,26],[4,26,31],[5,31,34]],done:34},
 {id:'WI-204',t:'parse-range',v:[[1,7,11],[2,11,19],[3,19,22,'R'],[2,22,29],[3,29,32,'R'],[2,32,52],[3,52,55],[4,55,60],[5,60,64]],done:64},
 {id:'WI-205',t:'index-scan',v:[[1,12,17],[2,17,31],[3,31,35],[4,35,49],[5,49,53]],done:53},
 {id:'WI-206',t:'query-planner',v:[[1,14,19],[2,19,38],[3,38,50,'R'],[2,50,68],[3,68,72],[4,72,78],[5,78,82]],done:82},
 {id:'WI-207',t:'legacy-shim',v:[[1,8,12],[2,12,30]],scrap:30,reason:'no_progress'},
 {id:'WI-208',t:'docs-ranges',v:[[1,9,13],[2,13,26],[3,26,30],[4,30,36],[5,44,49]],done:49},
 {id:'WI-209',t:'migration-0042',v:[[1,9,14],[2,14,24],[3,24,27],[4,27,29],[5,121,126]],held:[29,121,53],hr:'human decision · approve migration 0042',hs:'human decision',done:126},
 {id:'WI-210',t:'perf-bench',v:[[1,16,21],[2,48,70],[3,70,74],[4,74,80,'R'],[2,80,95],[3,95,101],[4,101,118],[5,118,122]],done:122},
 {id:'WI-211',t:'e2e-suite',v:[[1,50,56],[2,56,84],[3,84,88,'R'],[2,88,109],[3,109,113],[4,113,120],[5,120,125]],done:125},
];
const CALLS=[['Read','src/range.ts'],['Read','test/range.test.ts'],['Grep','"parseRange" src/'],['Read','src/cli/args.ts'],['Edit','src/range.ts'],['Bash','npm test -- range',1],['Read','src/range.ts'],['Grep','"Number.isNaN" src/'],['Edit','src/range.ts'],['Bash','npm test -- range',0],['Read','test/fixtures/ranges.json'],['Edit','test/range.test.ts'],['Bash','npm test -- range',1],['Read','test/range.test.ts'],['Edit','test/range.test.ts'],['Bash','npm test -- range',0],['Grep','"parseRange(" src/'],['Read','src/cli/args.ts'],['Edit','src/cli/args.ts'],['Bash','npx tsc --noEmit',2],['Read','src/cli/args.ts'],['Edit','src/cli/args.ts'],['Bash','npx tsc --noEmit',null]];
const DUR=[3,2,1,4,6,41,2,1,5,38,2,7,44,3,5,39,1,2,6,12,2,4,null];
const dur=s=>Math.floor(s/60)+':'+pad(s%60);
function stateOf(c,t){
 if(c.scrap!=null&&c.scrap<=t)return{s:'scrap'};
 if(c.done!=null&&c.done<=t)return{s:'done'};
 if(c.held&&c.held[0]<=t&&c.held[1]>t)return{s:'held'};
 const cur=c.v.find(v=>v[1]<=t&&v[2]>t);if(cur)return{s:'work',cur};
 return{s:'wait'};
}
class Grid{
 constructor(){this.c=[];for(let y=0;y<H;y++){const r=[];for(let x=0;x<W;x++)r.push({ch:' ',fg:MU,bg:BG,b:0});this.c.push(r);}}
 get(x,y){return this.c[y]&&this.c[y][x];}
 put(x,y,ch,fg,bg,b){const c=this.get(x,y);if(!c)return;c.ch=ch;if(fg!=null)c.fg=fg;if(bg!=null)c.bg=bg;if(b!=null)c.b=b;}
 t(x,y,s,fg,bg,b){const a=[...s];a.forEach((ch,i)=>this.put(x+i,y,ch,fg,bg,b==null?0:b));return x+a.length;}
 bgr(x0,x1,y,bg){for(let x=x0;x<=x1;x++){const c=this.get(x,y);if(c)c.bg=bg;}}
 segs(x,y,list){list.forEach(p=>{x=this.t(x,y,p.s,p.fg||MU,p.bg,p.b);});return x;}
 out(){return this.c.map(r=>{const runs=[];let cur=null;r.forEach(c=>{if(cur&&cur.fg===c.fg&&cur.bg===c.bg&&cur.b===c.b){cur.s+=c.ch;cur.n++;}else{cur={s:c.ch,fg:c.fg,bg:c.bg,b:c.b,n:1};runs.push(cur);}});return{runs:runs.map(u=>({s:u.s,fg:u.fg,bgc:u.bg,fw:u.b?700:400,w:(u.n*CPX).toFixed(1)+'px'}))};});}
}
const S=(s,fg,b,bg)=>({s,fg,b:b?1:0,bg});
function bar(g,y,x0,e0,e1,col,base,chf){
 if(e1-e0<2)e1=e0+2;
 const c0=Math.floor(e0/8),c1=Math.ceil(e1/8);
 for(let c=c0;c<c1;c++){const a=Math.max(e0,c*8)-c*8,b=Math.min(e1,c*8+8)-c*8,x=x0+c,cell=g.get(x,y);if(!cell)continue;
  if(a===0&&b===8)g.put(x,y,chf?chf(c):'█',col,base);
  else if(a===0)g.put(x,y,LB[b],col,base);
  else if(b===8){if(LB.indexOf(cell.ch)>0)g.put(x,y,cell.ch,cell.fg,col);else g.put(x,y,LB[a],base,col);}
  else g.put(x,y,LB[Math.max(1,b-a)],col,base);
 }
 return [c0,c1];
}
function meter(g,x,y,label,p,val){
 const loud=p>=80,len=1+label.length+1+8+1+val.length+1;
 if(loud)g.bgr(x,x+len-1,y,AM);
 const bg=loud?AM:BG,lf=loud?'#000000':DI,ff=loud?'#000000':TRK,ef=loud?'#000000':DOT,vf=loud?'#000000':FG;
 g.t(x+1,y,label,lf,bg,loud?1:0);
 const bx=x+2+label.length,n=Math.min(64,Math.round(p/100*64));
 for(let i=0;i<8;i++){const k=Math.max(0,Math.min(8,n-i*8));g.put(bx+i,y,k===8?'█':k===0?'░':LB[k],k===0?ef:ff,bg,0);}
 g.t(bx+9,y,val,vf,bg,loud?1:0);
 return x+len;
}
function wrap(parts,width,indent){
 const words=[];parts.forEach(p=>p.s.split(/(\s+)/).filter(Boolean).forEach(w=>words.push({...p,s:w})));
 const lines=[];let cur=[S(' '.repeat(indent))],len=indent;
 words.forEach(w=>{if(len+w.s.length>width&&len>indent){lines.push(cur);cur=[S(' '.repeat(indent))];len=indent;if(/^\s+$/.test(w.s))return;}cur.push(w);len+=w.s.length;});
 lines.push(cur);return lines;
}
const FRAMES=[
 {n:'01',title:'Live, mid-mission',caption:'160×45 cell grid overlaid for alignment · j/k selection on WI-204',t:47,now:47,tok:[2.48,62],q:[41,18],sel:'WI-204',grid:true,
  ev:['46:12','WI-205','attempt #5 probe · Bash npm run probe:fuzz -- index']},
 {n:'02',title:'Card journal: WI-204, tool tick #06 selected',caption:'drawer fixed at 60 columns · body scrolls, indicator in the right column',t:47,now:47,tok:[2.48,62],q:[41,18],sel:'WI-204',drawer:true,tool:5,
  ev:['46:12','WI-205','attempt #5 probe · Bash npm run probe:fuzz -- index']},
 {n:'03',title:'Approaching the wall',caption:'budget column at 2:24:00 · 5h quota 86% · WI-209 OVERDUE selected',t:112+1/3,now:112+1/3,tok:[3.05,76],q:[86,27],sel:'WI-209',
  ev:['1:51:58','WI-210','attempt #9 probe · Bash npm run bench -- --ranges']},
];
function build(cfg,ph){
 const g=new Grid(),{t,now}=cfg,dr=!!cfg.drawer,blink=Math.floor(ph/2)%2===0;
 for(let x=1;x<W-1;x++)[0,2,41,H-1].forEach(y=>g.put(x,y,'─',BD));
 for(let y=1;y<H-1;y++){g.put(0,y,'│',BD);g.put(W-1,y,'│',BD);}
 g.put(0,0,'┌',BD);g.put(W-1,0,'┐',BD);g.put(0,H-1,'└',BD);g.put(W-1,H-1,'┘',BD);
 [2,41].forEach(y=>{g.put(0,y,'├',BD);g.put(W-1,y,'┤',BD);});
 let x=g.t(2,1,'CONDUIT',CY,null,1);x+=1;g.put(x,1,'│',BD);x+=1;
 let lastLane=0;CARDS.forEach(c=>{c.v.forEach(v=>{const a=adj(v[1]);if(a<=t)lastLane=Math.max(lastLane,a);});[c.scrap,c.done,c.held&&c.held[0]].forEach(z=>{if(z!=null&&z!==false&&adj(z)<=t)lastLane=Math.max(lastLane,adj(z));});});
 const qk=cfg.q[0]>=cfg.q[1]?0:1,since=now-lastLane;
 [['WALL',Math.round(now/B*100),Math.round(now/B*100)+'%'],['TOKENS',cfg.tok[1],cfg.tok[1]+'%'],['QUOTA '+(qk?'7d':'5h'),cfg.q[qk],cfg.q[qk]+'%'],['WATCHDOG',Math.round(since/THR*100),clk(since)]].forEach(m=>{x=meter(g,x,1,m[0],m[1],m[2]);g.put(x,1,'│',BD);x+=1;});
 const kids=CARDS.slice(1),tally={work:0,wait:0,held:0,done:0,scrap:0};kids.forEach(c=>tally[stateOf(c,t).s]++);
 x+=1;[['working',tally.work,G],['waiting',tally.wait,MU],['held',tally.held,AM],['done',tally.done,MU],['scrap',tally.scrap,CO]].forEach(([k,v,c])=>{x=g.t(x,1,String(v),v?c:DI,null,1);x=g.t(x+1,1,k,DI);x+=1;});
 const el='T+'+clk(now);g.put(W-4-el.length,1,'│',BD);g.t(W-2-el.length,1,el,FG,null,1);
 const CX0=dr?24:30,CX1=dr?86:142,CW=CX1-CX0,SX=dr?87:144,MR=dr?98:158,TMAX=CX0-2-13;
 const nowX=now/B>=0.7?Math.min(CW-2,Math.round(now*(CW-2)/B)):CW-4,s=nowX/now,E=m=>Math.round(m*s*8),bcol=Math.floor(B*s),showB=bcol<CW;
 let lx=CX0;ST.forEach(([n,c])=>{lx=g.t(lx,3,n,c,null,1)+2;});
 const AY=4;
 const nl=el;g.t(CX0+nowX-nl.length+1,AY,nl,G,null,1);
 if(showB){const bl='BUDGET 2:24:00';g.t(CX0+bcol-bl.length,AY,bl,CO,null,1);g.put(CX0+bcol,AY,'│',CO,null,1);}
 g.t(2,AY,'card',DI);g.t(SX,AY,'state',DI);
 const step=[5,10,15,20,30,60].find(st=>st*s>=10);
 for(let m=0;m*s<CW;m+=step){const lab=m===0?'0':m<60?m+'m':Math.floor(m/60)+'h'+(m%60?pad(m%60):''),tx=CX0+Math.round(m*s);let ok=tx+lab.length<CX1;for(let i=-1;i<=lab.length;i++){const c=g.get(tx+i,AY);if(!c||c.ch!==' ')ok=false;}if(ok)g.t(tx,AY,lab,DI);}
 g.t(2,AY,'card',DI);g.t(SX,AY,'state',DI);
 const rowsDef=[CARDS[0],...kids,{join:true}];
 const arrivals=kids.filter(c=>c.done!=null&&c.done<=t).map(c=>c.done).sort((a,b)=>a-b);
 rowsDef.forEach((c,i)=>{
  const y=5+i,sel=cfg.sel===c.id,base=sel?SEL:BG;
  if(sel){g.bgr(1,MR,y,SEL);g.put(1,y,'>',FG,SEL,1);}
  if(c.join){
   g.t(2,y,'└─',BD,base);g.t(5,y,'fan-in',MU,base);g.t(12,y,'· quorum 10',DI,base);
   for(let cc=Math.floor(E(6)/8);cc<nowX;cc++)g.put(CX0+cc,y,'─',BD,base);
   arrivals.forEach(d=>g.put(CX0+Math.floor(E(d)/8),y,'▌',ST[5][1],base));
   g.t(SX,y,`${arrivals.length}/11`,MU,base);
   g.put(CX0+nowX,y,'│',G,base,1);if(showB)g.put(CX0+bcol,y,'│',CO,base,1);
   return;
  }
  const isP=i===0,st0=stateOf(c,t),st=isP&&st0.s==='wait'?{s:'awaiting_children'}:st0,done=st.s==='done'||st.s==='scrap';
  g.t(2,y,isP?'┌─':'├─',BD,base);
  const idc=st.s==='work'?G:st.s==='held'?AM:st.s==='scrap'?CO:st.s==='done'?DI:MU;
  g.t(5,y,c.id,sel&&st.s==='done'?FG:idc,base,st.s==='done'?0:1);
  const title=c.t.length>TMAX?c.t.slice(0,TMAX-1)+'…':c.t;g.t(13,y,title,st.s==='done'?BD:DI,base);
  let prev=isP?0:6,rw=0,lastR=false;
  const dots=(a,b)=>{for(let cc=Math.ceil(E(a)/8);cc<Math.floor(E(b)/8);cc++)g.put(CX0+cc,y,'·',DOT,base);};
  const vis=c.v.filter(v=>v[1]<t);
  vis.forEach(v=>{
   const [si,a,b0]=v,b=Math.min(b0,t),act=st.s==='work'&&st.cur===v;
   if(!(c.held&&c.held[0]>=prev-0.01&&c.held[0]<a))dots(prev,a);
   const col=act?ST[si][1]:done?ST[si][3]:ST[si][2];
   const [c0]=bar(g,y,CX0,E(a),E(b),col,base,act?(cc=>(cc+ph)%4===0?'▓':'█'):null);
   if(lastR){rw++;if(!done)g.put(CX0+Math.ceil(E(a)/8),y,'«',CO,base,1);}
   lastR=v[3]==='R'&&b0<=t;prev=b;
  });
  if(isP){dots(6,t);g.t(CX0+Math.ceil(E(6)/8)+1,y,'fan-out ×11',DI,base);}
  else if(st.s==='wait')dots(prev,t);
  if(c.held&&c.held[0]<t&&!(c.done<=t)){
   const h0=c.held[0],h1=Math.min(t,c.held[1]),dl=c.held[2],ae=Math.min(h1,dl);
   const [c0,c1]=bar(g,y,CX0,E(h0),E(ae),AM,base);
   const room=c1-c0-2,txt=c.hr.length<=room?c.hr:c.hs.length<=room?c.hs:'';
   if(txt)g.t(CX0+c0+1,y,txt,'#000000',AM,1);
   if(h1>dl){bar(g,y,CX0,E(dl),E(h1),CO,base,()=>'▒');}
  }
  if(st.s==='scrap'){const cx=CX0+Math.ceil(E(c.scrap)/8);g.put(cx,y,'█',CO,base);g.t(cx+2,y,'SCRAP · '+c.reason,CO,base,1);}
  const nc=g.get(CX0+nowX,y);if(nc&&(nc.ch===' '||nc.ch==='·'))g.put(CX0+nowX,y,st.s==='work'?'▌':'│',G,base,1);
  if(showB)g.put(CX0+bcol,y,'│',CO,base,1);
  if(st.s==='work')g.t(SX,y,clk(t-st.cur[1])+(rw?` rw${rw}/3`:''),G,base,1);
  else if(st.s==='held'){const dl=c.held[2];
   if(now<dl)g.t(SX,y,` HELD ${clk(dl-now)} `,'#000000',AM,1);
   else g.t(SX,y,`OVERDUE +${clk(now-dl)}`,blink?'#000000':CO,blink?CO:BG,1);}
  else if(st.s==='awaiting_children')g.t(SX,y,'awaiting',MU,base);
  else if(st.s==='done')g.t(SX,y,'✓ '+ev(c.done),DI,base);
  else if(st.s==='scrap')g.t(SX,y,' SCRAP ','#000000',CO,1);
 });
 if(dr){
  const DX=99;for(let y=3;y<=40;y++)g.put(DX,y,'│',BD);g.put(DX,2,'┬',BD);g.put(DX,41,'┴',BD);
  for(let xx=DX+1;xx<W-1;xx++)g.put(xx,6,'─',BD);g.put(DX,6,'├',BD);g.put(W-1,6,'┤',BD);
  g.t(101,3,'WI-204',G,null,1);g.t(109,3,'parse-range',MU);g.t(148,3,'esc close',DI);
  g.t(101,4,'working · rework 2 of 3',G);g.t(101,5,'6 attempts · $6.20 · 639.8k tok',DI);
  const sc=i=>S(PE(ST[i][0],10),ST[i][1]);
  const att=(ts,n,si,cost,tok,calls)=>[S(ev(ts)+' ',DI),S(PE('#'+n,8),FG,1),sc(si),S(PE(cost,7),FG),S(PE(tok+' tok',11),MU),S(calls+' calls',MU)];
  const rej=(ts,n)=>[S(ev(ts)+' ',DI),S('REJECT  ',CO,1),S('review',ST[3][1]),S(' → ',DI),S('implement',ST[2][1]),S(`  rw ${n}/3`,CO,1)];
  const fnd=(loc,txt)=>wrap([S(loc,FG),S(' '+txt,MU)],56,14);
  const L=[];
  L.push([S(ev(6)+' ',DI),S('fan-out ',DI),S('PRD-014',MU),S(' → ',DI),S('test',ST[1][1])]);
  L.push(att(11,1,1,'$0.42','38.1k',12),att(19,2,2,'$2.10','212.0k',41),att(22,3,3,'$0.61','64.3k',18),rej(22,1));
  L.push(...fnd('src/range.ts:88','missing null check on open-ended range'),...fnd('test/range.test.ts','no case for empty input'));
  L.push(att(29,4,2,'$1.64','171.0k',36),att(32,5,3,'$0.55','58.0k',15),rej(32,2));
  L.push(...fnd('src/range.ts:88','attempt #4 reverted the fix from attempt #2'),...fnd('test/range.test.ts:41','empty-input case asserts the wrong error'));
  L.push(att(32,6,2,'$0.88','96.4k',23),[S(' '.repeat(14)),S('running '+clk(t-32),G,1)],[]);
  L.push([S('tool calls · #6',DI)]);
  const sel=cfg.tool;
  L.push(CALLS.flatMap(([tool,,x0],i)=>{const x=x0===undefined?0:x0,run=x0===null;const bg=run?BG:x?CO:TOOL[tool][0],fg=run?(blink?G:DI):x?'#000000':TOOL[tool][1];return[S(tool[0],fg,1,bg),S(' ')];}));
  L.push([S(' '.repeat(sel*2)),S('^',FG,1)]);
  L.push([S('R',FG,1,TOOL.Read[0]),S(' Read  ',MU),S('G',FG,1,TOOL.Grep[0]),S(' Grep  ',MU),S('E','#000000',1,TOOL.Edit[0]),S(' Edit  ',MU),S('B','#000000',1,TOOL.Bash[0]),S(' exit 0  ',MU),S('B','#000000',1,CO),S(' nonzero  ',MU),S('B',G,1),S(' running',MU)]);
  L.push([]);
  const row=(i,hl)=>{const [tool,path,x0]=CALLS[i],x=x0===undefined?0:x0,run=x0===null,bg=hl?BAR:undefined;const ex=run?'running':tool==='Bash'?'exit '+x:'';const tc=x?CO:tool==='Edit'?FG:MU;
   return[S('#'+pad(i+1)+' ',DI,0,bg),S(PE(tool,6),tc,hl||x?1:0,bg),S(PE(path,30),x?CO:FG,0,bg),S(ex.padStart(8),run?G:x?CO:DI,x?1:0,bg),S('  '+PE(run?'…':dur(DUR[i]),6),MU,0,bg),S('  ',MU,0,bg)];};
  L.push(row(sel,true),[]);
  CALLS.forEach((_,i)=>L.push(row(i,i===sel)));
  const top=7,vis=34;
  L.slice(0,vis).forEach((ln,i)=>g.segs(101,top+i,ln));
  const th=Math.max(1,Math.round(vis*vis/L.length));
  for(let i=0;i<vis;i++)g.put(158,top+i,i<th?'█':'│',i<th?DI:BD);
 }
 g.bgr(1,W-2,42,BAR);
 const SB=cfg.sel==='WI-209'
  ?[S('WI-209',FG,1),S(' migration-0042',MU),S(' │ ',BD),S('HELD',AM,1),S(' human decision · approve migration 0042',MU),S(' │ ',BD),S('held since '+clk(29)+' · timeout '+clk(53)+' · on_timeout not recorded',MU),S(' │ ',BD),S('OVERDUE +'+clk(now-53),CO,1)]
  :[S('WI-204',FG,1),S(' parse-range',MU),S(' │ ',BD),S('implement',ST[2][1],1),S(' attempt #6 · '+clk(t-32)+' · rework 2/3',MU),S(' │ ',BD),S('$6.20 · 639.8k tok',MU),S(' │ ',BD),S('last call ',DI),S('Bash npx tsc --noEmit',FG),S(' running',G)];
 g.segs(2,42,SB.map(p=>({...p,bg:BAR})));
 let fx=g.t(2,43,' LIVE ','#000000',G,1)+2;
 fx=g.t(fx,43,cfg.ev[0],DI)+2;fx=g.t(fx,43,cfg.ev[1],FG,null,1)+2;g.t(fx,43,cfg.ev[2],MU);
 const hints=[['j/k','select'],['enter','open drawer'],['t','tool ticks'],['r','replay'],['esc','close']];
 let hl=hints.reduce((a,[k,v])=>a+k.length+1+v.length+2,0)-2,hx=W-2-hl;
 hints.forEach(([k,v])=>{hx=g.t(hx,43,k,FG,null,1);hx=g.t(hx+1,43,v,DI)+2;});
 return {n:cfg.n,label:cfg.n+' '+cfg.title,title:cfg.title,caption:cfg.caption,grid:!!cfg.grid,rows:g.out()};
}
const TOK=[
 {name:'STATIONS · live / past / done',items:ST.flatMap(([k,a,p,d])=>[{k:k+' live',hex:a,a,b:a},{k:k+' past',hex:p,a:p,b:p},{k:k+' done',hex:d,a:d,b:d}])},
 {name:'STATES',items:[
  {k:'working · now-line · LIVE',hex:G,a:G,b:BG,g:'▌',bf:G},
  {k:'held fill (text #000000)',hex:AM,a:AM,b:AM},
  {k:'overdue, blink A: fill',hex:CO,a:CO,b:BG,g:'O',bf:CO},
  {k:'overdue hatch ▒',hex:CO,a:BG,b:BG,g:'▒',bf:CO},
  {k:'scrap fill · budget line',hex:CO,a:CO,b:CO},
  {k:'rework marker «',hex:CO,a:BG,b:BG,g:'«',bf:CO},
  {k:'done text',hex:DI,a:DI,b:DI},
  {k:'waiting dots ·',hex:DOT,a:BG,b:BG,g:'·',bf:DOT},
  {k:'not recorded fg',hex:MU,a:MU,b:MU},
  {k:'not recorded bg',hex:NRB,a:NRB,b:NRB},
  {k:'replay playhead',hex:CY,a:CY,b:CY},
  {k:'meter loud fill (≥80%)',hex:AM,a:AM,b:AM},
  {k:'meter fill █',hex:TRK,a:TRK,b:TRK},
  {k:'meter empty ░',hex:BD,a:BG,b:BG,g:'░',bf:BD}]},
 {name:'TEXT & CHROME',items:[
  {k:'bold / primary text',hex:FG,a:FG,b:FG},
  {k:'normal text',hex:MU,a:MU,b:MU},
  {k:'dim text',hex:DI,a:DI,b:DI},
  {k:'borders · tree · faint',hex:BD,a:BD,b:BD},
  {k:'background',hex:BG,a:BG,b:BG},
  {k:'selected row bg',hex:SEL,a:SEL,b:SEL},
  {k:'status bar bg',hex:BAR,a:BAR,b:BAR},
  {k:'CONDUIT wordmark',hex:CY,a:CY,b:CY}]},
 {name:'TOOL TICKS · bg / fg',items:[
  {k:'Read',hex:'#343B4A / '+FG,a:'#343B4A',b:'#343B4A',g:'R',bf:FG},
  {k:'Grep',hex:'#566078 / '+FG,a:'#566078',b:'#566078',g:'G',bf:FG},
  {k:'Edit',hex:FG+' / #000000',a:FG,b:FG,g:'E',bf:'#000'},
  {k:'Bash, exit 0',hex:'#8A94A7 / #000000',a:'#8A94A7',b:'#8A94A7',g:'B',bf:'#000'},
  {k:'nonzero exit',hex:CO+' / #000000',a:CO,b:CO,g:'B',bf:'#000'},
  {k:'running (blinks to dim)',hex:BG+' / '+G,a:BG,b:BG,g:'B',bf:G}]},
];
TOK.forEach(g=>g.items.forEach(it=>{it.g=it.g||'';it.bf=it.bf||'#000';}));

export { W, H, ST, TOOL, CARDS, CALLS, DUR, FRAMES, TOK, Grid, build };
