import webpush from 'web-push';

const token=process.env.PRIVATE_REPO_TOKEN;
if(!token) throw new Error('PRIVATE_REPO_TOKEN missing');

const owner='gjhangen';
const privateRepo='do-it-private';
const api='https://api.github.com';

async function gh(path, opts={}){
  const res=await fetch(api+path,{
    ...opts,
    headers:{
      'Accept':'application/vnd.github+json',
      'Authorization':`Bearer ${token}`,
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
      ...(opts.headers||{})
    }
  });
  if(!res.ok) throw new Error(`${opts.method||'GET'} ${path}: ${res.status} ${await res.text()}`);
  if(res.status===204) return null;
  return res.json();
}
function decode64(s){ return Buffer.from(s,'base64').toString('utf8'); }
function encode64(s){ return Buffer.from(s,'utf8').toString('base64'); }
function cleanJson(s){
  return s.trim().replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'');
}
async function getFile(path){
  const x=await gh(`/repos/${owner}/${privateRepo}/contents/${path}`);
  return {sha:x.sha, value:JSON.parse(decode64(x.content))};
}
async function putFile(path,value,sha,message){
  return gh(`/repos/${owner}/${privateRepo}/contents/${path}`,{
    method:'PUT',
    body:JSON.stringify({message,content:encode64(JSON.stringify(value,null,2)),sha,branch:'main'})
  });
}
async function deleteFile(path,sha){
  return gh(`/repos/${owner}/${privateRepo}/contents/${path}`,{
    method:'DELETE',
    body:JSON.stringify({message:'Process Do It command',sha,branch:'main'})
  });
}
function norm(s=''){return s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function findTask(state,q){
  const nq=norm(q);
  const open=state.tasks.filter(t=>t.status==='open');
  return open.find(t=>norm(t.title)===nq)
      || open.find(t=>norm(t.title).includes(nq)||nq.includes(norm(t.title)))
      || null;
}
function makeId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function fallbackReminders(cmd){
  if(cmd.reminders?.length) return cmd.reminders;
  if(!cmd.deadline) return [];
  const due=new Date(cmd.deadline).getTime();
  if(!Number.isFinite(due)) return [];
  const est=Math.max(15,Number(cmd.estimated_minutes)||30);
  const candidates=[
    due-(est+90)*60000,
    due-(est+30)*60000,
    due-(Math.max(20,Math.round(est*.25)))*60000
  ].filter(t=>t>Date.now());
  return [...new Set(candidates)].map((t,i)=>({
    at:new Date(t).toISOString(),
    message:i===0?'Make room for this before the deadline.':i===1?'You are running out of slack on this.':'Handle this now if it is still open.'
  }));
}
function applyCommand(state,cmd){
  const now=new Date().toISOString();
  let ack=cmd.ack||'Done.';
  if(cmd.kind==='add_task'){
    const task={
      id:makeId(),
      title:cmd.title||'Untitled task',
      details:cmd.details||null,
      created_at:now,
      deadline:cmd.deadline||null,
      estimated_minutes:cmd.estimated_minutes??null,
      status:'open',
      reminders:fallbackReminders(cmd).map(r=>({at:r.at,message:r.message||cmd.title||'Do It',sent:false}))
    };
    state.tasks.push(task);
    return {ack, tag:`task-${task.id}`};
  }
  if(cmd.kind==='complete_task'){
    const t=findTask(state,cmd.query||cmd.title||'');
    if(t){t.status='done';t.done_at=now;ack=cmd.ack||`${t.title} marked done.`;}
    else ack='I could not find that open task.';
    return {ack,tag:'do-it-ack'};
  }
  if(cmd.kind==='snooze_task'){
    const t=findTask(state,cmd.query||cmd.title||'');
    if(t){
      const mins=Math.max(5,Number(cmd.snooze_minutes)||30);
      const next=new Date(Date.now()+mins*60000).toISOString();
      t.reminders.push({at:next,message:`Snoozed: ${t.title}`,sent:false});
      ack=cmd.ack||`Snoozed ${t.title}.`;
    }else ack='I could not find that open task.';
    return {ack,tag:'do-it-ack'};
  }
  if(cmd.kind==='update_task'){
    const t=findTask(state,cmd.query||cmd.title||'');
    if(t){
      if(cmd.title) t.title=cmd.title;
      if(cmd.details!==null&&cmd.details!==undefined) t.details=cmd.details;
      if(cmd.deadline!==null&&cmd.deadline!==undefined) t.deadline=cmd.deadline;
      if(cmd.estimated_minutes!==null&&cmd.estimated_minutes!==undefined) t.estimated_minutes=cmd.estimated_minutes;
      if(cmd.reminders?.length) t.reminders=cmd.reminders.map(r=>({at:r.at,message:r.message||t.title,sent:false}));
      ack=cmd.ack||`Updated ${t.title}.`;
    }else ack='I could not find that open task.';
    return {ack,tag:'do-it-ack'};
  }
  if(cmd.kind==='note'){
    state.notes.push({id:makeId(),text:cmd.details||cmd.title||'',created_at:now});
    return {ack,tag:'do-it-note'};
  }
  return {ack:'I received the command but could not classify it.',tag:'do-it-ack'};
}

async function send(config,title,body,tag='do-it'){
  if(!config.pushSubscriptions?.length) return;
  webpush.setVapidDetails(config.vapid.subject,config.vapid.publicKey,config.vapid.privateKey);
  const payload=JSON.stringify({title,body,tag,timestamp:Date.now(),url:'./'});
  const keep=[];
  for(const sub of config.pushSubscriptions){
    try{
      await webpush.sendNotification(sub,payload);
      keep.push(sub);
    }catch(e){
      if(e.statusCode!==404&&e.statusCode!==410) keep.push(sub);
    }
  }
  config.pushSubscriptions=keep;
}

const stateFile=await getFile('state.json');
const configFile=await getFile('config.json');
const state=stateFile.value;
const config=configFile.value;
let stateChanged=false;
let configChanged=false;

let inbox=[];
try{
  const listed=await gh(`/repos/${owner}/${privateRepo}/contents/inbox`);
  inbox=Array.isArray(listed)?listed.filter(x=>x.type==='file'&&!x.name.startsWith('.')):[];
}catch{}

for(const item of inbox){
  try{
    const raw=await gh(`/repos/${owner}/${privateRepo}/contents/${item.path}`);
    const cmd=JSON.parse(cleanJson(decode64(raw.content)));
    const result=applyCommand(state,cmd);
    stateChanged=true;
    await send(config,'Do It · Got it',result.ack,result.tag);
    await deleteFile(item.path,raw.sha);
  }catch{
    // Leave malformed commands in place for inspection; never echo personal content to public logs.
  }
}

const now=Date.now();
for(const task of state.tasks.filter(t=>t.status==='open')){
  for(const r of task.reminders||[]){
    const at=new Date(r.at).getTime();
    if(!r.sent&&Number.isFinite(at)&&at<=now){
      await send(config,`Do It · ${task.title}`,r.message||task.title,`task-${task.id}`);
      r.sent=true;
      r.sent_at=new Date().toISOString();
      stateChanged=true;
    }
  }
}

if(stateChanged) await putFile('state.json',state,stateFile.sha,'Update Do It state');
if(JSON.stringify(config.pushSubscriptions)!==JSON.stringify(configFile.value.pushSubscriptions)){
  configChanged=true;
}
if(configChanged) await putFile('config.json',config,configFile.sha,'Prune stale push subscriptions');
