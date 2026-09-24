# Not loaded by the app

`agentic.js`, `analyst.js` and `openbb.js` were added in commit f22b175 but are
not wired into any page: nothing calls them, and loading them once blanked the
whole site. `js/app.js` no longer imports them (24 Sep 2026).

They are kept here so the work is not lost. To use one, finish it, add a test,
import it from the page that needs it, and run `node tools/smoke.mjs`.
