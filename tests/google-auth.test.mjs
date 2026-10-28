import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGoogleIdToken } from "../cloud-reminders/google-auth.mjs";

test("Google sign-in verifies signature, audience, verified allowed account, and expiry", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  const seconds = 1800000000;
  const env = {
    GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
    ALLOWED_GOOGLE_EMAIL: "allowed@example.com",
  };
  const claims = {
    iss: "https://accounts.google.com",
    aud: env.GOOGLE_CLIENT_ID,
    sub: "123456789",
    email: env.ALLOWED_GOOGLE_EMAIL,
    email_verified: true,
    iat: seconds - 30,
    exp: seconds + 3600,
  };
  let calls = 0;
  const options = {
    now: () => seconds * 1000,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "Cache-Control": "max-age=3600" },
      });
    },
  };
  const encoded = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  async function sign(overrides = {}, header = {}) {
    const body =
      encoded({ alg: "RS256", kid: jwk.kid, ...header }) +
      "." +
      encoded({ ...claims, ...overrides });
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(body),
    );
    return body + "." + Buffer.from(signature).toString("base64url");
  }
  assert.equal(await verifyGoogleIdToken(await sign(), env, options), true);
  assert.equal(await verifyGoogleIdToken(await sign(), env, options), true);
  assert.equal(calls, 1, "Public signing keys are cached.");
  for (const override of [
    { aud: "other-client" },
    { email: "other@example.com" },
    { email_verified: false },
    { exp: seconds },
    { iat: seconds + 90 },
    { iss: "https://attacker.example" },
    { azp: "another-client.apps.googleusercontent.com" },
    { nbf: seconds + 90 },
    { sub: "" },
  ]) {
    assert.equal(
      await verifyGoogleIdToken(await sign(override), env, options),
      false,
    );
  }
  assert.equal(
    await verifyGoogleIdToken(await sign({}, { alg: "none" }), env, options),
    false,
  );
  assert.equal(
    await verifyGoogleIdToken(
      await sign(),
      { ...env, ALLOWED_GOOGLE_SUB: "different" },
      options,
    ),
    false,
  );
  const original = await sign();
  const parts = original.split(".");
  parts[1] = encoded({ ...claims, email: "someone@example.com" });
  assert.equal(await verifyGoogleIdToken(parts.join("."), env, options), false);
  const tampered = original.slice(0, -8) + "AAAAAAAA";
  assert.equal(await verifyGoogleIdToken(tampered, env, options), false);
  assert.equal(await verifyGoogleIdToken(original, {}, options), false);
  assert.equal(await verifyGoogleIdToken("not.a.token", env, options), false);
});
