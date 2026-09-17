// Attendance list hotfix: keep attendance state fresh and allow organizers to cancel
// an attendee directly from the attendance list. Cancelling a normal booking moves
// it to cancelled; cancelling a PDF-imported attendee removes that imported
// reservation. Both immediately release the booth/category inventory used by the
// public availability calculations.

async function attendanceHotfixApi(action, payload) {
  const token = sessionStorage.getItem('market-token');
  const response = await fetch('/.netlify/functions/api?action=' + encodeURIComponent(action), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Please try again.');
  return value;
}

function addCancelButtons() {
  document.querySelectorAll('.inspection-row .report-actions').forEach(actions => {
    if (actions.querySelector('[data-cancel-attendee]')) return;
    const attendanceButton = actions.querySelector('[data-attendance-id]');
    if (!attendanceButton) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'danger';
    button.textContent = 'Cancel Vendor';
    button.dataset.cancelAttendee = attendanceButton.dataset.attendanceId;
    button.dataset.imported = attendanceButton.dataset.imported || '0';
    actions.appendChild(button);
  });
}

const observer = new MutationObserver(addCancelButtons);
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', addCancelButtons);
addCancelButtons();

document.addEventListener('click', async event => {
  const cancelButton = event.target.closest('[data-cancel-attendee]');
  if (cancelButton) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const card = cancelButton.closest('.inspection-row');
    const vendor = card?.querySelector('h3')?.textContent?.trim() || 'this vendor';
    if (!confirm(`Cancel ${vendor} for this market date?\n\nTheir booth and category inventory will be released so the space can be sold again.`)) return;

    const originalText = cancelButton.textContent;
    cancelButton.disabled = true;
    cancelButton.textContent = 'Cancelling…';
    try {
      const id = cancelButton.dataset.cancelAttendee;
      const imported = cancelButton.dataset.imported === '1';
      if (imported) {
        await attendanceHotfixApi('imported-attendance', { id, state: 'remove' });
      } else {
        await attendanceHotfixApi('booking', { id, status: 'cancelled' });
      }
      const notice = document.querySelector('#notice');
      if (notice) notice.textContent = 'Vendor cancelled. Inventory has been released for resale.';
      location.reload();
    } catch (error) {
      const notice = document.querySelector('#notice');
      if (notice) notice.textContent = error.message || 'Could not cancel vendor.';
      cancelButton.disabled = false;
      cancelButton.textContent = originalText;
    }
    return;
  }

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
      location.reload();
    } else if (tries >= 30) {
      clearInterval(timer);
      button.textContent = originalText;
    }
  }, 100);
}, true);
