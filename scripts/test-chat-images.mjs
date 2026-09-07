import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = fs.readFileSync('app/api/chat/route.ts', 'utf8').replace(/^import .*;$/gm, '').replace('export async function POST', 'async function POST');
const context = vm.createContext({
  knowledgeJson: JSON.parse(fs.readFileSync('data/knowledge.json')),
  vectorIndexJson: { entries: [] }, process: { env: {} }, console,
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
assert.equal(context.passwordResult.images.length, 2);
assert.ok(context.passwordResult.answer.length < 650);
console.log('PASS: forgotten password uses only reset instructions, 2 relevant screenshots, no unrelated articles or full-document dump.');
