// Pure helpers for the A2A server auth form. Kept out of the component so the
// serialization logic (which has real branching) can be unit-tested in isolation.

// One source of truth for the form's auth shape, so every input is controlled from the
// first render (no undefined→value warnings) and the form's init sites can't drift apart.
export const EMPTY_AUTH = {
  type: 'none', token: '', token_env: '', header_name: '',
  token_url: '', client_id: '', client_secret: '', client_secret_env: '',
  grant_type: 'client_credentials', refresh_token: '', refresh_token_env: '', scope: '',
};

// A displayed secret is masked (not the real value) when it carries the "***" the backend
// inserts (_mask_token). Matches the backend's own restore heuristic (AUTH_SECRET_FIELDS).
export const isMaskedSecret = (v) => typeof v === 'string' && v.includes('***');

// Build the auth object to send to the API: keep only the fields relevant to the selected
// type and drop blanks, so we never persist empty strings or fields left over from a
// previously-selected type. Masked secrets (containing "***") are non-empty, so on UPDATE
// they survive here and the backend restores the real stored value (see AUTH_SECRET_FIELDS).
// Pass { dropMaskedSecrets: true } for the stateless Discover/preview call, which does NOT
// restore — sending the mask would authenticate with the literal asterisks and be rejected.
//
// envModes maps each secret field ('token'|'client_secret'|'refresh_token') to whether its
// env-var toggle is ON. When provided, a secret/env pair is mutually exclusive: env mode WITH
// a var name emits only the name; otherwise only the direct secret. The backend prefers a
// stored direct secret over the env var (a2a_auth._resolve_secret), so persisting both would
// silently defeat env mode. Keying this off the toggle (not off which field is non-blank) is
// what lets the form stop wiping a typed secret on toggle — a value left from a since-flipped
// toggle simply isn't emitted. Callers that omit envModes (tests) emit whatever is set.
export const buildAuthPayload = (auth, { dropMaskedSecrets = false, envModes = null } = {}) => {
  const keepSecret = (v) => Boolean(v) && !(dropMaskedSecrets && isMaskedSecret(v));
  const out = { type: auth.type };
  const emitPair = (directField, envField) => {
    const mode = envModes ? envModes[directField] : undefined;
    if (mode === undefined) {
      if (keepSecret(auth[directField])) out[directField] = auth[directField];
      if (auth[envField]) out[envField] = auth[envField];
    } else if (mode && auth[envField]) {
      out[envField] = auth[envField];
    } else if (keepSecret(auth[directField])) {
      out[directField] = auth[directField];
    }
  };
  if (auth.type === 'bearer' || auth.type === 'api_key') {
    emitPair('token', 'token_env');
    if (auth.type === 'api_key' && auth.header_name) out.header_name = auth.header_name;
  } else if (auth.type === 'oauth2') {
    if (auth.token_url) out.token_url = auth.token_url;
    if (auth.client_id) out.client_id = auth.client_id;
    if (auth.grant_type) out.grant_type = auth.grant_type;
    if (auth.scope) out.scope = auth.scope;
    if (auth.grant_type === 'client_credentials') {
      emitPair('client_secret', 'client_secret_env');
    } else if (auth.grant_type === 'refresh_token') {
      emitPair('refresh_token', 'refresh_token_env');
    }
    if (auth.header_name) {
      out.header_name = auth.header_name;
      emitPair('token', 'token_env');
    }
  }
  return out;
};
