import knowledgeJson from '../../../data/knowledge.json';
import vectorIndexJson from '../../../data/vector-index.json';
import { isFeishuAuthRequired, readFeishuSession } from '../../../lib/feishu-auth';

type Image = { imageId: string; src: string; alt: string; after?: string };
type Source = { sourceType?: 'help' | 'prd' | 'assignment'; category?: string; title: string; url: string; text: string; images?: Image[] };
type Chunk = { id: string; documentIndex?: number; sourceType?: string; category?: string; title: string; url: string; text: string; imageIds?: string[]; embedding?: number[] | null };
type Message = { role: 'user' | 'assistant'; content: string };
type VectorIndex = { model?: string | null; dimensions?: number; chunks?: Chunk[] };

const docs = knowledgeJson as Source[];
const storedIndex = vectorIndexJson as VectorIndex;
const openRouterEndpoint = 'https://openrouter.ai/api/v1';
const aliases: Array<[RegExp, string]> = [
  [/登不上|无法登录|登入|登陆/g, '登录 账号 验证码 密码'],
  [/没声音|不提醒|静音|勿扰/g, '消息 通知 免打扰 声音'],
  [/@人|艾特|提醒某人/g, '群聊 @ 成员'],
  [/视频|开会|会议/g, '视频会议 发起会议'],
  [/拉人|加人|邀请人/g, '添加成员 邀请成员 通讯录'],
  [/机器人|bot/gi, '群机器人 BOT'],
  [/后台|管理员/g, '企业管理后台 管理员'],
  [/找消息|消息在哪/g, '消息定位 搜索'],
  [/改备注|备注名/g, '联系人 备注 通讯录'],
  [/文件|照片|截图/g, '文件 图片 收发'],
];

function normalize(value: string) {
  let text = value.toLowerCase().normalize('NFKC');
  for (const [pattern, expansion] of aliases) text = text.replace(pattern, `${expansion} `);
  return text.replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function terms(value: string) {
  const normalized = normalize(value);
  const output = new Set(normalized.split(' ').filter(Boolean));
  const compact = normalized.replace(/\s/g, '');
  for (let index = 0; index < compact.length; index++) {
    output.add(compact[index]);
    if (index + 1 < compact.length) output.add(compact.slice(index, index + 2));
    if (index + 2 < compact.length) output.add(compact.slice(index, index + 3));
  }
  return output;
}

function lexicalScore(question: string, chunk: Chunk) {
  const query = normalize(question);
  const title = normalize(`${chunk.category || ''} ${chunk.title}`);
  const body = normalize(chunk.text);
  const queryTerms = terms(question);
  if (!queryTerms.size) return 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (title.includes(term)) matched += term.length >= 2 ? 3.2 : .45;
    else if (body.includes(term)) matched += term.length >= 2 ? 1.5 : .22;
  }
  const exact = title.includes(query) ? 8 : body.includes(query) ? 5 : 0;
  return Math.min(1, (matched + exact) / Math.max(8, queryTerms.size * 1.8));
}

function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index]; normA += a[index] ** 2; normB += b[index] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function embeddings(input: string[], dimensions?: number, inputType?: 'search_query' | 'search_document') {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !input.length) return null;
  const response = await fetch(`${openRouterEndpoint}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://ihive-help-assistant-rebuilt.leahfeng008.chatgpt.site', 'X-Title': 'iHive Help Assistant' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_EMBEDDING_MODEL || storedIndex.model || 'openai/text-embedding-3-small',
      input,
      ...(dimensions ? { dimensions } : {}),
      ...(inputType ? { input_type: inputType } : {}),
    }),
  });
  if (!response.ok) return null;
  const json = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  return [...(json.data || [])].sort((a, b) => a.index - b.index).map(item => item.embedding);
}

function baseChunks(): Chunk[] {
  if (storedIndex.chunks?.length) return storedIndex.chunks;
  return docs.map((doc, index) => ({ id: `document-${index}`, documentIndex: index, sourceType: doc.sourceType, category: doc.category, title: doc.title, url: doc.url, text: doc.text, imageIds: doc.images?.map(image => image.imageId) || [], embedding: null }));
}

async function retrieve(question: string) {
  const chunks = baseChunks();
  const lexical = chunks.map(chunk => ({ chunk, lexical: lexicalScore(question, chunk), semantic: 0 }));
  const indexed = lexical.filter(item => item.chunk.embedding?.length);

  if (indexed.length) {
    const queryVector = (await embeddings([question], indexed[0].chunk.embedding?.length || storedIndex.dimensions, 'search_query'))?.[0];
    if (queryVector) for (const item of lexical) if (item.chunk.embedding) item.semantic = Math.max(0, cosine(queryVector, item.chunk.embedding));
  } else {
    const candidates = [...lexical].sort((a, b) => b.lexical - a.lexical).slice(0, 40);
    const vectors = await embeddings([question, ...candidates.map(item => `${item.chunk.title}\n类目：${item.chunk.category || '其他'}\n${item.chunk.text}`)], Number(process.env.OPENROUTER_EMBEDDING_DIMENSIONS || 256));
    if (vectors?.length === candidates.length + 1) for (let index = 0; index < candidates.length; index++) candidates[index].semantic = Math.max(0, cosine(vectors[0], vectors[index + 1]));
  }

  const ranked = lexical.map(item => {
    const categoryMatch = normalize(question).includes(normalize(item.chunk.category || '')) ? 1 : 0;
    const titleMatch = normalize(item.chunk.title).includes(normalize(question)) || normalize(question).includes(normalize(item.chunk.title)) ? 1 : 0;
    const score = item.semantic * .68 + item.lexical * .24 + Math.max(categoryMatch, titleMatch) * .08;
    return { ...item, score };
  }).sort((a, b) => b.score - a.score);

  const selected: typeof ranked = [];
  const perDocument = new Map<string, number>();
  for (const item of ranked) {
    const count = perDocument.get(item.chunk.url) || 0;
    if (count >= 2) continue;
    selected.push(item); perDocument.set(item.chunk.url, count + 1);
    if (selected.length === 8) break;
  }
  return selected;
}

function sourceLabel(sourceType?: string) {
  if (sourceType === 'prd') return 'PRD';
  if (sourceType === 'assignment') return '分工表';
  return '帮助文档';
}

async function generate(question: string, matches: Awaited<ReturnType<typeof retrieve>>) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const sourceDocs = new Map(docs.map(doc => [doc.url, doc]));
  const context = matches.map((match, index) => {
    const doc = sourceDocs.get(match.chunk.url);
    const images = (doc?.images || []).filter(image => !match.chunk.imageIds?.length || match.chunk.imageIds.includes(image.imageId));
    return `[${index + 1}] 来源：${sourceLabel(match.chunk.sourceType)} / ${match.chunk.category || '其他'}\n标题：${match.chunk.title}\n原文片段：${match.chunk.text}\n可用图片：${images.map(image => `${image.imageId}（${image.alt}，放在“${image.after || '对应步骤'}”之后）`).join('；') || '无'}`;
  }).join('\n\n');
  const response = await fetch(`${openRouterEndpoint}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://ihive-help-assistant-rebuilt.leahfeng008.chatgpt.site', 'X-Title': 'iHive Help Assistant' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini',
      temperature: .15,
      messages: [
        { role: 'system', content: '你是 iHive 帮助助手。只能依据给定的飞书帮助文档、PRD 和分工表回答。操作方法优先采用帮助文档，产品规则与设计意图可采用 PRD，负责人和模块归属采用分工表。不要补充资料中没有的事实。回答要直接、分步骤，并保持原文中的端类型和限制条件。只要存在与某一步骤直接相关的可用图片，就必须在该步骤之后单独插入 [[IMAGE:图片ID]]；图片要穿插在正文中，不能集中堆在结尾；没有相关图片时直接不展示，也不要提“缺少关联图片”。如果检索片段仍不足以回答，说明在三处知识源中未找到明确说明，并给出最接近的参考文档。' },
        { role: 'user', content: `检索资料：\n${context}\n\n用户问题：${question}` },
      ],
    }),
  });
  if (!response.ok) throw new Error('OpenRouter 服务暂时不可用');
  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return result.choices?.[0]?.message?.content || null;
}

export async function POST(request: Request) {
  try {
    if (isFeishuAuthRequired() && !(await readFeishuSession(request))) {
      return Response.json({ error: '请先登录飞书账号' }, { status: 401 });
    }
    const body = await request.json() as { messages?: Message[] };
    const question = body.messages?.at(-1)?.content?.trim();
    if (!question) return Response.json({ error: '请输入问题' }, { status: 400 });
    const matches = await retrieve(question);
    if (!matches.length) return Response.json({ error: '知识库暂无可检索内容' }, { status: 503 });
    const uniqueSources = [...new Map(matches.map(match => [match.chunk.url, { title: match.chunk.title, url: match.chunk.url, category: match.chunk.category, sourceType: match.chunk.sourceType }])).values()].slice(0, 5);
    const sourceDocs = new Map(docs.map(doc => [doc.url, doc]));
    const images = uniqueSources.flatMap(source => sourceDocs.get(source.url)?.images || []);
    const answer = await generate(question, matches) || matches.slice(0, 3).map(match => match.chunk.text).join('\n\n');
    return Response.json({ answer, sources: uniqueSources, images, retrieval: { method: matches.some(match => match.semantic > 0) ? 'hybrid-vector' : 'lexical', categories: [...new Set(matches.map(match => match.chunk.category).filter(Boolean))] } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '服务暂时不可用' }, { status: 500 });
  }
}
