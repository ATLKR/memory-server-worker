import type { Brand } from './ui.ts';
import type { AuthSettings } from './auth.ts';
import { canonicalEmail } from './identity.ts';

export const SERVICE_ID = 'allenlabs-memory';
export const SERVICE_VERSION = '0.5.0-rc.1';
export const PUBLIC_ORIGIN = 'https://memory.allenlabs.org';
export const AUTH_ISSUER = 'https://auth-api.allen.company';
export type Settings = { origin: string; brand: Brand; auth: AuthSettings };
type Variables = Partial<Record<'PUBLIC_ORIGIN' | 'SSO_CLIENT_ID' | 'PRODUCT_NAME' |
  'PRODUCT_SHORT_NAME' | 'PRODUCT_DESCRIPTION' | 'PRODUCT_SUPPORT_EMAIL' | 'PRODUCT_ACCENT_COLOR', string>>;

function text(input: string | undefined, fallback: string, max: number): string {
  const value = input ?? fallback;
  if (!value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid product configuration');
  return value;
}

/** Display branding never participates in identity, OAuth audience, SQL IDs or tool names. */
export function readSettings(env: Variables): Settings {
  const origin = env.PUBLIC_ORIGIN ?? PUBLIC_ORIGIN;
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid public origin');
  const supportEmail = text(env.PRODUCT_SUPPORT_EMAIL, 'support@allenlabs.org', 254);
  if (supportEmail.trim() !== supportEmail) throw new Error('Invalid support email');
  // Validate the mailbox without replacing its configured display spelling.
  try { canonicalEmail(supportEmail); } catch { throw new Error('Invalid support email'); }
  const accentColor = env.PRODUCT_ACCENT_COLOR ?? '#276747';
  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) throw new Error('Invalid brand color');
  const clientId = env.SSO_CLIENT_ID ?? '';
  if (clientId.length > 256 || /[\s\x00-\x1f]/.test(clientId)) throw new Error('Invalid SSO client ID');
  return {
    origin,
    brand: {
      name: text(env.PRODUCT_NAME, 'Memory by Allen Labs', 80),
      shortName: text(env.PRODUCT_SHORT_NAME, 'Memory', 30),
      description: text(env.PRODUCT_DESCRIPTION, '에이전트와 팀을 위한 하나의 기억 공간', 240),
      supportEmail, accentColor,
    },
    auth: {
      origin, issuer: AUTH_ISSUER, clientId,
      authorizationEndpoint: `${AUTH_ISSUER}/oauth/authorize`,
      tokenEndpoint: `${AUTH_ISSUER}/oauth/token`,
      jwksUri: `${AUTH_ISSUER}/.well-known/jwks.json`,
    },
  };
}
