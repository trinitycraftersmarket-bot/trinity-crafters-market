// In-app controls for the Android app (Capacitor): a Refresh button for
// everyone, plus an Update App button for signed-in (registered) users.
// When a newer app release exists on GitHub, the Update button gets a
// pulsing red dot and a "New version" label so nobody has to guess.
// These controls only appear inside the app — never on the public website.
(function () {
  var cap = window.Capacitor;
  if (!cap || (cap.isNativePlatform && !cap.isNativePlatform())) return;

  var APK_URL = 'https://github.com/trinitycraftersmarket-bot/trinity-crafters-market/releases/latest/download/app-debug.apk';
  var RELEASES_API = 'https://api.github.com/repos/trinitycraftersmarket-bot/trinity-crafters-market/releases/latest';

  var style = document.createElement('style');
  style.textContent = '@keyframes appUpdatePulse{0%{box-shadow:0 0 0 0 rgba(255,82,82,.55)}70%{box-shadow:0 0 0 8px rgba(255,82,82,0)}100%{box-shadow:0 0 0 0 rgba(255,82,82,0)}}';
  document.head.appendChild(style);

  var wrap = document.createElement('div');
  wrap.id = 'app-controls';
  wrap.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9990;display:flex;flex-direction:column;gap:8px;';

  function makeButton(id, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.textContent = label;
    b.style.cssText = 'background:#123f38;color:#f8d776;border:1px solid #f8d776;border-radius:999px;padding:10px 16px;font:600 14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;';
    return b;
  }

  var updateBtn = makeButton('app-update-btn', '⬆ Update App');
  updateBtn.style.display = 'none';
  updateBtn.style.position = 'relative';
  var dot = document.createElement('span');
  dot.id = 'app-update-dot';
  dot.style.cssText = 'display:none;position:absolute;top:-3px;right:-3px;width:13px;height:13px;border-radius:50%;background:#ff5252;border:2px solid #123f38;animation:appUpdatePulse 1.6s ease-out infinite;';
  updateBtn.appendChild(dot);
  updateBtn.addEventListener('click', function () {
    // Hand the APK download to the system browser so Android offers Install.
    if (window.open) window.open(APK_URL, '_system');
    else location.href = APK_URL;
  });

  var refreshBtn = makeButton('app-refresh-btn', '⟳ Refresh');
  refreshBtn.addEventListener('click', function () { location.reload(); });

  wrap.appendChild(updateBtn);
  wrap.appendChild(refreshBtn);
  document.body.appendChild(wrap);

  // The Update button is for registered users: show it only while signed in.
  function syncUpdateVisibility() {
    var signedIn = !!sessionStorage.getItem('market-token');
    updateBtn.style.display = signedIn ? '' : 'none';
  }
  syncUpdateVisibility();
  setInterval(syncUpdateVisibility, 1500);

  // --- Update-available badge -------------------------------------------------
  // Installed version comes from the @capacitor/app plugin in the native
  // shell (present from app v1.3 on; older shells simply never badge).
  // Latest version comes from the public GitHub release, checked once per
  // session. Any failure (offline, rate limit) stays silent.
  function parseV(s) {
    return String(s || '').replace(/^app-v/, '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  }
  function isNewer(latest, installed) {
    var a = parseV(latest), b = parseV(installed), i;
    for (i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) > (b[i] || 0)) return true;
      if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
  }
  var installedVersion = null, latestVersion = null;
  function maybeBadge() {
    if (installedVersion && latestVersion && isNewer(latestVersion, installedVersion)) {
      dot.style.display = '';
      updateBtn.firstChild.textContent = '⬆ Update App — New! ';
    }
  }
  try {
    var AppPlugin = cap.Plugins && cap.Plugins.App;
    if (AppPlugin && AppPlugin.getInfo) {
      AppPlugin.getInfo().then(function (info) {
        installedVersion = info && info.version;
        maybeBadge();
      }).catch(function () {});
    }
  } catch (e) {}
  try {
    latestVersion = sessionStorage.getItem('app-latest-version');
    if (latestVersion) maybeBadge();
    else fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.tag_name) {
          latestVersion = j.tag_name;
          try { sessionStorage.setItem('app-latest-version', latestVersion); } catch (e) {}
          maybeBadge();
        }
      }).catch(function () {});
  } catch (e) {}
})();
