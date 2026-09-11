import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

const live = process.argv.includes('--live');
const selection = process.env.EVAL_SCENARIOS?.split(',');
const scenarios = [
  {name:'免打扰-简化', title:'如何为单个会话设置消息免打扰', turns:['怎么设置消息免打扰？','简单点说','再短点']},
  {name:'免打扰-切换客户端',title:'如何为单个会话设置消息免打扰',turns:['怎么设置消息免打扰？','那手机上呢？','电脑呢？']},
  {name:'免打扰-指定方法',title:'如何为单个会话设置消息免打扰',turns:['怎么设置消息免打扰？','第二种呢？','给我对应的图']},
  {name:'密码-简化',title:'如何修改登录密码',turns:['忘记密码怎么办？','一句话说清楚','具体点呢？']},
  {name:'密码-验证码',title:'如何修改登录密码',turns:['忘记密码怎么办？','收不到呢？','还是不行呢？']},
  {name:'邮箱验证码-收不到',title:'如何修改登录密码',turns:['收不到邮箱验证码怎么办？','邮箱验证码没收到','没收到验证邮件'],mustInclude:[['确认邮箱地址','垃圾邮箱','重新获取验证码'],['确认邮箱地址','垃圾邮箱','重新获取验证码'],['确认邮箱地址','垃圾邮箱','重新获取验证码']]},
  {name:'群管理员-添加',title:'添加管理员',turns:['怎么添加群管理员？','群管理员怎么添加？','如何设置群管理员？'],mustInclude:[['仅群主可进行此操作','添加群管理员','设为群管理员'],['仅群主可进行此操作','添加群管理员','设为群管理员'],['仅群主可进行此操作','添加群管理员','设为群管理员']]},
  {name:'备注-追问',title:'如何给联系人修改备注',turns:['怎么给联系人修改备注？','在哪里？','能取消吗？']},
  {name:'主题-追问',title:'如何更换主题',turns:['怎么更换主题？','那手机端呢？','简单一点']},
  {name:'收藏-图片',title:'如何收藏消息',turns:['怎么收藏消息？','怎么取消？','有图吗？']},
  {name:'新话题',turns:['怎么设置消息免打扰？','那忘记密码怎么办？','简单说'],titles:['如何为单个会话设置消息免打扰','如何修改登录密码','如何修改登录密码']},
  {name:'备注-可见性',title:'如何给联系人修改备注',turns:['怎么给联系人修改备注？','别人能看到吗？','再短点']},
  {name:'主题-未生效',title:'如何更换主题',turns:['怎么更换主题？','没有变化呢？','简单说']},
  {name:'收藏-手机取消',title:'如何收藏消息',turns:['怎么收藏消息？','怎么取消？','那手机上呢？','有图吗？']},
  {name:'免打扰-不存在的方法',title:'如何为单个会话设置消息免打扰',turns:['怎么设置消息免打扰？','第四种呢？']},
  {name:'免打扰-未知客户端',title:'如何为单个会话设置消息免打扰',turns:['怎么设置消息免打扰？','那安卓呢？']},
  {name:'显式换题',turns:['怎么设置消息免打扰？','这个密码怎么修改？'],titles:['如何为单个会话设置消息免打扰','如何修改登录密码']},
  {name:'免打扰-第三方法手机',title:'如何为单个会话设置消息免打扰',turns:['手机上怎么设置消息免打扰？','第三种呢？','再简单点']},
  {name:'备注-连续省略',title:'如何给联系人修改备注',turns:['怎么给联系人修改备注？','在哪儿？','对方能看到吗？']},
  {name:'无上下文',turns:['简单点说'],clarify:true},
];
const source = fs.readFileSync('app/api/chat/route.ts','utf8').replace(/^import .*;$/gm,'').replace('export async function POST','async function POST');
const context = vm.createContext({
  knowledgeJson: JSON.parse(fs.readFileSync('data/knowledge.json')),
  imageContextJson: JSON.parse(fs.readFileSync('data/image-context.json')),
  vectorIndexJson: live ? JSON.parse(fs.readFileSync('data/vector-index.json')) : {entries:[]},
  process: {env:live ? process.env : {}}, console, fetch, Request, Response, URL, atob,
  isFeishuAuthRequired:()=>false, readFeishuSession:async()=>null,
});
vm.runInContext(ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),context);
const post = vm.runInContext('POST',context);
const resolve = vm.runInContext('resolveConversation',context);
const results=[];
for(const scenario of scenarios.filter(s=>!selection||selection.includes(s.name))) {
  const history=[];
  for(const [index,question] of scenario.turns.entries()) {
    history.push({role:'user',content:question});
    const start=Date.now();
    const response=await post(new Request('http://localhost/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:history})}));
    const body=await response.json();
    const resolved=resolve(history);
    const expected=scenario.titles?.[index]||scenario.title;
    const mustInclude=scenario.mustInclude?.[index]||[];
    const text=(body.answer||'').replace(/\[\[IMAGE:[^\]]+\]\]/g,'');
    const markers=[...(body.answer||'').matchAll(/\[\[IMAGE:([^\]]+)\]\]/g)].map(m=>m[1]);
    const noticeExpected = scenario.clarify ||
      (scenario.name==='密码-验证码' && index===2) || (scenario.name==='备注-追问' && index===2) ||
      (scenario.name==='免打扰-不存在的方法' && index===1) ||
      (scenario.name==='免打扰-未知客户端' && index===1);
    const expectedImages = {
      '免打扰-切换客户端': [['img-c795f4ce174c','img-2de03b5336cd'],['img-2de03b5336cd'],['img-c795f4ce174c']],
      '免打扰-指定方法': [['img-c795f4ce174c','img-2de03b5336cd'],['img-ea3a161c52c0','img-2de03b5336cd'],['img-ea3a161c52c0','img-2de03b5336cd']],
      '收藏-图片': [['img-93df4256f353','img-b77dbd72398d'],['img-f7ad23cb025e','img-eaff568cc0ea'],['img-f7ad23cb025e','img-eaff568cc0ea']],
      '免打扰-第三方法手机': [['img-2de03b5336cd'],['img-2de03b5336cd'],['img-2de03b5336cd']],
      '收藏-手机取消': [['img-93df4256f353','img-b77dbd72398d'],['img-f7ad23cb025e','img-eaff568cc0ea'],['img-eaff568cc0ea'],['img-eaff568cc0ea']],
    }[scenario.name]?.[index];
    const checks={
      success:response.status===200,
      source:noticeExpected ? !body.sources?.length : !!body.sources?.length && body.sources.every(s=>s.title===expected),
      imageFiles:(body.images||[]).every(i=>fs.existsSync(`public${i.src}`)),
      markers:markers.length===(body.images||[]).length && (body.images||[]).every(i=>markers.filter(id=>id===i.imageId).length===1),
      concise:text.length<=(resolved.brief?200:450),
      expectedImages:expectedImages ? JSON.stringify([...markers].sort())===JSON.stringify([...expectedImages].sort()) : true,
      platform: index>0 && (scenario.name==='免打扰-切换客户端' || scenario.name==='收藏-手机取消' && index>1) ?
        scenario.name==='免打扰-切换客户端' && index===2 ? !/iPhone/.test(text) : !/Mac|鼠标右键/.test(text) : true,
      contextual:!expected || !resolved.needsContext,
      notice:!noticeExpected || !!text && !body.images?.length,
      noDocumentHeadings:!/^\*?\*?使用过程/m.test(text),
      expectedText:mustInclude.every(value=>text.includes(value)),
    };
    const row={scenario:scenario.name,question,resolved,checks,characters:text.length,ms:Date.now()-start,...body};
    results.push(row);
    console.log(JSON.stringify({scenario:scenario.name,question,checks,characters:text.length,images:body.images?.length,error:body.error}));
    history.push({role:'assistant',content:body.answer||''});
  }
}
const file=process.env.EVAL_OUTPUT||`reports/chat-evaluation-${live?'live':'offline'}.json`;
fs.writeFileSync(file,JSON.stringify({mode:live?'real-model-and-vectors':'offline-fallback',generatedAt:new Date().toISOString(),results},null,2));
console.log(`Saved ${results.length} turns to ${file}`);
if (process.argv.includes('--assert')) {
  const failures=results.filter(row=>Object.values(row.checks).some(ok=>!ok));
  assert.equal(failures.length,0,JSON.stringify(failures.map(row=>({scenario:row.scenario,question:row.question,checks:row.checks})),null,2));
}
