import { clearSessionCookie } from '../../../../../lib/feishu-auth';

export async function GET(request: Request) {
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL('/', request.url).toString(),
      'set-cookie': clearSessionCookie(),
    },
  });
}
