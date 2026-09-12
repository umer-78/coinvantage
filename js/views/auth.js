// Sign in / sign up / password reset — a single modal, no page navigation needed.
import { $, icon, modal, toast } from '../ui.js';
import { esc } from '../format.js';
import { signIn, signUp, callFn } from '../api/backend.js';
import { assuranceLevel, completeChallenge } from '../api/security.js';

const FORMS = {
  in: { title: 'Welcome back', cta: 'Sign in' },
  up: { title: 'Create your account', cta: 'Create account' },
  reset: { title: 'Reset your password', cta: 'Set new password' },
};

// Second step for accounts with an authenticator app. Resolves only when the
// code is accepted, so the caller can treat sign-in as complete afterwards.
function askForCode(m) {
  return new Promise((resolve, reject) => {
    const body = m.el.querySelector('#authBody');
    body.innerHTML = `
      <h3>Two-factor code</h3>
      <p class="fine">This account is protected by an authenticator app. Enter the 6-digit code it is showing.</p>
      <form class="stack mt" style="gap:10px" id="mf">
        <label class="fld">Code<input class="inp" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required autofocus></label>
        <button class="btn primary">Verify</button>
        <p class="fine down" id="merr" hidden></p>
      </form>`;
    const f = body.querySelector('#mf'), err = body.querySelector('#merr');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      try { await completeChallenge(f.code.value); resolve(true); }
      catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
    m.el.querySelector('.modal-x')?.addEventListener('click', () => reject(new Error('Two-factor cancelled — you are not fully signed in.')));
  });
}

export function openAuth(mode = 'in') {
  const m = modal('<div id="authBody"></div>');
  let emailEnabled = null;
  callFn('account', { action: 'email-status' }).then((r) => { emailEnabled = r.emailEnabled; paint(cur); }).catch(() => { emailEnabled = false; });

  let cur = mode;
  function paint(next) {
    cur = next;
    const f = FORMS[cur];
    $('#authBody', m.el).innerHTML = `
      <h3>${esc(f.title)}</h3>
      <p class="fine">Your account syncs your watchlist, portfolio and alerts across devices. ${cur === 'up' ? 'Free — no card needed.' : ''}</p>
      <form class="stack mt" style="gap:10px" id="af">
        ${cur === 'up' ? '<label class="fld">Name<input class="inp" name="name" autocomplete="name" maxlength="60"></label>' : ''}
        <label class="fld">E-mail<input class="inp" name="email" type="email" autocomplete="email" required></label>
        ${cur === 'reset' ? `
          <p class="fine">${emailEnabled === false ? 'E-mail sending is not configured on this site yet, so password reset codes cannot be sent. Ask the site admin to reset it for you.' : 'We will e-mail you a 6-digit code.'}</p>
          <div class="row" style="gap:8px"><button type="button" class="btn sm" id="sendCode" ${emailEnabled === false ? 'disabled' : ''}>Send code</button><span class="fine" id="codeMsg"></span></div>
          <label class="fld">6-digit code<input class="inp" name="code" inputmode="numeric" maxlength="6" pattern="\\d{6}" required></label>
        ` : ''}
        <label class="fld">${cur === 'reset' ? 'New password' : 'Password'}<input class="inp" name="password" type="password" autocomplete="${cur === 'in' ? 'current-password' : 'new-password'}" minlength="8" required></label>
        ${cur !== 'in' ? '<p class="fine">At least 8 characters.</p>' : ''}
        <button class="btn primary" id="go">${icon('bolt', 16)} ${esc(f.cta)}</button>
        <p class="fine down" id="err" hidden></p>
      </form>
      <div class="row mt" style="gap:12px;font-size:12.5px">
        ${cur !== 'in' ? '<a href="#" data-go="in">Sign in instead</a>' : ''}
        ${cur !== 'up' ? '<a href="#" data-go="up">Create an account</a>' : ''}
        ${cur !== 'reset' ? '<a href="#" data-go="reset">Forgot password?</a>' : ''}
      </div>
      <p class="fine mt">By continuing you agree to the <a href="#/legal/terms" data-close>Terms</a> and <a href="#/legal/privacy" data-close>Privacy Policy</a>. We never ask for exchange API keys, private keys or seed phrases.</p>`;

    m.el.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); paint(a.dataset.go); }));
    m.el.querySelectorAll('[data-close]').forEach((a) => a.addEventListener('click', () => m.close()));

    const form = $('#af', m.el), err = $('#err', m.el), btn = $('#go', m.el);
    $('#sendCode', m.el)?.addEventListener('click', async () => {
      const email = form.email.value.trim();
      if (!email) { form.email.focus(); return; }
      $('#codeMsg', m.el).textContent = 'Sending…';
      try {
        await callFn('account', { action: 'send-code', purpose: 'reset', email });
        $('#codeMsg', m.el).textContent = 'Code sent — check your inbox (and spam).';
      } catch (e) { $('#codeMsg', m.el).textContent = e.message; }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      const old = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> Working…';
      try {
        const email = form.email.value.trim(), password = form.password.value;
        if (cur === 'in') {
          await signIn(email, password);
          // Supabase signs you in at password-only level even when 2FA is on —
          // the app is what must insist on the second step.
          const aal = await assuranceLevel();
          if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
            await askForCode(m);
          }
        }
        else if (cur === 'up') await signUp(email, password, form.name.value.trim());
        else {
          await callFn('account', { action: 'reset-password', email, code: form.code.value.trim(), password });
          await signIn(email, password);
        }
        m.close();
        toast(cur === 'up' ? 'Account created — your data now syncs across devices.' : 'Signed in.', 'up');
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
        btn.disabled = false;
        btn.innerHTML = old;
      }
    });
  }
  paint(mode);
  return m;
}
