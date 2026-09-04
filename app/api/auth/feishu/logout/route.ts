import { clearSessionCookie } from '../../../../../lib/feishu-auth';

export async function GET(request: Request) {
  const response = Response.redirect(new URL('/', request.url).toString(), 302);
  response.headers.append('set-cookie', clearSessionCookie());
  return response;
}
