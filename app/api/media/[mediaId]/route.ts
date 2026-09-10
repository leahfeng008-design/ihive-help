import knowledgeJson from '../../../../data/knowledge.json';
import { isFeishuAuthRequired, readFeishuSession } from '../../../../lib/feishu-auth';

type Video = { videoId: string; token: string; name: string };
type KnowledgeNode = { videos?: Video[]; roots?: KnowledgeNode[]; directories?: KnowledgeNode[]; articles?: KnowledgeNode[]; paragraphs?: KnowledgeNode[] };

const api = 'https://open.feishu.cn/open-apis';

function findVideo(node: KnowledgeNode, mediaId: string): Video | null {
  const direct = node.videos?.find(video => video.videoId === mediaId);
  if (direct) return direct;
  for (const key of ['roots', 'directories', 'articles', 'paragraphs'] as const) {
    for (const child of node[key] || []) {
      const video = findVideo(child, mediaId);
      if (video) return video;
    }
  }
  return null;
}

async function tenantAccessToken() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('飞书媒体服务尚未配置');
  const response = await fetch(`${api}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const result = await response.json() as { tenant_access_token?: string };
  if (!response.ok || !result.tenant_access_token) throw new Error('无法连接飞书媒体服务');
  return result.tenant_access_token;
}

export async function GET(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  try {
    if (isFeishuAuthRequired() && !(await readFeishuSession(request))) {
      return Response.json({ error: '请先登录飞书账号' }, { status: 401 });
    }
    const { mediaId } = await params;
    if (!/^video-[a-f\d]{12}$/.test(mediaId)) return Response.json({ error: '视频不存在' }, { status: 404 });
    const video = findVideo(knowledgeJson as KnowledgeNode, mediaId);
    if (!video) return Response.json({ error: '视频不存在' }, { status: 404 });
    const token = await tenantAccessToken();
    const range = request.headers.get('range');
    const upstream = await fetch(`${api}/drive/v1/medias/${encodeURIComponent(video.token)}/download`, {
      headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) },
    });
    if (!upstream.ok || !upstream.body) return Response.json({ error: '视频暂时无法播放' }, { status: 502 });
    const headers = new Headers({
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(video.name)}`,
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '视频暂时无法播放' }, { status: 500 });
  }
}
