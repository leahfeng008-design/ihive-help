import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { cases } from './module-selftest-cases.mjs';

const modules = ['IM端', '后台', '汇报', '审批', '空间'];
const contexts = modules.flatMap((module) =>
  cases.filter((item) => item.module === module).slice(0, 5),
);
const followups = [
  { text: '这个怎么用？', intent: 'operation' },
  { text: '简单点', intent: 'brief' },
  { text: '看不懂', intent: 'brief' },
  { text: '说人话', intent: 'brief' },
];

assert.equal(contexts.length, 25);
assert.equal(contexts.length * followups.length, 100);

const source = fs
  .readFileSync('app/api/chat/route.ts', 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('export async function POST', 'async function POST');
const context = vm.createContext({
  knowledgeJson: JSON.parse(fs.readFileSync('data/knowledge.json')),
  imageContextJson: JSON.parse(fs.readFileSync('data/image-context.json')),
  vectorIndexJson: { entries: [] },
  process: { env: {} },
  console,
  fetch,
  Request,
  Response,
  URL,
  atob,
  isFeishuAuthRequired: () => false,
  readFeishuSession: async () => null,
});
vm.runInContext(
  ts.transpile(source, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  }),
  context,
);
const post = vm.runInContext('POST', context);
const resolveConversation = vm.runInContext('resolveConversation', context);
const results = [];

for (const item of contexts) {
  for (const followup of followups) {
    const messages = [
      { role: 'user', content: item.turns[0] },
      { role: 'assistant', content: `正在说明：${item.title}` },
      { role: 'user', content: followup.text },
    ];
    const resolved = resolveConversation(messages);
    const response = await post(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      }),
    );
    const body = await response.json();
    const checks = {
      success: response.status === 200 && !body.error,
      keepsTopic:
        resolved.baseQuestion === item.turns[0] && !resolved.needsContext,
      understandsIntent:
        followup.intent === 'brief'
          ? resolved.brief && !resolved.detailed && !resolved.followup
          : resolved.followup === followup.text,
      correctArticle:
        body.sources?.length > 0 &&
        body.sources.every((sourceItem) => sourceItem.title === item.title),
      usefulAnswer:
        typeof body.answer === 'string' &&
        body.answer.trim().length > 0 &&
        !/请先告诉我你想了解的具体功能/.test(body.answer),
      conciseWhenAsked:
        followup.intent !== 'brief' ||
        body.answer.replace(/\[\[(?:IMAGE|VIDEO):[^\]]+\]\]/g, '').length <= 240,
    };
    results.push({
      id: `${item.id}-${followup.text}`,
      module: item.module,
      title: item.title,
      initialQuestion: item.turns[0],
      followup: followup.text,
      intent: followup.intent,
      resolved,
      checks,
      answer: body.answer,
      sources: body.sources,
    });
  }
}

const failures = results.filter((row) =>
  Object.values(row.checks).some((passed) => !passed),
);
const report = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  accuracy: (results.length - failures.length) / results.length,
  phraseCounts: Object.fromEntries(
    followups.map((followup) => [
      followup.text,
      results.filter((row) => row.followup === followup.text).length,
    ]),
  ),
  results,
};
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(
  'reports/context-understanding-100.json',
  JSON.stringify(report, null, 2),
);

console.log(
  JSON.stringify({
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    accuracy: report.accuracy,
    failures: failures.map((row) => ({
      id: row.id,
      checks: row.checks,
      resolved: row.resolved,
      sources: row.sources?.map((sourceItem) => sourceItem.title),
    })),
  }),
);
assert.equal(failures.length, 0);
