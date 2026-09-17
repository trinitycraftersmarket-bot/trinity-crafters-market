// Keep the live attendance card in sync after a successful attendance action.
// app.js rebuilds report rows from its cached admin payload; refresh that payload
// after the action completes so Checked in / No show / Not marked is authoritative.
document.addEventListener('click', event => {
  const button = event.target.closest('[data-attendance-id]');
  if (!button) return;
  const originalText = button.textContent;
  const expectedNotice = button.dataset.state === 'checked_in'
    ? 'Vendor checked in.'
    : button.dataset.state === 'no_show'
      ? 'Vendor marked no show.'
      : 'Attendance cleared.';
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const notice = document.querySelector('#notice')?.textContent?.trim();
    if (notice === expectedNotice) {
      clearInterval(timer);
      // Re-fetch the organizer payload instead of leaving the stale cached row on screen.
      location.reload();
    } else if (tries >= 30) {
      clearInterval(timer);
      button.textContent = originalText;
    }
  }, 100);
}, true);
