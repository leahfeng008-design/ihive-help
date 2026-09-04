import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

const root = process.cwd();
const api = 'https://open.feishu.cn/open-apis';
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const helpSpaceId = process.env.FEISHU_SPACE_ID || '7631047892841581526';
const prdFolderToken = process.env.FEISHU_PRD_FOLDER_TOKEN || 'PR5PfctoSl0654dXZzzcZPaKnOb';
const assignmentAppToken = process.env.FEISHU_ASSIGNMENT_APP_TOKEN || 'IQTIbgVvIa9thdsuOi0cbUXanRc';
const assignmentTableId = process.env.FEISHU_ASSIGNMENT_TABLE_ID || 'tblinkja1AwTvKno';
const assignmentViewId = process.env.FEISHU_ASSIGNMENT_VIEW_ID || 'vewRZe7CUJ';
const openRouterKey = process.env.OPENROUTER_API_KEY;
const embeddingModel = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const embeddingDimensions = Number(process.env.OPENROUTER_EMBEDDING_DIMENSIONS || 256);

if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new Error(`飞书请求失败 ${response.status}: ${json.msg || url}`);
  }
  return json;
}

async function requestBinary(url, token) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`飞书图片下载失败 ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const tokenResponse = await fetch(`${api}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const tokenResult = await tokenResponse.json();
if (!tokenResponse.ok || !tokenResult.tenant_access_token) throw new Error('无法获取飞书 tenant_access_token');
const token = tokenResult.tenant_access_token;

async function mapPool(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { output[index] = await worker(items[index], index); }
      catch (error) { console.warn(`跳过：${items[index]?.title || items[index]?.name || index} - ${error.message}`); output[index] = null; }
    }
  }));
  return output;
}

async function listWikiNodes(parentNodeToken = '', parents = []) {
  const result = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ page_size: '50' });
    if (parentNodeToken) params.set('parent_node_token', parentNodeToken);
    if (pageToken) params.set('page_token', pageToken);
    const json = await requestJson(`${api}/wiki/v2/spaces/${helpSpaceId}/nodes?${params}`, token);
    const items = json.data?.items || [];
    for (const item of items) {
      const pathNames = [...parents, item.title];
      result.push({
        sourceType: 'help',
        category: parents[0] || (item.has_child ? item.title : '知识库规范'),
        path: pathNames,
        title: item.title,
        url: `https://pcnpuds47gj5.feishu.cn/wiki/${item.node_token}`,
        nodeToken: item.node_token,
        objToken: item.obj_token,
        objType: item.obj_type,
        hasChild: !!item.has_child,
      });
      if (item.has_child) result.push(...await listWikiNodes(item.node_token, pathNames));
    }
    pageToken = json.data?.has_more ? json.data?.page_token || '' : '';
  } while (pageToken);
  return result;
}

async function listDriveFolder(folderToken, parents = ['PRD']) {
  const result = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ folder_token: folderToken, page_size: '200' });
    if (pageToken) params.set('page_token', pageToken);
    const json = await requestJson(`${api}/drive/v1/files?${params}`, token);
    const files = json.data?.files || [];
    for (const file of files) {
      const filePath = [...parents, file.name];
      const meta = {
        sourceType: 'prd',
        category: parents.at(-1) || 'PRD',
        path: filePath,
        title: file.name,
        url: file.url || `https://pcnpuds47gj5.feishu.cn/${file.type}/${file.token}`,
        objToken: file.token,
        objType: file.type,
        hasChild: file.type === 'folder',
      };
      result.push(meta);
      if (file.type === 'folder') result.push(...await listDriveFolder(file.token, filePath));
    }
    pageToken = json.data?.has_more ? json.data?.next_page_token || '' : '';
  } while (pageToken);
  return result;
}

function richText(block) {
  const rich = block.text || block.heading1 || block.heading2 || block.heading3 || block.heading4 || block.heading5 || block.heading6 || block.heading7 || block.heading8 || block.heading9 || block.bullet || block.ordered || block.quote || block.todo || block.code;
  return (rich?.elements || []).map((element) =>
    element.text_run?.content ||
    element.mention_doc?.title ||
    element.mention_user?.user_id ||
    element.reminder?.text ||
    element.equation?.content || ''
  ).join('').replace(/\u200b/g, '').trim();
}

async function downloadImage(fileToken, documentTitle, lastText) {
  const imageId = `img-${crypto.createHash('sha1').update(fileToken).digest('hex').slice(0, 12)}`;
  const fileName = `${imageId}.png`;
  const directory = path.join(root, 'public', 'kb-images');
  const destination = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true });
  try { await fs.access(destination); }
  catch { await fs.writeFile(destination, await requestBinary(`${api}/drive/v1/medias/${fileToken}/download`, token)); }
  return { imageId, src: `/kb-images/${fileName}`, alt: `${documentTitle} 操作截图`, after: lastText };
}

async function loadDocx(meta) {
  if (meta.objType !== 'docx') return null;
  let pageToken = '';
  const blocks = [];
  do {
    const params = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
    if (pageToken) params.set('page_token', pageToken);
    const json = await requestJson(`${api}/docx/v1/documents/${meta.objToken}/blocks?${params}`, token);
    blocks.push(...(json.data?.items || []));
    pageToken = json.data?.has_more ? json.data?.page_token || '' : '';
  } while (pageToken);

  const paragraphs = [];
  const images = [];
  let lastText = meta.title;
  for (const block of blocks) {
    const value = richText(block);
    if (value) { paragraphs.push(value); lastText = value; }
    if (block.image?.token) images.push(await downloadImage(block.image.token, meta.title, lastText));
  }
  const text = paragraphs.join('\n').trim();
  if (!text) return null;
  return { ...meta, text, images };
}

function fieldText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join('、');
  if (typeof value === 'object') return value.text || value.name || value.link || value.url || Object.values(value).map(fieldText).filter(Boolean).join('、');
  return '';
}

async function loadAssignmentTable() {
  const rows = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ page_size: '500', view_id: assignmentViewId });
    if (pageToken) params.set('page_token', pageToken);
    const json = await requestJson(`${api}/bitable/v1/apps/${assignmentAppToken}/tables/${assignmentTableId}/records?${params}`, token);
    for (const item of json.data?.items || []) {
      const fields = Object.entries(item.fields || {}).map(([key, value]) => `${key}：${fieldText(value)}`).filter(line => !line.endsWith('：'));
      if (fields.length) rows.push(fields.join('；'));
    }
    pageToken = json.data?.has_more ? json.data?.page_token || '' : '';
  } while (pageToken);
  if (!rows.length) return null;
  return {
    sourceType: 'assignment', category: '模块分工', path: ['分工表', '按照模块分'], title: '按照模块分',
    url: 'https://pcnpuds47gj5.feishu.cn/share/base/view/shrcnVOvM7mw8YQW2SXrk61pa4f',
    text: rows.join('\n'), images: [],
  };
}

function splitText(text, maxLength = 900, overlap = 120) {
  const paragraphs = text.split(/\n+/).map(value => value.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > maxLength) {
      chunks.push(current);
      current = `${current.slice(-overlap)}\n${paragraph}`;
    } else current += `${current ? '\n' : ''}${paragraph}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function createChunks(documents) {
  return documents.flatMap((doc, documentIndex) => splitText(doc.text).map((text, chunkIndex) => ({
    id: `chunk-${crypto.createHash('sha1').update(`${doc.url}:${chunkIndex}:${text}`).digest('hex').slice(0, 16)}`,
    documentIndex,
    sourceType: doc.sourceType,
    category: doc.category,
    title: doc.title,
    url: doc.url,
    text,
    imageIds: (doc.images || []).filter(image => image.after && text.includes(image.after)).map(image => image.imageId),
  })));
}

async function embed(texts) {
  if (!openRouterKey || !texts.length) return null;
  const vectors = [];
  for (let start = 0; start < texts.length; start += 40) {
    const input = texts.slice(start, start + 40);
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${openRouterKey}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://ihive-help-assistant-rebuilt.leahfeng008.chatgpt.site', 'X-Title': 'iHive Help Assistant' },
      body: JSON.stringify({ model: embeddingModel, dimensions: embeddingDimensions, input, input_type: 'search_document' }),
    });
    if (!response.ok) throw new Error(`OpenRouter 向量接口失败 ${response.status}`);
    const json = await response.json();
    for (const item of [...(json.data || [])].sort((a, b) => a.index - b.index)) vectors.push(item.embedding);
  }
  return vectors;
}

const wikiNodes = await listWikiNodes().catch(error => { console.warn(`帮助知识库同步跳过：${error.message}`); return []; });
const prdFiles = await listDriveFolder(prdFolderToken).catch(error => { console.warn(`PRD 同步跳过：${error.message}`); return []; });
const docMetas = [...wikiNodes, ...prdFiles].filter(item => item.objType === 'docx');
const loadedDocs = (await mapPool(docMetas, 5, loadDocx)).filter(Boolean);
const assignment = await loadAssignmentTable().catch(error => { console.warn(`分工表同步跳过：${error.message}`); return null; });
const documents = [...loadedDocs, ...(assignment ? [assignment] : [])]
  .filter((doc, index, list) => list.findIndex(other => other.url === doc.url) === index)
  .sort((a, b) => `${a.sourceType}/${a.category}/${a.title}`.localeCompare(`${b.sourceType}/${b.category}/${b.title}`, 'zh-CN'));
if (!documents.length) throw new Error('三个飞书来源均不可读，已保留现有本地知识库');

const knowledgeTarget = path.join(root, 'data', 'knowledge.json');
const indexTarget = path.join(root, 'data', 'vector-index.json');
const catalogTarget = path.join(root, 'data', 'catalog.json');
await fs.mkdir(path.dirname(knowledgeTarget), { recursive: true });
const knowledgeJson = `${JSON.stringify(documents, null, 2)}\n`;
let previousKnowledge = '';
try { previousKnowledge = await fs.readFile(knowledgeTarget, 'utf8'); } catch {}
const sourceHash = crypto.createHash('sha256').update(knowledgeJson).digest('hex');
let previousIndex = null;
try { previousIndex = JSON.parse(await fs.readFile(indexTarget, 'utf8')); } catch {}

let vectorIndex = previousIndex;
if (!previousIndex || previousIndex.sourceHash !== sourceHash) {
  const chunks = createChunks(documents);
  let vectors = null;
  try { vectors = await embed(chunks.map(chunk => `${chunk.title}\n类目：${chunk.category}\n${chunk.text}`)); }
  catch (error) { console.warn(`向量生成跳过：${error.message}`); }
  vectorIndex = {
    generatedAt: new Date().toISOString(), sourceHash, model: vectors ? embeddingModel : null,
    dimensions: vectors?.[0]?.length || 0,
    chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors?.[index] || null })),
  };
}

const catalog = [
  ...wikiNodes.map(item => ({ source: 'help', category: item.category, title: item.title, nodeToken: item.nodeToken, url: item.url, level: item.path.length, path: item.path })),
  ...prdFiles.map(item => ({ source: 'prd', category: item.category, title: item.title, url: item.url, level: item.path.length, path: item.path })),
  { source: 'assignment', category: '模块分工', title: '按照模块分', url: 'https://pcnpuds47gj5.feishu.cn/share/base/view/shrcnVOvM7mw8YQW2SXrk61pa4f', level: 1, path: ['分工表', '按照模块分'] },
];
const indexJson = `${JSON.stringify(vectorIndex, null, 2)}\n`;
const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
let previousCatalog = '';
try { previousCatalog = await fs.readFile(catalogTarget, 'utf8'); } catch {}
if (previousKnowledge !== knowledgeJson) await fs.writeFile(knowledgeTarget, knowledgeJson);
if (!previousIndex || previousIndex.sourceHash !== sourceHash) await fs.writeFile(indexTarget, indexJson);
if (previousCatalog !== catalogJson) await fs.writeFile(catalogTarget, catalogJson);

console.log(JSON.stringify({
  changed: previousKnowledge !== knowledgeJson || !previousIndex || previousIndex.sourceHash !== sourceHash || previousCatalog !== catalogJson,
  documents: documents.length,
  categories: new Set(documents.map(doc => `${doc.sourceType}/${doc.category}`)).size,
  chunks: vectorIndex.chunks.length,
  vectors: vectorIndex.chunks.filter(chunk => chunk.embedding).length,
  images: documents.reduce((sum, doc) => sum + (doc.images?.length || 0), 0),
  sources: documents.reduce((result, doc) => ({ ...result, [doc.sourceType]: (result[doc.sourceType] || 0) + 1 }), {}),
}));
