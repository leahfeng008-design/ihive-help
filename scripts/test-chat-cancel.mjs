import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

// Exercise the real component handlers with deferred responses, including a
// transport that ignores abort and completes after the replacement request.
const source = fs.readFileSync('app/page.tsx', 'utf8');
const handlers = source.slice(source.indexOf('  async function ask'), source.indexOf('  function submit'));
const pending = [];
const context = vm.createContext({ AbortController, requestAnimationFrame: f => f(), useEffect: () => {},
  fetch: (url, options) => new Promise(resolve => pending.push({ options, resolve })),
});
vm.runInContext(`let messages = [], input = '', loading = false;
const controllerRef = {current:null}, inputRef = {current:{focus(){}}};
const setMessages = value => {messages = typeof value === 'function' ? value(messages) : value};
const setInput = value => {input = typeof value === 'function' ? value(input) : value};
const setLoading = value => {loading = value};`, context);
vm.runInContext(ts.transpile(handlers, {target: ts.ScriptTarget.ES2022}), context);
const first = vm.runInContext(`ask('怎么提交情节')`, context);
vm.runInContext('stop()', context);
assert.equal(pending[0].options.signal.aborted, true);
assert.equal(vm.runInContext('loading', context), false);
assert.equal(vm.runInContext('input', context), '怎么提交情节');
const second = vm.runInContext(`ask('怎么提交请假')`, context);
assert.deepEqual(JSON.parse(pending[1].options.body).messages, [{role:'user',content:'怎么提交请假'}]);
pending[0].resolve({ok:true,json:async()=>({answer:'旧的错误答案'})});
await first;
assert.equal(vm.runInContext('loading', context), true);
assert.ok(!vm.runInContext('JSON.stringify(messages)', context).includes('旧的错误答案'));
pending[1].resolve({ok:true,json:async()=>({answer:'新的请假答案'})});
await second;
assert.equal(vm.runInContext('loading', context), false);
assert.ok(vm.runInContext('JSON.stringify(messages)', context).includes('新的请假答案'));
const third = vm.runInContext(`ask('旧问题')`, context);
vm.runInContext('reset()', context);
pending[2].resolve({ok:true,json:async()=>({answer:'不应出现'})});
await third;
assert.equal(vm.runInContext('messages.length', context), 0);
console.log('PASS: stop aborts, restores editable text, permits immediate resend, excludes cancelled history, ignores stale responses, and reset stays empty.');
