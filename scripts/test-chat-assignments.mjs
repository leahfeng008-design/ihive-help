import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const knowledgeJson = JSON.parse(fs.readFileSync('data/knowledge.json'));
const source = fs.readFileSync('app/api/chat/route.ts', 'utf8').replace(/^import .*;$/gm, '').replace('export async function POST', 'async function POST');
const context = vm.createContext({ knowledgeJson, imageContextJson: {}, vectorIndexJson: { entries: [] }, process: { env: {} }, console, Response, isFeishuAuthRequired: () => false, readFeishuSession: async () => null });
vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
const ask = async messages => {
  context.body = { messages: messages.map(content => ({role: 'user', content})) };
  return vm.runInContext('POST({json: async () => body}).then(r => r.json())', context);
};
const root = knowledgeJson.roots.find(root => root.sourceType === 'assignment');
const allRows = root.articles.flatMap(article => article.paragraphs);
const rows = allRows.filter(row => row.text.includes('帮助文档负责人：'));
const ownerRows = allRows.filter(row => row.text.includes('问题负责人：'));
assert.equal(ownerRows.length, 93);
const parseFields = row => Object.fromEntries(row.text.split('；').map(part => part.split('：')));
for (const row of ownerRows) {
  const f = Object.fromEntries(row.text.split('；').map(part => part.split('：')));
  const r = await ask([`${f['二级模块']}谁负责？`]);
  assert.ok(r.retrieval.paragraphIds.includes(row.id), row.text);
  assert.ok(r.answer.includes(`问题负责人：${f['问题负责人']}`));
  assert.ok(r.sources.some(source => source.url.includes('tblinkja1AwTvKno')));
}
const help = await ask(['谁负责帮助中心']);
assert.equal(help.retrieval.paragraphIds.length, 1);
assert.ok(help.answer.includes('问题负责人：爱德'));
assert.ok(!help.answer.includes('唐炜'));
const proof = await ask(['谁负责帮助中心', '你在哪个文档里找到的产品经理是唐炜']);
assert.ok(proof.answer.includes('问题负责人：爱德'));
assert.equal(proof.retrieval.paragraphIds.length, 1);
for (const row of rows) {
  const f = Object.fromEntries(row.text.split('；').map(part => part.split('：')));
  const module = f['二级模块'] === '未填写' ? f['一级模块'] : f['二级模块'];
  const r = await ask([`${module}的产品、设计和维护人分别是谁？`]);
  assert.ok(r.retrieval.paragraphIds.includes(row.id), module);
  for (const field of ['产品经理', '设计师', '帮助文档负责人']) assert.ok(r.answer.includes(f[field]), `${module}/${field}`);
  assert.ok(r.sources[0].url.includes('/base/IQTIbgVvIa9thdsuOi0cbUXanRc'));
  assert.equal(r.images.length, 0);
}
for (const question of ['消息免打扰的产品是谁', '消息免打扰是谁设计的']) {
  const r = await ask([question]); assert.equal(r.retrieval.paragraphIds.length, 2); assert.ok(r.answer.includes('怡宝'));
}
const followup = await ask(['消息免打扰怎么设置？', '那设计师呢？', '维护人是谁？']);
assert.ok(followup.answer.includes('怡宝'));
const broad = await ask(['企业管理后台谁负责？']);
assert.ok(broad.retrieval.paragraphIds.length > 3);
const unknown = await ask(['量子传送模块谁负责？']);
assert.equal(unknown.sources.length, 0); assert.ok(unknown.answer.includes('没有匹配'));
const ai = await ask(['AI周报谁负责？']);
assert.equal(ai.retrieval.paragraphIds.length, 2); assert.ok(ai.answer.includes('可大力'));
console.log(`PASS: ${ownerRows.length} module-owner rows and ${rows.length} documentation-role rows, all three roles, source links, follow-ups, parent modules, unknown modules and overlapping names.`);

const files = await ask(['文件收发谁负责？']);
for (const text of ['产品：秦汉', '设计：爱德', '帮助文档维护人：爱德', '问题负责人：爱德']) assert.ok(files.answer.includes(text), text);
assert.equal(files.sources.length, 2);
for (const table of ['tblG1Pi9DMfjY97O', 'tblinkja1AwTvKno']) assert.ok(files.sources.some(source => source.url.includes(table)));
const quiet = await ask(['消息免打扰谁负责？']);
assert.ok(quiet.answer.includes('帮助文档维护人：Yvonne'));
assert.ok(quiet.answer.includes('问题负责人：爱德'));
console.log('PASS: file transfer returns all four roles and both sources; different documentation and issue owners stay distinct.');

for (const question of ['谁负责登录注册', '注册登录找谁', '账号注册/登录谁负责']) {
  const result = await ask([question]);
  for (const text of ['IM设置 / 账号注册/登录', '产品：秦汉', '设计：爱德', '帮助文档维护人：秦汉', '问题负责人：秦汉']) {
    assert.ok(result.answer.includes(text), `${question}: ${text}`);
  }
  assert.equal(result.retrieval.paragraphIds.length, 2);
}
const admin = await ask(['谁负责后台']);
assert.ok(admin.answer.includes('企业管理后台'));
assert.ok(admin.retrieval.paragraphIds.length > 3);
assert.ok(!admin.answer.includes('没有匹配'));
console.log('PASS: reversed login/registration wording and the backend abbreviation resolve to assignment modules.');

const shorthandCases = [
  ['谁负责假勤', '假勤系统'],
  ['考勤找谁', '假勤系统'],
  ['请假的负责人是谁', '假勤系统'],
  ['SaaS后台谁负责', 'SaaS管理后台'],
  ['OPS找谁', 'OPS后台'],
  ['工作台谁维护', 'IM工作台'],
  ['群聊谁负责', 'IM群组'],
  ['会议谁负责', '在线会议'],
  ['国际化谁负责', '多语言/国际化'],
  ['隐私保护谁负责', '安全与隐私保护'],
  ['组织架构谁负责', '后台-组织架构'],
  ['权限谁负责', '后台-权限管理'],
  ['审计谁负责', '后台-审计日志'],
  ['快捷键谁负责', '设置-快捷键'],
  ['版本更新谁负责', '设置-版本更新'],
];
for (const [question, expected] of shorthandCases) {
  const result = await ask([question]);
  assert.ok(result.answer.includes(expected), `${question} should match ${expected}`);
  assert.ok(!result.answer.includes('没有匹配'), question);
  assert.ok(result.sources.length >= 1, `${question} should cite its assignment table`);
}
console.log(`PASS: ${shorthandCases.length} representative aliases and removable module prefixes/suffixes resolve correctly.`);

const firstLevelModules = [...new Set(allRows.map(row => parseFields(row)['一级模块']).filter(name => name && name !== '未填写'))];
for (const module of firstLevelModules) {
  const result = await ask([`${module}谁负责？`]);
  const expectedIds = allRows.filter(row => parseFields(row)['一级模块'] === module).map(row => row.id);
  for (const id of expectedIds) assert.ok(result.retrieval.paragraphIds.includes(id), `${module} should include ${id}`);
}
console.log(`PASS: all ${firstLevelModules.length} first-level modules return every matching row from both tables.`);
