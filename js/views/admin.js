// Admin panel: traffic, users, premium grants, content, site settings, API keys and cron jobs.
// Every action is re-checked server-side — this page is convenience, not security.
import { $, $$, bindTabs, toast, skeleton, modal, icon } from '../ui.js';
import { esc, dateTime, compact } from '../format.js';
import { auth, sb, isAdmin, callFn, getPosts, savePost, deletePost } from '../api/backend.js';

export const title = 'Admin';

export async function render(el) {
  await sb();
  if (!isAdmin()) {
    el.innerHTML = '<div class="card empty"><h3>Admins only</h3><p>This page is only available to site administrators.</p><a class="btn" href="#/">Back to markets</a></div>';
    return;
  }

  el.innerHTML = `
    <div class="page-head"><div><h1>Admin</h1><p>Signed in as ${esc(auth.user.email)}</p></div></div>
    <div class="tabs" id="tabs">
      <button data-tab="stats" class="on">Overview</button>
      <button data-tab="users">Users</button>
      <button data-tab="content">Content</button>
      <button data-tab="settings">Settings</button>
      <button data-tab="keys">API keys</button>
      <button data-tab="jobs">Jobs</button>
    </div>
    <div id="panel">${skeleton(6, 24)}</div>`;

  const panel = $('#panel', el);
  const call = (action, extra = {}) => callFn('admin', { action, ...extra });

  const TABS = {
    // ------------------------------------------------------------ overview
    async stats() {
      panel.innerHTML = skeleton(6, 24);
      const s = await call('stats');
      const days = Object.keys(s.byDay).sort();
      const max = Math.max(1, ...Object.values(s.byDay));
      const card = (k, v, sub = '') => `<div class="card"><div class="stat"><span class="k">${k}</span><span class="v">${v}</span><span class="s fine">${sub}</span></div></div>`;
      panel.innerHTML = `
        <div class="admin-grid">
          ${card('Users', s.users, `${s.premium} premium`)}
          ${card('Visitors (30d)', compact(s.visitors, ''), `${compact(s.views, '')} page views`)}
          ${card('Alerts', s.activeAlerts, `${s.triggered} triggered`)}
          ${card('Telegram linked', s.telegram)}
          ${card('Signals logged', compact(s.signals, ''))}
          ${card('News stored', compact(s.news, ''))}
          ${card('Posts', s.posts)}
        </div>
        <div class="grid g2 mt">
          <div class="card"><h3>Page views per day</h3><div class="bars mt">${days.map((d) => `<i style="height:${(s.byDay[d] / max) * 100}%" title="${esc(d)}: ${s.byDay[d]}"></i>`).join('')}</div><p class="fine mt">${days[0] || ''} → ${days.at(-1) || ''}</p></div>
          <div class="card"><h3>Top pages</h3><dl class="kv mt">${Object.entries(s.byPath).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, n]) => `<dt>${esc(p)}</dt><dd>${n}</dd>`).join('')}</dl>
            <h3 class="mt">Devices</h3><dl class="kv">${Object.entries(s.byDevice).map(([d, n]) => `<dt>${esc(d)}</dt><dd>${n}</dd>`).join('')}</dl></div>
        </div>
        <div class="card mt"><h3>Newest accounts</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">E-mail</th><th class="l">Name</th><th>Joined</th><th>Premium</th></tr></thead><tbody>
          ${(s.recentUsers || []).map((u) => `<tr><td class="l">${esc(u.email)}</td><td class="l">${esc(u.display_name || '')}</td><td class="fine">${dateTime(new Date(u.created_at).getTime(), false)}</td><td>${u.premium_until && new Date(u.premium_until) > new Date() ? '<span class="chip up">yes</span>' : '—'}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    },

    // ------------------------------------------------------------ users
    async users() {
      panel.innerHTML = `
        <div class="card">
          <div class="card-h"><h3>Users</h3><div class="row" style="gap:8px"><input class="inp" id="q" placeholder="Search e-mail…" style="max-width:220px"><button class="btn sm" id="grant">${icon('star', 14)} Grant premium</button></div></div>
          <div id="ulist">${skeleton(6, 22)}</div>
        </div>`;
      const load = async (q = '') => {
        const { users } = await call('users', { q });
        $('#ulist', el).innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">E-mail</th><th class="l">Name</th><th>Joined</th><th>Premium until</th><th>Telegram</th><th>Admin</th><th></th></tr></thead><tbody>
          ${users.map((u) => `<tr>
            <td class="l">${esc(u.email)}${u.email_verified ? ' <span class="chip up" style="font-size:10px">✓</span>' : ''}</td>
            <td class="l">${esc(u.display_name || '')}</td>
            <td class="fine">${dateTime(new Date(u.created_at).getTime(), false)}</td>
            <td>${u.premium_until ? dateTime(new Date(u.premium_until).getTime(), false) : '—'}</td>
            <td>${u.telegram_chat_id ? '✓' : '—'}</td>
            <td>${u.is_admin ? '<span class="chip warn">admin</span>' : '—'}</td>
            <td><button class="btn sm ghost" data-u="${esc(u.email)}">Manage</button></td></tr>`).join('')}
        </tbody></table></div>`;
        $$('[data-u]', el).forEach((b) => b.addEventListener('click', () => manage(b.dataset.u, users.find((x) => x.email === b.dataset.u))));
      };
      const manage = (email, u) => {
        const m = modal(`<h3>${esc(email)}</h3>
          <div class="stack mt" style="gap:10px">
            <div class="row" style="gap:8px"><input class="inp" id="days" type="number" value="30" min="1" style="max-width:90px"><button class="btn sm" id="gp">Add premium days</button><button class="btn sm ghost" id="rp">Revoke premium</button></div>
            <div class="row" style="gap:8px"><input class="inp" id="pw" type="password" placeholder="New password (8+)" style="max-width:200px"><button class="btn sm" id="sp">Set password</button></div>
            <label class="row" style="gap:8px"><input type="checkbox" id="ad" ${u?.is_admin ? 'checked' : ''}> Site administrator</label>
            <p class="fine" id="msg"></p>
          </div>`);
        const say = (t2, ok = true) => { $('#msg', m.el).textContent = t2; $('#msg', m.el).className = `fine ${ok ? 'up' : 'down'}`; };
        const wrap = (fn) => async () => { try { await fn(); say('Done.'); await load($('#q', el).value.trim()); } catch (e) { say(e.message, false); } };
        $('#gp', m.el).addEventListener('click', wrap(() => call('grant-premium', { email, days: +$('#days', m.el).value })));
        $('#rp', m.el).addEventListener('click', wrap(() => call('revoke-premium', { email })));
        $('#sp', m.el).addEventListener('click', wrap(() => call('set-password', { email, password: $('#pw', m.el).value })));
        $('#ad', m.el).addEventListener('change', wrap(() => call('set-admin', { email, value: $('#ad', m.el).checked })));
      };
      $('#q', el).addEventListener('input', (e) => load(e.target.value.trim()));
      $('#grant', el).addEventListener('click', () => {
        const m = modal(`<h3>Grant premium</h3><div class="stack mt" style="gap:10px">
          <label class="fld">User e-mail<input class="inp" id="ge"></label>
          <label class="fld">Days<input class="inp" id="gd" type="number" value="30" min="1"></label>
          <label class="fld">Note<input class="inp" id="gn" placeholder="bank transfer, ref…"></label>
          <button class="btn primary" id="go">Grant</button><p class="fine" id="gm"></p></div>`);
        $('#go', m.el).addEventListener('click', async () => {
          try {
            const r = await call('grant-premium', { email: $('#ge', m.el).value.trim(), days: +$('#gd', m.el).value, note: $('#gn', m.el).value });
            $('#gm', m.el).textContent = `Premium until ${new Date(r.premium_until).toLocaleDateString()}`;
            load();
          } catch (e) { $('#gm', m.el).textContent = e.message; }
        });
      });
      load();
    },

    // ------------------------------------------------------------ content
    async content() {
      const posts = await getPosts(60);
      panel.innerHTML = `
        <div class="card">
          <div class="card-h"><h3>Posts &amp; trade ideas</h3><button class="btn sm" id="new">${icon('plus', 14)} New post</button></div>
          ${posts.length ? `<div class="stack" style="gap:8px">${posts.map((p) => `
            <div class="row spread" style="padding:10px;border-radius:10px;background:var(--surface-2)">
              <div><b>${esc(p.title)}</b> <span class="chip">${esc(p.kind)}</span>${p.premium_only ? ' <span class="chip warn">premium</span>' : ''}<br><small class="fine">${esc(p.symbol || '')} ${esc(p.side || '')} · ${dateTime(new Date(p.created_at).getTime(), false)} · ${esc(p.status || 'open')}</small></div>
              <div class="row" style="gap:6px"><button class="btn sm ghost" data-ed="${p.id}">Edit</button><button class="icon-btn" style="width:32px;height:32px" data-rm="${p.id}">${icon('trash', 14)}</button></div>
            </div>`).join('')}</div>` : '<p class="muted">No posts yet. Trade ideas you publish here appear on the Premium page.</p>'}
        </div>`;
      const edit = (p = {}) => {
        const m = modal(`<h3>${p.id ? 'Edit post' : 'New post'}</h3>
          <form class="stack mt" style="gap:10px" id="pf">
            <label class="fld">Title<input class="inp" name="title" required value="${esc(p.title || '')}"></label>
            <div class="row" style="gap:8px">
              <label class="fld">Type<select class="inp" name="kind"><option value="idea" ${p.kind === 'idea' ? 'selected' : ''}>Trade idea</option><option value="note" ${p.kind === 'note' ? 'selected' : ''}>Note</option><option value="update" ${p.kind === 'update' ? 'selected' : ''}>Site update</option></select></label>
              <label class="fld">Coin<input class="inp" name="symbol" value="${esc(p.symbol || '')}" style="max-width:90px"></label>
              <label class="fld">Side<select class="inp" name="side"><option value="">—</option><option value="long" ${p.side === 'long' ? 'selected' : ''}>Long</option><option value="short" ${p.side === 'short' ? 'selected' : ''}>Short</option></select></label>
            </div>
            <label class="fld">Body<textarea class="inp" name="body" rows="5">${esc(p.body || '')}</textarea></label>
            <div class="row" style="gap:8px">
              <label class="fld">Entry<input class="inp" name="entry" type="number" step="any" value="${p.entry ?? ''}"></label>
              <label class="fld">Stop<input class="inp" name="stop_loss" type="number" step="any" value="${p.stop_loss ?? ''}"></label>
              <label class="fld">Targets (comma)<input class="inp" name="targets" value="${esc((p.targets || []).join(','))}"></label>
            </div>
            <div class="row" style="gap:14px">
              <label class="row" style="gap:6px"><input type="checkbox" name="premium_only" ${p.premium_only !== false ? 'checked' : ''}> Premium only</label>
              <label class="fld">Status<select class="inp" name="status"><option value="open" ${p.status === 'open' ? 'selected' : ''}>Open</option><option value="hit" ${p.status === 'hit' ? 'selected' : ''}>Target hit</option><option value="stopped" ${p.status === 'stopped' ? 'selected' : ''}>Stopped</option><option value="closed" ${p.status === 'closed' ? 'selected' : ''}>Closed</option></select></label>
            </div>
            <button class="btn primary">Save post</button><p class="fine" id="pm"></p>
          </form>`);
        $('#pf', m.el).addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = e.target;
          const num = (v) => (v === '' ? null : Number(v));
          try {
            await savePost({
              ...(p.id ? { id: p.id } : { author: auth.user.id }),
              title: f.title.value.trim(), kind: f.kind.value, body: f.body.value,
              symbol: f.symbol.value.trim().toUpperCase() || null, side: f.side.value || null,
              entry: num(f.entry.value), stop_loss: num(f.stop_loss.value),
              targets: f.targets.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)),
              premium_only: f.premium_only.checked, status: f.status.value,
            });
            m.close(); toast('Post saved.', 'up'); TABS.content();
          } catch (e2) { $('#pm', m.el).textContent = e2.message; }
        });
      };
      $('#new', el).addEventListener('click', () => edit());
      $$('[data-ed]', el).forEach((b) => b.addEventListener('click', () => edit(posts.find((p) => String(p.id) === b.dataset.ed))));
      $$('[data-rm]', el).forEach((b) => b.addEventListener('click', async () => { await deletePost(+b.dataset.rm); toast('Deleted.', 'info'); TABS.content(); }));
    },

    // ------------------------------------------------------------ settings
    async settings() {
      const client = await sb();
      const { data } = await client.from('app_settings').select('key,value');
      const cur = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
      const pr = cur.premium || {}, site = cur.site || {};
      panel.innerHTML = `
        <div class="grid g2">
          <div class="card"><h3>Premium plan</h3>
            <form class="stack mt" style="gap:10px" id="pf">
              <div class="row" style="gap:8px">
                <label class="fld">Price<input class="inp" name="price" type="number" step="any" value="${pr.price ?? 19}" style="max-width:110px"></label>
                <label class="fld">Currency<input class="inp" name="currency" value="${esc(pr.currency || 'USD')}" style="max-width:90px"></label>
                <label class="fld">Days<input class="inp" name="period_days" type="number" value="${pr.period_days ?? 30}" style="max-width:90px"></label>
              </div>
              <label class="row" style="gap:8px"><input type="checkbox" name="stripe_enabled" ${pr.stripe_enabled ? 'checked' : ''}> Card checkout via Stripe (needs the Stripe keys below)</label>
              <label class="fld">Manual payment instructions (shown when Stripe is off)<textarea class="inp" name="manual_payment_text" rows="3">${esc(pr.manual_payment_text || '')}</textarea></label>
              <label class="fld">Extra perks, one per line<textarea class="inp" name="perks" rows="3">${esc((pr.perks || []).join('\n'))}</textarea></label>
              <button class="btn primary">Save plan</button>
            </form>
          </div>
          <div class="card"><h3>Site</h3>
            <form class="stack mt" style="gap:10px" id="sf">
              <label class="fld">Public site URL (used in e-mails and checkout)<input class="inp" name="url" value="${esc(site.url || '')}" placeholder="https://you.github.io/coinvantage/"></label>
              <label class="fld">Contact shown on legal pages<input class="inp" name="contact" value="${esc(site.contact || '')}" placeholder="support@example.com"></label>
              <label class="fld">Announcement banner (blank to hide)<input class="inp" name="announcement" value="${esc(site.announcement || '')}"></label>
              <button class="btn primary">Save site</button>
            </form>
          </div>
        </div>`;
      $('#pf', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await call('save-setting', { key: 'premium', value: {
            price: Number(f.price.value), currency: f.currency.value.trim().toUpperCase(), period_days: Number(f.period_days.value),
            stripe_enabled: f.stripe_enabled.checked, manual_payment_text: f.manual_payment_text.value,
            perks: f.perks.value.split('\n').map((x) => x.trim()).filter(Boolean),
          } });
          toast('Plan saved.', 'up');
        } catch (e2) { toast(e2.message, 'down'); }
      });
      $('#sf', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await call('save-setting', { key: 'site', value: { url: f.url.value.trim(), contact: f.contact.value.trim(), announcement: f.announcement.value.trim() || null } });
          toast('Site settings saved.', 'up');
        } catch (e2) { toast(e2.message, 'down'); }
      });
    },

    // ------------------------------------------------------------ keys
    async keys() {
      const s = await call('secrets-status');
      const NAMES = {
        telegram_bot_token: ['Telegram bot token', 'Create a bot with @BotFather, paste the token here. Saving it also registers the webhook automatically.'],
        resend_api_key: ['Resend API key', 'Enables e-mail: verification codes, password resets and e-mail alerts. resend.com, free tier is enough to start.'],
        resend_from: ['E-mail "from" address', 'Must be a domain you verified in Resend, e.g. alerts@yourdomain.com'],
        stripe_secret_key: ['Stripe secret key', 'Only needed if you want card checkout for Premium.'],
        stripe_webhook_secret: ['Stripe webhook secret', `Create a webhook pointing at ${esc(s.webhookUrl)} and paste its signing secret.`],
      };
      panel.innerHTML = `
        <div class="card"><h3>API keys</h3>
          <p class="fine">Keys are stored encrypted in Supabase Vault and are only readable by the backend. They are never sent to browsers — this page can only tell you whether one is set.</p>
          <div class="stack mt" style="gap:14px">
            ${Object.entries(NAMES).map(([k, [label, help]]) => `
              <div>
                <div class="row spread"><b>${esc(label)}</b><span class="chip ${s.status[k] ? 'up' : ''}">${s.status[k] ? 'set' : 'not set'}</span></div>
                <p class="fine">${help}</p>
                <div class="row" style="gap:8px"><input class="inp" data-k="${k}" type="password" placeholder="Paste value" style="flex:1"><button class="btn sm" data-save="${k}">Save</button></div>
              </div>`).join('')}
          </div>
          ${s.telegramBot ? `<p class="fine mt up">Telegram bot connected: @${esc(s.telegramBot)}</p>` : ''}
        </div>`;
      $$('[data-save]', el).forEach((b) => b.addEventListener('click', async () => {
        const name = b.dataset.save;
        const inp = $(`[data-k="${name}"]`, el);
        b.disabled = true; b.textContent = 'Saving…';
        try { await call('set-secret', { name, value: inp.value }); toast('Saved.', 'up'); inp.value = ''; TABS.keys(); }
        catch (e) { toast(e.message, 'down'); b.disabled = false; b.textContent = 'Save'; }
      }));
    },

    // ------------------------------------------------------------ jobs
    async jobs() {
      panel.innerHTML = `
        <div class="card"><h3>Background jobs</h3>
          <p class="fine">These run automatically on a schedule. Use the buttons to run one now — useful right after changing keys.</p>
          <div class="stack mt" style="gap:10px">
            ${[['alerts', 'Check price alerts', 'every minute'], ['signals', 'Log & score signals', 'every 15 minutes'], ['news', 'Fetch news feeds', 'every 20 minutes']].map(([j, label, when]) => `
              <div class="row spread" style="padding:10px;border-radius:10px;background:var(--surface-2)">
                <div><b>${esc(label)}</b><br><small class="fine">Runs ${esc(when)}</small></div>
                <button class="btn sm" data-job="${j}">Run now</button>
              </div>`).join('')}
          </div>
          <pre class="fine mt" id="out" style="white-space:pre-wrap;max-height:260px;overflow:auto"></pre>
        </div>`;
      $$('[data-job]', el).forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true; const old = b.textContent; b.textContent = 'Running…';
        try { const r = await call('run-job', { job: b.dataset.job }); $('#out', el).textContent = JSON.stringify(r.result, null, 2); }
        catch (e) { $('#out', el).textContent = e.message; }
        b.disabled = false; b.textContent = old;
      }));
    },
  };

  bindTabs($('#tabs', el), (t) => TABS[t]().catch((e) => { panel.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p></div>`; }));
  TABS.stats().catch((e) => { panel.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p></div>`; });
}
