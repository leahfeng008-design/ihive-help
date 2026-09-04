import knowledgeJson from '../../../data/knowledge.json';
import vectorIndexJson from '../../../data/vector-index.json';
import { isFeishuAuthRequired, readFeishuSession } from '../../../lib/feishu-auth';

type Image = { imageId: string; src: string; alt: string };
type Paragraph = { id: string; type: 'paragraph'; kind?: string; order: number; text: string; images: Image[] };
type Article = { id: string; type: 'article'; sourceType: SourceType; title: string; summary: string; url: string; path: string[]; directories?: Directory[]; articles: Article[]; paragraphs: Paragraph[] };
type Directory = { id: string; type: 'directory'; sourceType: SourceType; title: string; summary: string; path: string[]; directories: Directory[]; articles: Article[] };
type KnowledgeTree = { version: number; generatedAt?: string | null; sourceHash?: string; roots: Directory[] };
type IndexEntry = { id: string; nodeType: NodeType; contentHash?: string; embedding?: number[] | null };
type VectorIndex = { version?: number; model?: string | null; dimensions?: number; entries?: IndexEntry[] };
type Message = { role: 'user' | 'assistant'; content: string };
type SourceType = 'help' | 'prd' | 'assignment';
type NodeType = 'directory' | 'article' | 'paragraph';
type SearchNode = {
  id: string; nodeType: NodeType; sourceType: SourceType; title: string; summary?: string; text?: string;
  url?: string; path: string[]; images: Image[]; directoryIds: string[]; articleIds: string[]; embedding?: number[] | null;
};
type RankedNode = { node: SearchNode; lexical: number; semantic: number; hierarchy: number; score: number };
type RetrievalResult = { directories: RankedNode[]; articles: RankedNode[]; paragraphs: RankedNode[]; confidence: 'high' | 'medium' | 'low'; method: 'hierarchical-hybrid-vector' | 'hierarchical-lexical' };

const knowledge = knowledgeJson as KnowledgeTree;
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

function queryTokens(value: string) {
  const normalized = normalize(value);
  const output = new Set<string>();
  for (const segment of normalized.split(' ').filter(Boolean)) {
    if (/^[a-z\d]+$/i.test(segment)) output.add(segment);
    else {
      if (segment.length <= 6) output.add(segment);
      for (let size = 2; size <= Math.min(4, segment.length); size++) {
        for (let index = 0; index + size <= segment.length; index++) output.add(segment.slice(index, index + size));
      }
    }
  }
  return [...output];
}

function lexicalScore(question: string, node: SearchNode) {
  const tokens = queryTokens(question);
  if (!tokens.length) return 0;
  const title = normalize(`${node.title} ${node.path.join(' ')}`);
  const summary = normalize(node.summary || '');
  const body = normalize(node.text || '');
  let matched = 0;
  let possible = 0;
  for (const token of tokens) {
    const weight = Math.min(4, Math.max(1, token.length - 1));
    possible += weight;
    if (title.includes(token)) matched += weight;
    else if (summary.includes(token)) matched += weight * .72;
    else if (body.includes(token)) matched += weight * .5;
  }
  const phrase = normalize(question);
  const exact = phrase.length > 1 && title.includes(phrase) ? .32 : phrase.length > 1 && (summary.includes(phrase) || body.includes(phrase)) ? .2 : 0;
  return Math.min(1, matched / possible + exact);
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
      input, ...(dimensions ? { dimensions } : {}), ...(inputType ? { input_type: inputType } : {}),
    }),
  });
  if (!response.ok) return null;
  const json = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  return [...(json.data || [])].sort((a, b) => a.index - b.index).map(item => item.embedding);
}

function flattenKnowledge(tree: KnowledgeTree) {
  const nodes: SearchNode[] = [];
  const visitDirectory = (directory: Directory, directoryIds: string[] = [], articleIds: string[] = []) => {
    const nextDirectoryIds = [...directoryIds, directory.id];
    nodes.push({ id: directory.id, nodeType: 'directory', sourceType: directory.sourceType, title: directory.title, summary: directory.summary, path: directory.path, images: [], directoryIds: nextDirectoryIds, articleIds });
    for (const child of directory.directories || []) visitDirectory(child, nextDirectoryIds, articleIds);
    for (const article of directory.articles || []) visitArticle(article, nextDirectoryIds, articleIds);
  };
  const visitArticle = (article: Article, directoryIds: string[], articleIds: string[]) => {
    const nextArticleIds = [...articleIds, article.id];
    nodes.push({ id: article.id, nodeType: 'article', sourceType: article.sourceType, title: article.title, summary: article.summary, url: article.url, path: article.path, images: [], directoryIds, articleIds: nextArticleIds });
    for (const directory of article.directories || []) visitDirectory(directory, directoryIds, nextArticleIds);
    for (const paragraph of article.paragraphs || []) nodes.push({ id: paragraph.id, nodeType: 'paragraph', sourceType: article.sourceType, title: article.title, text: paragraph.text, url: article.url, path: article.path, images: paragraph.images || [], directoryIds, articleIds: nextArticleIds });
    for (const child of article.articles || []) visitArticle(child, directoryIds, nextArticleIds);
  };
  for (const root of tree.roots || []) visitDirectory(root);
  const embeddingById = new Map((storedIndex.entries || []).map(entry => [entry.id, entry.embedding]));
  for (const node of nodes) node.embedding = embeddingById.get(node.id);
  return nodes;
}

const searchNodes = flattenKnowledge(knowledge);

function rankNodes(question: string, nodes: SearchNode[], queryVector: number[] | null, hierarchyScore: (node: SearchNode) => number = () => 0) {
  return nodes.map(node => {
    const lexical = lexicalScore(question, node);
    const semantic = queryVector && node.embedding?.length ? Math.max(0, cosine(queryVector, node.embedding)) : 0;
    const hierarchy = hierarchyScore(node);
    const score = semantic * .58 + lexical * .34 + hierarchy * .08;
    return { node, lexical, semantic, hierarchy, score };
  }).sort((a, b) => b.score - a.score);
}

async function retrieve(question: string): Promise<RetrievalResult> {
  const hasVectors = searchNodes.some(node => node.embedding?.length);
  const queryVector = hasVectors ? (await embeddings([question], storedIndex.dimensions, 'search_query'))?.[0] || null : null;
  const directories = rankNodes(question, searchNodes.filter(node => node.nodeType === 'directory'), queryVector).slice(0, 4);
  const directoryScores = new Map(directories.map(item => [item.node.id, item.score]));
  const articles = rankNodes(question, searchNodes.filter(node => node.nodeType === 'article'), queryVector, node =>
    Math.max(0, ...node.directoryIds.map(id => directoryScores.get(id) || 0)),
  ).slice(0, 8);
  const articleScores = new Map(articles.map(item => [item.node.id, item.score]));
  const rankedParagraphs = rankNodes(question, searchNodes.filter(node => node.nodeType === 'paragraph'), queryVector, node =>
    Math.max(0, ...node.articleIds.map(id => articleScores.get(id) || 0)),
  );
  const best = rankedParagraphs[0]?.score || 0;
  if (best < .015) return {
    directories, articles, paragraphs: [], confidence: 'low',
    method: queryVector ? 'hierarchical-hybrid-vector' : 'hierarchical-lexical',
  };
  const limit = best >= .12 ? Math.max(.06, best * .52) : 0;
  const selected: RankedNode[] = [];
  const perArticle = new Map<string, number>();
  for (const item of rankedParagraphs) {
    if (selected.length >= 6 || (selected.length >= 2 && item.score < limit)) break;
    const articleId = item.node.articleIds.at(-1) || item.node.url || item.node.id;
    const count = perArticle.get(articleId) || 0;
    if (count >= 3) continue;
    selected.push(item); perArticle.set(articleId, count + 1);
  }
  return {
    directories, articles, paragraphs: selected,
    confidence: best >= .48 ? 'high' : best >= .22 ? 'medium' : 'low',
    method: queryVector ? 'hierarchical-hybrid-vector' : 'hierarchical-lexical',
  };
}

function sourceLabel(sourceType: SourceType) {
  if (sourceType === 'prd') return 'PRD';
  if (sourceType === 'assignment') return '分工表';
  return '帮助文档';
}

function requiredImages(matches: RankedNode[]) {
  return [...new Map(matches.flatMap(match => match.node.images).map(image => [image.imageId, image])).values()];
}

function ensureImageMarkers(answer: string, images: Image[]) {
  const missing = images.filter(image => !answer.includes(`[[IMAGE:${image.imageId}]]`));
  if (!missing.length) return answer;
  return `${answer.trim()}\n\n相关操作截图：\n${missing.map(image => `[[IMAGE:${image.imageId}]]`).join('\n')}`;
}

async function generate(question: string, retrieval: Awaited<ReturnType<typeof retrieve>>) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const context = retrieval.paragraphs.map((match, index) => {
    const node = match.node;
    return `[${index + 1}] 来源：${sourceLabel(node.sourceType)}\n目录路径：${node.path.join(' / ')}\n文章：${node.title}\n精确段落：${node.text}\n本段图片：${node.images.map(image => `${image.imageId}（${image.alt}）`).join('、') || '无'}\n匹配分：${match.score.toFixed(3)}`;
  }).join('\n\n');
  const response = await fetch(`${openRouterEndpoint}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://ihive-help-assistant-rebuilt.leahfeng008.chatgpt.site', 'X-Title': 'iHive Help Assistant' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini', temperature: .1,
      messages: [
        { role: 'system', content: '你是 iHive 帮助助手。资料已经按“目录 → 文章 → 精确段落”逐级检索。只能依据提供的精确段落作答：帮助文档用于操作步骤，PRD 用于产品规则，分工表用于负责人和归属。先直接回答，再按需要归纳为简洁步骤；保留原文中的端类型、前提和限制，禁止补充资料之外的事实。引用到带图片的段落时，必须紧跟相关步骤输出该段的 [[IMAGE:图片ID]]，不得遗漏、改写 ID 或集中解释图片。如果匹配置信度低或段落不足，明确说未找到完整说明，只给最接近的内容。' },
        { role: 'user', content: `检索置信度：${retrieval.confidence}\n\n精确资料：\n${context}\n\n用户问题：${question}` },
      ],
    }),
  });
  if (!response.ok) throw new Error('OpenRouter 服务暂时不可用');
  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return result.choices?.[0]?.message?.content || null;
}

function fallbackAnswer(retrieval: Awaited<ReturnType<typeof retrieve>>) {
  if (!retrieval.paragraphs.length) return '本地知识库中没有找到相关段落。';
  const prefix = retrieval.confidence === 'low' ? '未找到完全匹配的说明，最接近的知识库内容是：\n\n' : '';
  return prefix + retrieval.paragraphs.slice(0, 3).map(match => {
    const markers = match.node.images.map(image => `\n[[IMAGE:${image.imageId}]]`).join('');
    return `${match.node.text}${markers}`;
  }).join('\n\n');
}

export async function POST(request: Request) {
  try {
    if (isFeishuAuthRequired() && !(await readFeishuSession(request))) return Response.json({ error: '请先登录飞书账号' }, { status: 401 });
    const body = await request.json() as { messages?: Message[] };
    const question = body.messages?.at(-1)?.content?.trim();
    if (!question) return Response.json({ error: '请输入问题' }, { status: 400 });
    if (!searchNodes.some(node => node.nodeType === 'paragraph')) return Response.json({ error: '知识库暂无可检索段落' }, { status: 503 });
    const retrieval = await retrieve(question);
    const images = requiredImages(retrieval.paragraphs);
    const generated = retrieval.paragraphs.length ? await generate(question, retrieval) : null;
    const answer = ensureImageMarkers(generated || fallbackAnswer(retrieval), images);
    const sources = [...new Map(retrieval.paragraphs.map(match => [match.node.url, {
      title: match.node.title, url: match.node.url, path: match.node.path, sourceType: match.node.sourceType,
    }])).values()].filter(source => source.url).slice(0, 5);
    return Response.json({
      answer, sources, images,
      retrieval: {
        method: retrieval.method, confidence: retrieval.confidence,
        directories: retrieval.directories.map(item => ({ title: item.node.title, score: item.score })),
        articles: retrieval.articles.map(item => ({ title: item.node.title, score: item.score })),
        paragraphIds: retrieval.paragraphs.map(item => item.node.id),
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '服务暂时不可用' }, { status: 500 });
  }
}
