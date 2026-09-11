// The caller validates the decision before applying trusted, local configuration.
// This selector asks the server to resolve its current organization record; it
// does not create consent or make a local authorization decision.
export function applyOperatorRouting(routing, env = process.env) {
  const mode = env.MEMORY_MEDICAL_CONSENT_MODE;
  if (mode !== undefined && mode !== 'organization') throw new Error('routing_configuration_invalid');
  if (mode === 'organization' && routing.classification === 'medical'
      && routing.medicalCloudflareConsent === undefined) {
    return Object.freeze({ ...routing, medicalCloudflareConsent: Object.freeze({ mode: 'organization' }) });
  }
  return routing;
}

export function loadRoutingRestrictions(env = process.env) {
  const restriction = env.MEMORY_ROUTING_RESTRICTION;
  if (restriction === undefined) return [];
  if (restriction !== 'seoul') throw new Error('routing_configuration_invalid');
  return Object.freeze([Object.freeze({ route: 'seoul', requiredRegion: 'kr-seoul' })]);
}

// Read only the chosen route. There is deliberately no legacy/shared token fallback.
export function loadRouteConfiguration(route, env = process.env) {
  if (route !== 'agent-memory' && route !== 'seoul') throw new Error('route_configuration_invalid');
  const prefix = route === 'agent-memory' ? 'MEMORY_CF_' : 'MEMORY_SEOUL_';
  const rawOrigin = env[`${prefix}ORIGIN`] ?? (route === 'agent-memory' ? 'https://memory.allenlabs.org' : undefined);
  const spaceId = env[`${prefix}SPACE_ID`];
  if (!rawOrigin || !spaceId) throw new Error('route_configuration_missing');
  let target;
  try { target = new URL(rawOrigin); } catch { throw new Error('route_configuration_invalid'); }
  if (typeof rawOrigin !== 'string' || rawOrigin !== rawOrigin.trim() || target.protocol !== 'https:'
      || target.username || target.password || target.pathname !== '/' || target.search || target.hash
      || typeof spaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(spaceId)) {
    throw new Error('route_configuration_invalid');
  }
  const pat = env[`${prefix}PAT`];
  const sso = env[`${prefix}SSO_TOKEN`];
  if (pat !== undefined && sso !== undefined) throw new Error('route_credential_conflict');
  const token = pat ?? sso;
  if (token === undefined) throw new Error('route_credential_missing');
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw new Error('route_credential_invalid');
  const origin = target.origin;
  return {
    targets: { [route]: { origin, spaceId } },
    credential: async (request) => {
      if (request.route !== route || request.origin !== origin) throw new Error('credential_target_mismatch');
      return { kind: pat !== undefined ? 'pat' : 'sso', token };
    },
  };
}
