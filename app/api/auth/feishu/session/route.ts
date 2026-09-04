import { isFeishuAuthRequired, readFeishuSession } from '../../../../../lib/feishu-auth';

export async function GET(request: Request) {
  if (!isFeishuAuthRequired()) return Response.json({ authenticated: true, authRequired: false, user: null });
  const session = await readFeishuSession(request);
  if (!session) return Response.json({ authenticated: false, authRequired: true }, { status: 401 });
  return Response.json({ authenticated: true, authRequired: true, user: { name: session.name, avatarUrl: session.avatarUrl || null } });
}
