import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = fs.readFileSync('app/api/chat/route.ts', 'utf8').replace(/^import .*;$/gm, '').replace('export async function POST', 'async function POST');
const context = vm.createContext({
  knowledgeJson: JSON.parse(fs.readFileSync('data/knowledge.json')),
  imageContextJson: JSON.parse(fs.readFileSync('data/image-context.json')),
  vectorIndexJson: { entries: [] }, process: { env: {} }, console, Response,
  isFeishuAuthRequired: () => false, readFeishuSession: async () => null,
});
vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
await vm.runInContext(`(async () => {
  const question = '怎么设置消息免打扰？';
  const retrieval = await retrieve(question);
  const matches = associateMethodImages(answerMatches(question, retrieval));
  const images = requiredImages(matches);
  const answer = fallbackAnswer({ ...retrieval, paragraphs: matches });
  globalThis.result = { images, answer, valid: hasCompleteImageMarkers(answer, images),
    missingRejected: !hasCompleteImageMarkers('只有文字', images),
    duplicateRejected: !hasCompleteImageMarkers(answer + '\\n[[IMAGE:' + images[0].imageId + ']]', images),
    matches: matches.map(m => ({text: m.node.text, images: m.node.images, section: m.node.sectionPath})) };
})()`, context);
const { result } = context;
assert.equal(result.images.length, 4);
assert.ok(result.valid && result.missingRejected && result.duplicateRejected);
assert.ok(result.answer.includes('iPhone 客户端操作'));
assert.ok(result.answer.includes('在消息列表界面，长按'));
for (const image of result.images) assert.ok(fs.existsSync(`public${image.src}`));
for (const [id, step] of [
  ['img-c795f4ce174c', '在该会话上单击鼠标右键'],
  ['img-ea3a161c52c0', '点击窗口顶部会话名称旁的铃铛图标'],
  ['img-a800b95c8690', '在右侧设置面板中'],
  ['img-2de03b5336cd', '在设置页面中'],
]) {
  const match = result.matches.find(m => m.images.some(image => image.imageId === id));
  assert.ok(match.text.startsWith(step), `${id} must follow its own method`);
  assert.ok(result.answer.includes(`${match.text}\n\n[[IMAGE:${id}]]`));
}
console.log('PASS: original question returns all 4 existing images after the correct steps, including iPhone; missing/duplicate markers rejected.');
const resolve = messages => vm.runInContext(`resolveConversation(${JSON.stringify(messages)})`, context);
const user = content => ({ role: 'user', content });
const history = [user('怎么设置消息免打扰？'), {role: 'assistant', content: 'Mac 和 iPhone 操作说明'}];
for (const followup of ['简单点说', '简单说', '再简短一点', '详细一点', '怎么关闭', '那手机端呢', '这个怎么设置']) {
  assert.ok(resolve([...history, user(followup)]).question.includes('消息免打扰'), followup);
}
assert.equal(resolve([...history, user('简单点说')]).brief, true);
assert.equal(resolve([...history, user('简单点说'), user('详细一点')]).brief, false);
assert.equal(resolve([...history, user('怎么添加表情包')]).question, '怎么添加表情包');
assert.equal(resolve([user('简单点说')]).needsContext, true);
assert.equal(resolve([...history, user('简单点说'), user('再详细一点')]).question, '怎么设置消息免打扰？');
await vm.runInContext(`(async () => {
  const retrieval = await retrieve('怎么设置消息免打扰？');
  const matches = conciseMatches(associateMethodImages(answerMatches('怎么设置消息免打扰？', retrieval)));
  globalThis.shortAnswer = fallbackAnswer({ ...retrieval, paragraphs: matches });
})()`, context);
assert.ok(context.shortAnswer.length < result.answer.length);
assert.ok(context.shortAnswer.includes('iPhone 客户端操作'));
assert.ok(!context.shortAnswer.includes('方法2'));
assert.ok(context.shortAnswer.includes('[[IMAGE:img-c795f4ce174c]]'));
console.log('PASS: follow-ups inherit topic; new topics reset; empty history asks for topic; concise response retains matching image.');
await vm.runInContext(`(async () => {
  const question = '忘记密码怎么办';
  const retrieval = await retrieve(question);
  const matches = conciseMatches(associateMethodImages(answerMatches(question, retrieval)));
  globalThis.passwordResult = { titles: matches.map(m => m.node.title), answer: fallbackAnswer({ ...retrieval, paragraphs: matches }), images: requiredImages(matches) };
})()`, context);
assert.ok(context.passwordResult.titles.every(title => title === '如何修改登录密码'));
assert.ok(context.passwordResult.answer.includes('重置密码'));
assert.ok(context.passwordResult.answer.includes('邮箱验证码'));
assert.ok(!context.passwordResult.answer.includes('输入旧密码'));
assert.ok(!context.passwordResult.answer.includes('登录设备'));
assert.ok(!context.passwordResult.answer.includes('使用过程'));
assert.equal(context.passwordResult.images.length, 1);
assert.ok(context.passwordResult.answer.length < 650);
console.log('PASS: forgotten password uses only reset instructions, 1 current reset screenshot, no unrelated articles or full-document dump.');
const render = vm.runInContext('renderGeneratedAnswer',context);
await vm.runInContext(`(async () => {
  const state=resolveConversation([{role:'user',content:'怎么设置消息免打扰？'}]);
  const retrieval=await retrieve(state.baseQuestion);
  globalThis.focused=focusMatches(state,retrieval).matches;
})()`,context);
const focused=context.focused;
const mac=focused.find(m=>m.node.images.some(i=>i.imageId==='img-c795f4ce174c'));
const phone=focused.find(m=>m.node.images.some(i=>i.imageId==='img-2de03b5336cd'));
const blocks=[{text:'**Mac**：右键点击会话，选择关闭消息通知提醒。',paragraphIds:[mac.node.id]},
  {text:'**iPhone**：长按会话，选择关闭消息通知提醒。',paragraphIds:[phone.node.id]}];
const rendered=render(JSON.stringify({blocks}),focused,true);
assert.ok(rendered);
assert.ok(rendered.indexOf('[[IMAGE:img-c795f4ce174c]]')<rendered.indexOf('**iPhone**'));
assert.ok(rendered.indexOf('[[IMAGE:img-2de03b5336cd]]')>rendered.indexOf('**iPhone**'));
assert.equal(render('not json',focused,true),null);
assert.equal(render(JSON.stringify({blocks:blocks.slice(0,1)}),focused,true),null);
assert.equal(render(JSON.stringify({blocks:[{text:'操作',paragraphIds:['unknown']},blocks[1]]}),focused,true),null);
assert.equal(render(JSON.stringify({blocks:[{text:'操作 [[IMAGE:fake]]',paragraphIds:[mac.node.id]},blocks[1]]}),focused,true),null);
assert.equal(render(JSON.stringify({blocks:[{text:'操作'.repeat(250),paragraphIds:[mac.node.id]},blocks[1]]}),focused,false),null);
assert.equal(render(JSON.stringify({blocks:[{text:'客户端操作',paragraphIds:[mac.node.id,phone.node.id]}]}),focused,true),null);
assert.ok(render(JSON.stringify({blocks:[blocks[0],blocks[0],blocks[1]]}),focused,true));
console.log('PASS: structured model blocks place images after their steps; malformed, missing, unknown, fabricated, overlong and mixed-client blocks rejected; duplicate citations deduplicated.');
const post=vm.runInContext('POST',context);
const request={json:async()=>({messages:[{role:'user',content:'怎么设置消息免打扰？'}]})};
context.process.env.OPENROUTER_API_KEY='local-test-fixture';
let modelCalls=0;
context.fetch=async (_url,options)=>{
  modelCalls++;
  const payload=JSON.parse(options.body);
  assert.equal(payload.response_format.type,'json_object');
  return Response.json({choices:[{message:{content:JSON.stringify({blocks})}}]});
};
let apiAnswer=await (await post(request)).json();
assert.equal(apiAnswer.answer,rendered);
context.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify({blocks:blocks.slice(0,1)})}}]});
apiAnswer=await (await post(request)).json();
assert.ok(apiAnswer.answer.includes('[[IMAGE:img-2de03b5336cd]]'));
assert.ok(apiAnswer.answer.includes('[[IMAGE:img-c795f4ce174c]]'));
context.fetch=async()=>{throw new Error('Simulated network failure');};
vm.runInContext('searchNodes[0].embedding=[1];',context);
const outage=await post(request);
assert.equal(outage.status,200);
apiAnswer=await outage.json();
assert.equal(apiAnswer.retrieval.method,'hierarchical-lexical');
assert.equal(apiAnswer.images.length,2);
assert.ok(modelCalls>0);
console.log('PASS: API model-path fixture, omitted-image fallback, and embedding/model outage fallback; no external requests made.');

const imagePolicy = vm.runInContext(`flattenKnowledge({roots:[{id:'root',type:'directory',sourceType:'help',title:'root',path:[],directories:[],articles:['help','prd','assignment'].map(sourceType=>({id:sourceType,type:'article',sourceType,title:sourceType,path:[],articles:[],paragraphs:[{id:sourceType+'-paragraph',text:'操作说明',images:[{imageId:sourceType+'-image',src:'/kb-images/'+sourceType+'.png'}]}]}))}]}).filter(n=>n.nodeType==='paragraph').map(n=>({source:n.sourceType,images:n.images.length}))`,context);
assert.deepEqual(JSON.parse(JSON.stringify(imagePolicy)),[{source:'help',images:1},{source:'prd',images:0},{source:'assignment',images:0}]);
console.log('PASS: only help-document images enter retrieval; cached PRD and assignment images are excluded.');
