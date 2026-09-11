import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

const fixture = JSON.parse(
  fs.readFileSync('data/conversation-evaluation-100.json', 'utf8'),
);
assert.equal(fixture.cases.length, 25);
assert.equal(
  fixture.cases.reduce((sum, item) => sum + item.turns.length, 0),
  100,
);

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
  Response,
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

const resolve = (messages) =>
  vm.runInContext(`resolveConversation(${JSON.stringify(messages)})`, context);
const user = (content) => ({ role: 'user', content });
const contains = (value, expected) => !expected || value.includes(expected);
const results = [];
let turnNumber = 0;

for (const scenario of fixture.cases) {
  const history = [];
  let rootBaseQuestion = '';
  for (const turn of scenario.turns) {
    history.push(user(turn.user));
    const actual = resolve(history);
    const expected = turn.expect;
    turnNumber++;
    if (!rootBaseQuestion) rootBaseQuestion = actual.baseQuestion;
    const checks = {
      topic: actual.baseQuestion === rootBaseQuestion,
      brief: expected.brief === undefined || actual.brief === expected.brief,
      detailed:
        expected.detailed === undefined ||
        actual.detailed === expected.detailed,
      platform:
        expected.platform === undefined ||
        actual.platform.toLowerCase() === expected.platform.toLowerCase(),
      imageRequest:
        expected.imageRequest === undefined ||
        actual.imageRequest === expected.imageRequest,
      context: !actual.needsContext,
    };
    assert.ok(
      Object.values(checks).every(Boolean),
      JSON.stringify(
        {
          turnNumber,
          scenario: scenario.id,
          user: turn.user,
          actual,
          expected,
          checks,
        },
        null,
        2,
      ),
    );
    results.push({
      turnNumber,
      scenario: scenario.id,
      user: turn.user,
      resolved: actual,
      checks,
    });
    history.push({ role: 'assistant', content: '已根据当前主题回答。' });
  }
}

const output =
  process.env.EVAL_OUTPUT || 'reports/conversation-evaluation-100.json';
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      fixture: 'data/conversation-evaluation-100.json',
      turnCount: results.length,
      results,
    },
    null,
    2,
  ),
);
console.log(
  `PASS: ${results.length}/100 contextual customer turns resolved correctly.`,
);
console.log(`Saved ${output}`);
