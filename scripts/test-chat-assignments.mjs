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
const rows = root.articles.flatMap(article => article.paragraphs);
for (const row of rows) {
  const f = Object.fromEntries(row.text.split('；').map(part => part.split('：')));
  const module = f['二级模块'] === '未填写' ? f['一级模块'] : f['二级模块'];
  const r = await ask([`${module}的产品、设计和维护人分别是谁？`]);
  assert.ok(r.retrieval.paragraphIds.includes(row.id), module);
  for (const field of ['产品经理', '设计师', '帮助文档负责人']) assert.ok(r.answer.includes(f[field]), `${module}/${field}`);
  assert.ok(r.sources[0].url.includes('/base/IQTIbgVvIa9thdsuOi0cbUXanRc'));
  assert.equal(r.images.length, 0);
}
for (const question of ['消息免打扰谁负责？', '消息免打扰的产品是谁', '消息免打扰找谁', '消息免打扰是谁设计的']) {
  const r = await ask([question]); assert.equal(r.retrieval.paragraphIds.length, 1); assert.ok(r.answer.includes('怡宝'));
}
const followup = await ask(['消息免打扰怎么设置？', '那设计师呢？', '维护人是谁？']);
assert.ok(followup.answer.includes('怡宝'));
const broad = await ask(['企业管理后台谁负责？']);
assert.ok(broad.retrieval.paragraphIds.length > 3);
const unknown = await ask(['量子传送模块谁负责？']);
assert.equal(unknown.sources.length, 0); assert.ok(unknown.answer.includes('没有匹配'));
const ai = await ask(['AI周报谁负责？']);
assert.equal(ai.retrieval.paragraphIds.length, 1); assert.ok(ai.answer.includes('可大力'));
console.log(`PASS: ${rows.length} live assignment rows, all three roles, source links, follow-ups, parent modules, unknown modules and overlapping names.`);
