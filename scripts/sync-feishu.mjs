import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

const root = process.cwd();
const api = 'https://open.feishu.cn/open-apis';
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const spaceId = process.env.FEISHU_SPACE_ID || '7631047892841581526';
if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');

async function request(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`飞书请求失败 ${response.status}: ${url}`);
  return response;
}

const tokenResponse = await fetch(`${api}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
const tokenResult = await tokenResponse.json();
if (!tokenResponse.ok || !tokenResult.tenant_access_token) throw new Error('无法获取飞书 tenant_access_token');
const token = tokenResult.tenant_access_token;

async function listNodes(parentNodeToken = '') {
  const result = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ page_size: '50' });
    if (parentNodeToken) params.set('parent_node_token', parentNodeToken);
    if (pageToken) params.set('page_token', pageToken);
    const json = await (await request(`${api}/wiki/v2/spaces/${spaceId}/nodes?${params}`, token)).json();
    const items = json.data?.items || [];
    result.push(...items);
    pageToken = json.data?.has_more ? json.data?.page_token || '' : '';
    for (const node of items) if (node.has_child) result.push(...await listNodes(node.node_token));
  } while (pageToken);
  return result;
}

function blockText(block) {
  const rich = block.text || block.heading1 || block.heading2 || block.heading3 || block.heading4 || block.heading5 || block.heading6 || block.bullet || block.ordered;
  return (rich?.elements || []).map((element) => element.text_run?.content || element.mention_user?.user_id || '').join('').trim();
}

async function loadDocument(node) {
  if (node.obj_type !== 'docx') return null;
  let pageToken = '';
  const blocks = [];
  do {
    const params = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
    if (pageToken) params.set('page_token', pageToken);
    const json = await (await request(`${api}/docx/v1/documents/${node.obj_token}/blocks?${params}`, token)).json();
    blocks.push(...(json.data?.items || []));
    pageToken = json.data?.has_more ? json.data?.page_token || '' : '';
  } while (pageToken);

  const text = [];
  const images = [];
  let lastText = '';
  for (const block of blocks) {
    const value = blockText(block);
    if (value) { text.push(value); lastText = value; }
    const fileToken = block.image?.token;
    if (fileToken) {
      const imageId = `img-${crypto.createHash('sha1').update(fileToken).digest('hex').slice(0,12)}`;
      const fileName = `${imageId}.png`;
      const response = await request(`${api}/drive/v1/medias/${fileToken}/download`, token, { headers: { 'content-type': undefined } });
      await fs.mkdir(path.join(root, 'public', 'kb-images'), { recursive: true });
      await fs.writeFile(path.join(root, 'public', 'kb-images', fileName), Buffer.from(await response.arrayBuffer()));
      images.push({ imageId, src: `/kb-images/${fileName}`, alt: `${node.title} 操作截图`, after: lastText });
    }
  }
  return { title: node.title, url: `https://pcnpuds47gj5.feishu.cn/wiki/${node.node_token}`, text: text.join('\n'), images };
}

const nodes = await listNodes();
const documents = (await Promise.all(nodes.map(loadDocument))).filter((doc) => doc?.text);
const target = path.join(root, 'data', 'knowledge.json');
await fs.mkdir(path.dirname(target), { recursive: true });
const next = `${JSON.stringify(documents, null, 2)}\n`;
let previous = '';
try { previous = await fs.readFile(target, 'utf8'); } catch {}
if (previous !== next) await fs.writeFile(target, next);
console.log(JSON.stringify({ changed: previous !== next, documents: documents.length, images: documents.reduce((sum, doc) => sum + doc.images.length, 0) }));
