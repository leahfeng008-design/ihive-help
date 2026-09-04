import { createStateCookie, feishuAppCredentials, feishuRedirectUri } from '../../../../../lib/feishu-auth';

export async function GET(request: Request) {
  try {
    const { appId } = feishuAppCredentials();
    const state = crypto.randomUUID();
    const authorize = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    authorize.searchParams.set('app_id', appId);
    authorize.searchParams.set('redirect_uri', feishuRedirectUri(request));
    authorize.searchParams.set('scope', 'wiki:wiki:readonly docx:document:readonly bitable:app:readonly');
    authorize.searchParams.set('state', state);
    return new Response(null, {
      status: 302,
      headers: {
        location: authorize.toString(),
        'set-cookie': createStateCookie(state),
      },
    });
  } catch (error) {
    const target = new URL('/?auth_error=config', request.url);
    target.searchParams.set('detail', error instanceof Error ? error.message : '飞书登录配置不完整');
    return Response.redirect(target.toString(), 302);
  }
}
