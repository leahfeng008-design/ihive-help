'use client';

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ExternalLink, Plus } from 'lucide-react';

type Source = { title: string; url: string };
type ChatImage = { imageId: string; src: string; alt?: string };
type Message = { role: 'user' | 'assistant'; content: string; sources?: Source[]; images?: ChatImage[]; pending?: boolean };
type WebMcpContext = { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown }, options?: { signal?: AbortSignal }) => void | Promise<void> };
const suggestions = ['如何登录账号？','怎么设置消息免打扰？','如何在群里 @ 人？','群机器人怎么添加？','如何发起视频会议？','怎么给联系人修改备注？','如何置顶消息？','如何登录管理后台？'];

function SuggestionGrid({ onSelect, compact = false }: { onSelect: (value: string) => void; compact?: boolean }) {
  return <div className={compact ? 'suggestions compact' : 'suggestions'}>{suggestions.map((item) => <button type="button" onClick={() => onSelect(item)} key={item}>{item}</button>)}</div>;
}

function Answer({ message }: { message: Message }) {
  const images = new Map((message.images || []).map((image) => [image.imageId, image]));
  const parts = message.content.split(/\[\[IMAGE:([^\]]+)\]\]/g);
  return <><div className="answer-copy">{parts.map((part, index) => { if (index % 2 === 0) return <span key={index}>{part}</span>; const image = images.get(part); return image ? <figure className="inline-help-image" key={image.imageId}><a href={image.src} target="_blank" rel="noreferrer"><img src={image.src} alt={image.alt || '帮助文档关联图片'} /></a>{image.alt && <figcaption>{image.alt}</figcaption>}</figure> : null; })}</div>{!!message.sources?.length && <section className="references" aria-label="参考资料"><h2>为你找到 {message.sources.length} 篇参考资料</h2>{message.sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}><span>{index + 1}</span><strong>{source.title}</strong><ExternalLink size={15} /></a>)}</section>}</>;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages]);

  async function ask(value: string) {
    const question = value.trim();
    if (!question || loading) return;
    const history = messages.filter((message) => !message.pending);
    const controller = new AbortController();
    controllerRef.current = controller; setInput(''); setLoading(true);
    setMessages([...history, { role: 'user', content: question }, { role: 'assistant', content: '正在查找官方帮助文档…', pending: true }]);
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [...history, { role: 'user', content: question }] }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '请求失败');
      setMessages([...history, { role: 'user', content: question }, { role: 'assistant', content: result.answer, sources: result.sources, images: result.images }]);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessages([...history, { role: 'user', content: question }, { role: 'assistant', content: `暂时无法回答：${error instanceof Error ? error.message : '请求失败'}` }]);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }

  function reset() { controllerRef.current?.abort(); setMessages([]); setInput(''); setLoading(false); requestAnimationFrame(() => inputRef.current?.focus()); }
  function submit(event: FormEvent) { event.preventDefault(); void ask(input); }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(input); } }

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebMcpContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'ask_ihive_help', title: '咨询 iHive 帮助助手',
      description: '向当前页面的 iHive 知识库助手提问，并把问答显示在对话区。',
      inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1 } }, required: ['question'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) { const question = (input as { question?: unknown })?.question; if (typeof question !== 'string' || !question.trim()) throw new Error('question 必须是非空字符串'); void ask(question); return { status: 'started', question: question.trim() }; },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [loading, messages]);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img src="/bee-assistant.png" alt="iHive 助手" /><span>iHive 帮助助手</span></div><nav aria-label="页面操作"><button type="button" onClick={reset}><Plus size={17} />新建对话</button><a href="https://pcnpuds47gj5.feishu.cn/wiki/" target="_blank" rel="noreferrer">飞书知识库 <ExternalLink size={15} /></a></nav></header>
    <main>
      <section className={messages.length ? 'hero condensed' : 'hero'}><img src="/bee-assistant.png" alt="iHive 蜜蜂机器人助手" /><h1>iHive 帮助助手</h1><p>你好，我是 iHive 专属知识库问答助手。<br />我只基于飞书知识库回答，有问题请直接提问。</p></section>
      <section className="chat" aria-live="polite">{!messages.length && <SuggestionGrid onSelect={ask} />}{messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.role}-${index}`}>{message.role === 'assistant' && <img src="/bee-assistant.png" alt="" />}<div className={message.pending ? 'bubble pending' : 'bubble'}>{message.role === 'assistant' && !message.pending ? <Answer message={message} /> : message.content}</div></article>)}<div ref={endRef} /></section>
      <form onSubmit={submit}>{messages.some((m) => m.role === 'assistant' && !m.pending) && <SuggestionGrid compact onSelect={ask} />}<div className="composer"><textarea ref={inputRef} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={keyDown} placeholder="输入你的问题…" aria-label="输入你的问题" /><button type="submit" aria-label="发送" disabled={loading || !input.trim()}><img src="/send-icon.png" alt="" /></button></div><p className="hint">AI 可能会出错，重要信息请以飞书原文为准</p></form>
    </main>
  </div>;
}
