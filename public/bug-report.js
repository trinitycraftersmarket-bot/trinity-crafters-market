// "Report a problem" — lets any vendor or visitor flag something broken.
// Adds a footer link on the website and a pill button in the Android app's
// control stack. The report goes to the organizer by email (via the API's
// bug-report action) with the page, app version, and device attached.
(function () {
  function openReport() {
    var dlg = document.getElementById('modal');
    var box = document.getElementById('modal-content');
    if (!dlg || !box) return;
    var signedIn = !!sessionStorage.getItem('market-token');
    box.innerHTML =
      '<h3 style="margin-top:0">Report a problem</h3>' +
      '<p>Tell us what went wrong and we\'ll take a look. The page you\'re on is included automatically.</p>' +
      '<form id="bug-report-form">' +
      '<label style="display:block;margin:12px 0">What happened?<br>' +
      '<textarea id="bug-report-text" rows="5" maxlength="2000" style="width:100%" placeholder="Example: I tapped Inspection Approved and the label did not change."></textarea></label>' +
      (signedIn ? '' : '<label style="display:block;margin:12px 0">Your email (optional, so we can follow up)<br>' +
        '<input id="bug-report-email" type="email" maxlength="120" style="width:100%"></label>') +
      '<p id="bug-report-error" style="color:#b3261e"></p>' +
      '<div class="actions"><button type="submit">Send report</button></div>' +
      '</form>';
    dlg.showModal();
    var form = document.getElementById('bug-report-form');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = document.getElementById('bug-report-error');
      var text = document.getElementById('bug-report-text').value.trim();
      if (text.length < 10) { err.textContent = 'Please add a sentence or two about what went wrong.'; return; }
      var payload = { description: text, page: location.href };
      var emailEl = document.getElementById('bug-report-email');
      if (emailEl && emailEl.value.trim()) payload.contact_email = emailEl.value.trim();
      var headers = { 'Content-Type': 'application/json' };
      var token = sessionStorage.getItem('market-token');
      if (token) headers.Authorization = 'Bearer ' + token;
      function send() {
        fetch('/.netlify/functions/api?action=bug-report', { method: 'POST', headers: headers, body: JSON.stringify(payload) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (res.ok && res.j.ok) {
              box.innerHTML = '<h3 style="margin-top:0">Thank you — report sent</h3><p>We\'ll take a look. If we need more detail and you left an email, we\'ll reach out.</p>';
            } else {
              err.textContent = (res.j && res.j.error) || 'Sorry — the report could not be sent. Please try again.';
            }
          })
          .catch(function () { err.textContent = 'Sorry — the report could not be sent. Please check your connection and try again.'; });
      }
      var cap = window.Capacitor;
      var AppPlugin = cap && cap.Plugins && cap.Plugins.App;
      if (AppPlugin && AppPlugin.getInfo) {
        AppPlugin.getInfo().then(function (info) { if (info && info.version) payload.app_version = info.version; send(); }).catch(send);
      } else send();
    });
  }

  // Website: a footer link next to the existing footer items.
  var footer = document.querySelector('footer');
  if (footer) {
    var link = document.createElement('a');
    link.href = '#report-a-problem';
    link.textContent = '🐞 Report a problem';
    link.addEventListener('click', function (ev) { ev.preventDefault(); openReport(); });
    footer.appendChild(link);
  }

  // Android app: a pill in the app-controls stack, styled to match.
  var controls = document.getElementById('app-controls');
  if (controls) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '🐞 Report';
    btn.style.cssText = 'background:#123f38;color:#f8d776;border:1px solid #f8d776;border-radius:999px;padding:10px 16px;font:600 14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;';
    btn.addEventListener('click', openReport);
    controls.insertBefore(btn, controls.firstChild);
  }
})();
