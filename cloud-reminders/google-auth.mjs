// Google Identity Services ID-token verification. No token or patient data is logged.
const jwksURL = "https://www.googleapis.com/oauth2/v3/certs";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
let keyCache = null;

function decodePart(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid token encoding");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const text = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}
function claimsPart(value) {
  const result = JSON.parse(decoder.decode(decodePart(value)));
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid token claims");
  return result;
}
async function getKeys(fetchImpl, now) {
  if (keyCache && keyCache.fetchImpl === fetchImpl && keyCache.expires > now)
    return keyCache.keys;
  const response = await fetchImpl(jwksURL, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error("Google sign-in verification is temporarily unavailable.");
  const body = await response.text();
  if (body.length > 100000)
    throw new Error("Google sign-in verification returned invalid keys.");
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed.keys) || parsed.keys.length > 20)
    throw new Error("Google sign-in verification returned invalid keys.");
  const maxAge = Number(
    (response.headers.get("Cache-Control") || "").match(
      /max-age=(\d+)/i,
    )?.[1] || 300,
  );
  keyCache = {
    fetchImpl,
    keys: parsed.keys,
    expires: now + Math.min(Math.max(maxAge, 30), 3600) * 1000,
  };
  return parsed.keys;
}

export async function verifyGoogleIdToken(
  token,
  env,
  { fetchImpl = globalThis.fetch, now = () => Date.now() } = {},
) {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.ALLOWED_GOOGLE_EMAIL ||
    typeof token !== "string" ||
    token.length > 8192
  )
    return false;
  let header, claims, signature, parts;
  try {
    parts = token.split(".");
    if (parts.length !== 3) return false;
    header = claimsPart(parts[0]);
    claims = claimsPart(parts[1]);
    signature = decodePart(parts[2]);
  } catch {
    return false;
  }
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid.length > 200 ||
    header.crit
  )
    return false;
  const current = Number(now()),
    seconds = Math.floor(current / 1000);
  if (claims.azp !== undefined && claims.azp !== env.GOOGLE_CLIENT_ID)
    return false;
  if (
    claims.nbf !== undefined &&
    (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 60)
  )
    return false;
  if (
    !["https://accounts.google.com", "accounts.google.com"].includes(
      claims.iss,
    ) ||
    claims.aud !== env.GOOGLE_CLIENT_ID
  )
    return false;
  if (
    !Number.isInteger(claims.exp) ||
    claims.exp <= seconds ||
    !Number.isInteger(claims.iat) ||
    claims.iat > seconds + 60 ||
    claims.exp <= claims.iat
  )
    return false;
  if (
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 255 ||
    claims.email_verified !== true
  )
    return false;
  if (
    typeof claims.email !== "string" ||
    claims.email.toLowerCase() !== env.ALLOWED_GOOGLE_EMAIL.trim().toLowerCase()
  )
    return false;
  if (env.ALLOWED_GOOGLE_SUB && claims.sub !== env.ALLOWED_GOOGLE_SUB)
    return false;
  const keys = await getKeys(fetchImpl, current);
  const jwk = keys.find(
    (key) =>
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (!key.alg || key.alg === "RS256") &&
      (!key.use || key.use === "sig"),
  );
  if (!jwk) return false; // Cache expires according to Google's key rotation headers.
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      encoder.encode(parts[0] + "." + parts[1]),
    );
  } catch {
    return false;
  }
}
