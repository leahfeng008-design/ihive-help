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
const syncConcurrency = Math.max(1, Number(process.env.FEISHU_SYNC_CONCURRENCY || 1));
const requestIntervalMs = Math.max(0, Number(process.env.FEISHU_REQUEST_INTERVAL_MS || 450));
let nextRequestAt = 0;

if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function throttleRequest() {
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(nextRequestAt, Date.now()) + requestIntervalMs;
  if (wait) await sleep(wait);
}

async function requestJson(url, token, options = {}, attempt = 0) {
  await throttleRequest();
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
  });
  const json = await response.json().catch(() => ({}));
  const rateLimited = response.status === 429 || /frequency limit|rate limit|too many requests/i.test(json.msg || '');
  if (rateLimited && attempt < 7) {
    const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
    await sleep(Math.max(retryAfter, Math.min(12000, 1200 * (2 ** attempt))));
    return requestJson(url, token, options, attempt + 1);
  }
  if (!response.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new Error(`飞书请求失败 ${response.status}: ${json.msg || url}`);
  }
  return json;
}

async function requestBinary(url, token, attempt = 0) {
  await throttleRequest();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 429 && attempt < 7) {
    const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
    await sleep(Math.max(retryAfter, Math.min(12000, 1200 * (2 ** attempt))));
    return requestBinary(url, token, attempt + 1);
  }
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
  const output = Array.from({ length: items.length });
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

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)}`;
}

async function downloadImage(fileToken, documentTitle) {
  const imageId = `img-${crypto.createHash('sha1').update(fileToken).digest('hex').slice(0, 12)}`;
  const fileName = `${imageId}.png`;
  const directory = path.join(root, 'public', 'kb-images');
  const destination = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true });
  try { await fs.access(destination); }
  catch { await fs.writeFile(destination, await requestBinary(`${api}/drive/v1/medias/${fileToken}/download`, token)); }
  return { imageId, src: `/kb-images/${fileName}`, alt: `${documentTitle} 操作截图` };
}

function paragraphKind(block) {
  for (let level = 1; level <= 9; level++) if (block[`heading${level}`]) return `heading${level}`;
  if (block.bullet) return 'bullet';
  if (block.ordered) return 'ordered';
  if (block.code) return 'code';
  if (block.quote) return 'quote';
  if (block.todo) return 'todo';
  return 'text';
}

function splitParagraph(text, maxLength = 1200) {
  if (text.length <= maxLength) return [text];
  const sentences = text.split(/(?<=[。！？；.!?;])\s*/).filter(Boolean);
  const output = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxLength) { output.push(current); current = sentence; }
    else current += sentence;
  }
  if (current) output.push(current);
  return output.length ? output : [text];
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
  let activeParagraph = null;
  for (const block of blocks) {
    const value = richText(block);
    if (value) {
      for (const part of splitParagraph(value)) {
        activeParagraph = {
          id: stableId('paragraph', `${meta.url}:${block.block_id || paragraphs.length}:${part}`),
          type: 'paragraph', kind: paragraphKind(block), order: paragraphs.length,
          text: part, images: [],
        };
        paragraphs.push(activeParagraph);
      }
    }
    if (block.image?.token) {
      const image = await downloadImage(block.image.token, meta.title);
      if (!activeParagraph) {
        activeParagraph = { id: stableId('paragraph', `${meta.url}:lead`), type: 'paragraph', kind: 'text', order: 0, text: meta.title, images: [] };
        paragraphs.push(activeParagraph);
      }
      activeParagraph.images.push(image);
    }
  }
  const text = paragraphs.map(paragraph => paragraph.text).join('\n').trim();
  if (!text) return null;
  return { ...meta, text, paragraphs };
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
  const paragraphs = rows.map((text, index) => ({
    id: stableId('paragraph', `assignment:${index}:${text}`), type: 'paragraph', kind: 'record', order: index, text, images: [],
  }));
  return {
    sourceType: 'assignment', category: '模块分工', path: ['分工表', '按照模块分'], title: '按照模块分',
    url: 'https://pcnpuds47gj5.feishu.cn/share/base/view/shrcnVOvM7mw8YQW2SXrk61pa4f',
    text: rows.join('\n'), paragraphs,
  };
}

function shortSummary(text, maxLength = 220) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).replace(/[，、；：\s]+$/u, '')}…`;
}

const sourceLabels = { help: '帮助知识库', prd: 'PRD', assignment: '模块分工表' };
const sourcePathPrefixes = { help: null, prd: 'PRD', assignment: '分工表' };

function createDirectory(sourceType, title, pathParts) {
  return { id: stableId('directory', `${sourceType}:${pathParts.join('/')}`), type: 'directory', sourceType, title, summary: '', path: pathParts, directories: [], articles: [] };
}

function createArticle(doc) {
  return {
    id: stableId('article', doc.url), type: 'article', sourceType: doc.sourceType,
    title: doc.title, summary: shortSummary(doc.text), url: doc.url, path: doc.path,
    directories: [], articles: [], paragraphs: doc.paragraphs,
  };
}

function buildKnowledgeTree(documents) {
  const grouped = new Map();
  for (const doc of documents) {
    const list = grouped.get(doc.sourceType) || [];
    list.push(doc); grouped.set(doc.sourceType, list);
  }
  const roots = [];
  for (const sourceType of ['help', 'prd', 'assignment']) {
    const sourceDocs = grouped.get(sourceType) || [];
    if (!sourceDocs.length) continue;
    const root = createDirectory(sourceType, sourceLabels[sourceType], [sourceLabels[sourceType]]);
    const docsByPath = new Map(sourceDocs.map(doc => [`${sourceType}:${doc.path.join('/')}`, doc]));
    for (const doc of [...sourceDocs].sort((a, b) => a.path.length - b.path.length || a.title.localeCompare(b.title, 'zh-CN'))) {
      let parts = [...doc.path];
      if (parts[0] === sourcePathPrefixes[sourceType]) parts = parts.slice(1);
      if (!parts.length) parts = [doc.title];
      let container = root;
      const walked = sourcePathPrefixes[sourceType] ? [sourcePathPrefixes[sourceType]] : [];
      for (const segment of parts.slice(0, -1)) {
        walked.push(segment);
        const parentDoc = docsByPath.get(`${sourceType}:${walked.join('/')}`);
        if (parentDoc) {
          let article = container.articles.find(item => item.url === parentDoc.url);
          if (!article) { article = createArticle(parentDoc); container.articles.push(article); }
          container = article;
        } else {
          let directory = container.directories?.find(item => item.title === segment);
          if (!directory) {
            directory = createDirectory(sourceType, segment, [...container.path, segment]);
            container.directories ??= [];
            container.directories.push(directory);
          }
          container = directory;
        }
      }
      let article = container.articles.find(item => item.url === doc.url);
      if (!article) { article = createArticle(doc); container.articles.push(article); }
      else Object.assign(article, createArticle(doc), { directories: article.directories, articles: article.articles });
    }

    const summarizeDirectory = directory => {
      for (const child of directory.directories) summarizeDirectory(child);
      const names = [...directory.directories.map(item => item.title), ...directory.articles.map(item => item.title)];
      const articleCount = countArticles(directory);
      directory.summary = `${articleCount} 篇内容${names.length ? `，涵盖：${names.slice(0, 10).join('、')}${names.length > 10 ? '等' : ''}` : ''}`;
    };
    summarizeDirectory(root);
    roots.push(root);
  }
  return roots;
}

function countArticles(container) {
  return (container.articles || []).reduce((sum, article) => sum + 1 + countArticles(article), 0)
    + (container.directories || []).reduce((sum, directory) => sum + countArticles(directory), 0);
}

function flattenKnowledge(roots) {
  const entries = [];
  const visitDirectory = (directory, directoryIds = [], articleIds = []) => {
    const nextDirectoryIds = [...directoryIds, directory.id];
    entries.push({ id: directory.id, nodeType: 'directory', sourceType: directory.sourceType, title: directory.title, path: directory.path, summary: directory.summary, directoryIds: nextDirectoryIds, articleIds });
    for (const child of directory.directories) visitDirectory(child, nextDirectoryIds, articleIds);
    for (const article of directory.articles) visitArticle(article, nextDirectoryIds, articleIds);
  };
  const visitArticle = (article, directoryIds, articleIds) => {
    const nextArticleIds = [...articleIds, article.id];
    entries.push({ id: article.id, nodeType: 'article', sourceType: article.sourceType, title: article.title, path: article.path, summary: article.summary, url: article.url, directoryIds, articleIds: nextArticleIds });
    for (const directory of article.directories || []) visitDirectory(directory, directoryIds, nextArticleIds);
    for (const paragraph of article.paragraphs) entries.push({ id: paragraph.id, nodeType: 'paragraph', sourceType: article.sourceType, title: article.title, path: article.path, text: paragraph.text, kind: paragraph.kind, url: article.url, images: paragraph.images, directoryIds, articleIds: nextArticleIds });
    for (const child of article.articles) visitArticle(child, directoryIds, nextArticleIds);
  };
  for (const root of roots) visitDirectory(root);
  return entries;
}

function searchContent(entry) {
  return [entry.title, entry.summary, entry.text, `路径：${entry.path.join(' / ')}`].filter(Boolean).join('\n');
}

function encodeEmbedding(vector) {
  if (!Array.isArray(vector)) return vector;
  const buffer = Buffer.allocUnsafe(vector.length * 2);
  vector.forEach((value, index) => buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2));
  return buffer.toString('base64');
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
const loadedDocs = (await mapPool(docMetas, syncConcurrency, loadDocx)).filter(Boolean);
const assignment = await loadAssignmentTable().catch(error => { console.warn(`分工表同步跳过：${error.message}`); return null; });
const documents = [...loadedDocs, ...(assignment ? [assignment] : [])]
  .filter((doc, index, list) => list.findIndex(other => other.url === doc.url) === index)
  .sort((a, b) => `${a.sourceType}/${a.category}/${a.title}`.localeCompare(`${b.sourceType}/${b.category}/${b.title}`, 'zh-CN'));
if (!documents.length) throw new Error('三个飞书来源均不可读，已保留现有本地知识库');

const knowledgeTarget = path.join(root, 'data', 'knowledge.json');
const indexTarget = path.join(root, 'data', 'vector-index.json');
const catalogTarget = path.join(root, 'data', 'catalog.json');
await fs.mkdir(path.dirname(knowledgeTarget), { recursive: true });
const roots = buildKnowledgeTree(documents);
const flatEntries = flattenKnowledge(roots);
const sourceHash = crypto.createHash('sha256').update(JSON.stringify(roots)).digest('hex');
const knowledge = { version: 2, generatedAt: new Date().toISOString(), sourceHash, roots };
const knowledgeJson = `${JSON.stringify(knowledge, null, 2)}\n`;
let previousKnowledge = '';
try { previousKnowledge = await fs.readFile(knowledgeTarget, 'utf8'); } catch {}
let previousIndex = null;
try { previousIndex = JSON.parse(await fs.readFile(indexTarget, 'utf8')); } catch {}

const previousEmbeddings = new Map((previousIndex?.entries || []).map(entry => [entry.id, entry]));
const indexEntries = flatEntries.map(entry => {
  const contentHash = crypto.createHash('sha256').update(searchContent(entry)).digest('hex');
  const previous = previousEmbeddings.get(entry.id);
  const reusable = previousIndex?.model === embeddingModel && previous?.contentHash === contentHash && previous.embedding?.length;
  return { id: entry.id, nodeType: entry.nodeType, contentHash, embedding: reusable ? previous.embedding : null };
});
const missing = indexEntries.map((entry, index) => ({ entry, index })).filter(item => !item.entry.embedding);
let newVectors = null;
try { newVectors = await embed(missing.map(item => searchContent(flatEntries[item.index]))); }
catch (error) { console.warn(`向量生成跳过：${error.message}`); }
if (newVectors) missing.forEach((item, index) => { item.entry.embedding = newVectors[index] || null; });
const storedEntries = indexEntries.map(entry => ({ ...entry, embedding: encodeEmbedding(entry.embedding) }));
const vectorIndexBase = {
  version: 2, sourceHash, encoding: 'int16-base64', scale: 32767,
  model: storedEntries.some(entry => entry.embedding) ? embeddingModel : null,
  dimensions: newVectors?.[0]?.length || previousIndex?.dimensions || 0,
  entries: storedEntries,
};
const previousComparable = previousIndex ? { ...previousIndex, generatedAt: undefined } : null;
const indexUnchanged = JSON.stringify(previousComparable) === JSON.stringify(vectorIndexBase);
const vectorIndex = indexUnchanged ? previousIndex : { ...vectorIndexBase, generatedAt: new Date().toISOString() };

const catalog = flatEntries.filter(entry => entry.nodeType !== 'paragraph').map(entry => ({
  id: entry.id, type: entry.nodeType, source: entry.sourceType, title: entry.title,
  summary: entry.summary, url: entry.url, path: entry.path,
  parentId: entry.nodeType === 'article' ? entry.articleIds.at(-2) || entry.directoryIds.at(-1) : entry.directoryIds.at(-2) || null,
}));
const indexJson = `${JSON.stringify(vectorIndex, null, 2)}\n`;
const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
let previousCatalog = '';
try { previousCatalog = await fs.readFile(catalogTarget, 'utf8'); } catch {}
let previousSourceHash = null;
try { previousSourceHash = JSON.parse(previousKnowledge).sourceHash; } catch {}
if (previousSourceHash !== sourceHash) await fs.writeFile(knowledgeTarget, knowledgeJson);
if (!indexUnchanged) await fs.writeFile(indexTarget, indexJson);
if (previousCatalog !== catalogJson) await fs.writeFile(catalogTarget, catalogJson);

console.log(JSON.stringify({
  changed: previousSourceHash !== sourceHash || !indexUnchanged || previousCatalog !== catalogJson,
  documents: documents.length,
  directories: flatEntries.filter(entry => entry.nodeType === 'directory').length,
  articles: flatEntries.filter(entry => entry.nodeType === 'article').length,
  paragraphs: flatEntries.filter(entry => entry.nodeType === 'paragraph').length,
  vectors: vectorIndex.entries.filter(entry => entry.embedding).length,
  reusedVectors: indexEntries.filter(entry => previousEmbeddings.get(entry.id)?.embedding === entry.embedding).length,
  images: flatEntries.filter(entry => entry.nodeType === 'paragraph').reduce((sum, entry) => sum + (entry.images?.length || 0), 0),
  sources: documents.reduce((result, doc) => ({ ...result, [doc.sourceType]: (result[doc.sourceType] || 0) + 1 }), {}),
}));
