// Account security: password changes and sessions.
import { sb } from './backend.js';

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
