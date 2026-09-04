import {
  clearStateCookie,
  createSessionCookie,
  feishuAppCredentials,
  feishuRedirectUri,
  feishuSpaceId,
  readStateCookie,
} from '../../../../../lib/feishu-auth';

type TokenResponse = { code?: number; msg?: string; access_token?: string; data?: { access_token?: string } };
type ProfileData = { open_id?: string; union_id?: string; user_id?: string; name?: string; avatar_url?: string };
type UserInfoResponse = ProfileData & { code?: number; msg?: string; data?: ProfileData };

function failed(request: Request, reason: string, detail?: string) {
  const target = new URL('/', request.url);
  target.searchParams.set('auth_error', reason);
  if (detail) target.searchParams.set('detail', detail.slice(0, 180));
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      'set-cookie': clearStateCookie(),
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return failed(request, 'cancelled');
  if (!code || !state || state !== readStateCookie(request)) return failed(request, 'state');

  try {
    const { appId, appSecret } = feishuAppCredentials();
    const tokenResponse = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: feishuRedirectUri(request),
      }),
    });
    const tokenJson = await tokenResponse.json() as TokenResponse;
    const accessToken = tokenJson.access_token || tokenJson.data?.access_token;
    if (!tokenResponse.ok || tokenJson.code || !accessToken) throw new Error(tokenJson.msg || '无法取得用户授权');

    const [profileResponse, spaceResponse] = await Promise.all([
      fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', { headers: { authorization: `Bearer ${accessToken}` } }),
      fetch(`https://open.feishu.cn/open-apis/wiki/v2/spaces/${feishuSpaceId()}`, { headers: { authorization: `Bearer ${accessToken}` } }),
    ]);
    const profileJson = await profileResponse.json() as UserInfoResponse;
    const profile = profileJson.data || profileJson;
    if (!profileResponse.ok || profileJson.code || !profile.open_id) throw new Error(profileJson.msg || '无法读取飞书账号信息');

    const spaceJson = await spaceResponse.json() as { code?: number; msg?: string };
    if (!spaceResponse.ok || spaceJson.code) return failed(request, 'knowledge_access', spaceJson.msg || '当前账号无法读取该知识库');

    const sessionCookie = await createSessionCookie({
      openId: profile.open_id,
      unionId: profile.union_id,
      userId: profile.user_id,
      name: profile.name || '飞书用户',
      avatarUrl: profile.avatar_url,
    });
    const headers = new Headers({ location: new URL('/', request.url).toString() });
    headers.append('set-cookie', clearStateCookie());
    headers.append('set-cookie', sessionCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return failed(request, 'oauth', error instanceof Error ? error.message : '飞书登录失败');
  }
}
