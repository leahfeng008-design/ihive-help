type FeishuProfile = {
  openId: string;
  unionId?: string;
  userId?: string;
  name: string;
  avatarUrl?: string;
};

export type FeishuSession = FeishuProfile & { expiresAt: number };

const sessionCookie = 'ihive_feishu_session';
const stateCookie = 'ihive_feishu_oauth_state';
const encoder = new TextEncoder();

function base64url(value: Uint8Array) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || '';
  for (const entry of cookie.split(';')) {
    const [key, ...parts] = entry.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return null;
}

async function sessionKey() {
  const secret = process.env.FEISHU_COOKIE_SECRET;
  if (!secret) throw new Error('飞书登录尚未配置完成');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function isFeishuAuthRequired() {
  return process.env.FEISHU_AUTH_REQUIRED === 'true';
}

export function feishuRedirectUri(request: Request) {
  const configured = process.env.FEISHU_REDIRECT_URI?.trim();
  if (configured) return configured;
  return new URL('/api/auth/feishu/callback', request.url).toString();
}

export function createStateCookie(state: string) {
  return `${stateCookie}=${encodeURIComponent(state)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

export function readStateCookie(request: Request) {
  return cookieValue(request, stateCookie);
}

export function clearStateCookie() {
  return `${stateCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function clearSessionCookie() {
  return `${sessionCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function createSessionCookie(profile: FeishuProfile) {
  const maxAge = 60 * 60 * 24 * 30;
  const payload: FeishuSession = { ...profile, expiresAt: Date.now() + maxAge * 1000 };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionKey(), encoder.encode(JSON.stringify(payload)));
  const value = `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
  return `${sessionCookie}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export async function readFeishuSession(request: Request): Promise<FeishuSession | null> {
  const encoded = cookieValue(request, sessionCookie);
  if (!encoded) return null;
  try {
    const [ivValue, cipherValue] = encoded.split('.');
    if (!ivValue || !cipherValue) return null;
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(ivValue) },
      await sessionKey(),
      fromBase64url(cipherValue),
    );
    const session = JSON.parse(new TextDecoder().decode(decrypted)) as FeishuSession;
    if (!session.openId || !session.name || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function feishuAppCredentials() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('飞书登录尚未配置完成');
  return { appId, appSecret };
}

export function feishuSpaceId() {
  return process.env.FEISHU_SPACE_ID?.trim() || '7631047892841581526';
}
