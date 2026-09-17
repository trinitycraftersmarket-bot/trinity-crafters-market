// Compatibility hotfix for the My Bookings template.
// app.js currently contains a stale vendor-directory checkbox reference to v.id.
// Defining v prevents that unrelated organizer-only control from crashing vendor accounts.
var v = { id: '' };
