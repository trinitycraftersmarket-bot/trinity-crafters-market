// In-app controls for the Android app (Capacitor): a Refresh button for
// everyone, plus an Update App button for signed-in (registered) users.
// These controls only appear inside the app — never on the public website.
(function () {
  var cap = window.Capacitor;
  if (!cap || (cap.isNativePlatform && !cap.isNativePlatform())) return;

  var APK_URL = 'https://github.com/trinitycraftersmarket-bot/trinity-crafters-market/releases/latest/download/app-debug.apk';

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
})();
