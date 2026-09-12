// Account security: two-factor authentication, password changes and sessions.
//
// 2FA uses Supabase's own TOTP support, so the secret is generated and verified
// on their auth server — this app never sees or stores it, and there is no
// custom crypto here to get wrong. An admin account with 2FA on cannot be taken
// over with a stolen password alone, which is the whole point for the site owner.
import { sb, auth } from './backend.js';

export async function listFactors() {
  const client = await sb();
  if (!client || !auth.user) return [];
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) return [];
  return (data?.all || []).filter((f) => f.factor_type === 'totp');
}

export const hasTwoFactor = async () => (await listFactors()).some((f) => f.status === 'verified');

/** Start enrolment: returns a QR image and the manual key to type into the app. */
export async function startEnrollment() {
  const client = await sb();
  // clear any half-finished attempt so the list cannot fill with junk factors
  for (const f of await listFactors()) {
    if (f.status !== 'verified') await client.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }
  const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `CoinVantage ${new Date().toISOString().slice(0, 10)}` });
  if (error) throw new Error(error.message);
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
}

export async function confirmEnrollment(factorId, code) {
  const client = await sb();
  const { data: ch, error: e1 } = await client.auth.mfa.challenge({ factorId });
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await client.auth.mfa.verify({ factorId, challengeId: ch.id, code: String(code).replace(/\s/g, '') });
  if (e2) throw new Error(e2.message === 'Invalid TOTP code entered' ? 'That code was not accepted. Check your phone clock and try the next one.' : e2.message);
  return true;
}

export async function disableTwoFactor(factorId) {
  const client = await sb();
  const { error } = await client.auth.mfa.unenroll({ factorId });
  if (error) throw new Error(error.message);
}

/** Called at sign-in when the account has 2FA: verifies the 6-digit code. */
export async function completeChallenge(code) {
  const client = await sb();
  const factors = await listFactors();
  const f = factors.find((x) => x.status === 'verified');
  if (!f) throw new Error('No verified authenticator on this account.');
  const { data: ch, error: e1 } = await client.auth.mfa.challenge({ factorId: f.id });
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await client.auth.mfa.verify({ factorId: f.id, challengeId: ch.id, code: String(code).replace(/\s/g, '') });
  if (e2) throw new Error('That code was not accepted.');
  return true;
}

/** 'aal1' = password only, 'aal2' = password + 2FA. */
export async function assuranceLevel() {
  const client = await sb();
  if (!client) return null;
  const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  return data || null;
}

export async function changePassword(newPassword) {
  const client = await sb();
  if (newPassword.length < 10) throw new Error('Use at least 10 characters for an account that controls the site.');
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

/** Signs this account out of every device, everywhere. */
export async function signOutEverywhere() {
  const client = await sb();
  const { error } = await client.auth.signOut({ scope: 'global' });
  if (error) throw new Error(error.message);
}
