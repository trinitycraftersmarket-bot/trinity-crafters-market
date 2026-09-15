# Trinity Crafters Market — Netlify website

This is the implemented source package, not a live deployment. Do not drag only the public folder onto Netlify: that would omit the secure booking functions. Deploy this complete project through Netlify's Git integration or the Netlify CLI with functions included.

## Included

- Public market/customer page with directions and seven confirmed 2026 dates, all 10 AM–3 PM Eastern.
- Vendor sign-in by emailed verification code, private photo uploads, all 38 active categories, and one application across multiple dates with a separate space choice per date.
- Organizer dashboard: applications, details/photos, approval, category exceptions, invoice-sent action, received payments, dates, locations, categories, bans, calendar sync, notifications, and Facebook drafts.
- Server-side inventory checks and a transaction lock prevent simultaneous approvals from exceeding booth capacity. Paid, approved, and unexpired invoice holds occupy inventory. Pending applications do not.
- Expiry is checked on availability reads and every five minutes. The exact hold deadline is excluded from capacity, even between scheduled runs.
- Manual GoDaddy invoices: approval reserves inventory; only “Invoice sent” starts the 24-hour deadline. Record actual payments before expiration. Expired bookings must be reapproved if capacity is still available; then send/start a new invoice hold and record payment. This website never charges cards or refunds payments.
- Bans match account ID, normalized email, and normalized phone on applications. Email/account bans block private access. Public shopper pages remain public. Existing bookings are not automatically cancelled. New identities can evade matching; organizer review is still required.
- Scheduled Google Calendar import once an hour; manual sync button; exact event IDs and location/date uniqueness prevent duplication. Changed/cancelled records are flagged for review, not silently deleted. Calendar sync imports Trinity only; add future locations/dates in the dashboard.
- AI post generation when configured, with a deterministic editable draft when not configured. Copy to Facebook; no direct Facebook posting is implemented.

## Required live setup

1. Create a dedicated Supabase project for this market. Do not run setup.sql in your travel database.
2. Run database/setup.sql once in that project's SQL editor. It creates a private market schema with row-level security and no anonymous/authenticated Data API grants, plus a private vendor-photos bucket. Server functions use a privileged database connection and independently enforce verified identity and admin authorization.
3. Supabase Authentication: enable email authentication. Set the sign-in email template to show `{{ .Token }}` (this website asks for a code, not a magic link). Configure production SMTP delivery and the site's URL. Confirm that your organizer email receives codes. Sessions are kept only in browser session storage, and users sign in again when the token expires.
4. Set Netlify environment variables from .env.example. DATABASE_URL should be the Supabase transaction pooler connection string with SSL. All secret values belong only in Netlify environment settings. The only browser-visible key is the publishable key.
5. ADMIN_EMAIL must be the email you control and verify. Its default intended value is trinitycraftersmarket@gmail.com. There is no public admin-registration route or default password.
6. Resend: configure a verified sending domain and MAIL_FROM, and set RESEND_API_KEY. New applications queue an email to trinitycraftersmarket@gmail.com. The scheduled job delivers queued notifications within roughly five minutes and retries failures. Pending notifications are visible in Connections. Supabase sign-in codes use Supabase's SMTP settings separately.
7. Google Calendar: create a Google Cloud OAuth client for the website, enable Calendar API, authorize calendar.readonly with offline access, and store client ID, client secret and refresh token privately in Netlify. A ChatGPT Calendar connection is not a website OAuth credential. Use a production consent configuration so refresh access does not expire after a testing period. The sync reads future events up to two years ahead, expanding recurrence. New Trinity dates inherit location capacity and prices and open automatically. Audit flags for cancellations/changes require organizer review.
8. Optional AI: add an OpenAI API key and permitted model. This has separate usage billing. Only public event details go to the model; private application data is excluded. Without a key the editable template still works.
9. Import this full folder into your chosen Git repository and link it to Netlify. Build command: npm run build; publish directory: public; functions directory: netlify/functions. The included netlify.toml supplies these settings. Scheduled jobs only run on production deploys.
10. Test one vendor signup, photo application, organizer approval, emailed notification, invoice hold, payment recording and expiry with your connected services. Verify organizer access from a non-admin account is denied. Only then connect trinitylutzmarkets.com and begin accepting real vendors.

## Routes

- /#home — customers and directions
- /#apply — vendor applications
- /#account — vendor sign-in and bookings
- /#admin — private organizer workspace
- /#privacy — data use and vendor terms

## Local preview and validation

`npm ci` then `npm run preview` opens a non-transactional preview on http://localhost:4173. It uses the verified seed dates, labels setup as incomplete, and disables submission. It does not fake successful bookings.

`npm test` checks exact expiry behavior, category/booth limits, phone normalization, SQL setup, seeded dates/categories, and row-level-security flags. `npm run build` checks required package files. Live third-party integrations cannot be validated until credentials are configured.

## Maintenance

Keep database backups through your chosen Supabase plan. Review pending email errors and sync alerts in Connections. Do not reset event inventory during imports. Do not expose the market schema through Supabase Data API or add public policies to the photo bucket. Keep application data and ban notes out of public posts.

The server serializes approval-related inventory decisions with a database transaction lock; all booking changes must go through its API. SQL edits made by a privileged database owner can bypass application rules.

## Validation status for this delivery

Five automated rule/schema tests passed locally. JavaScript syntax checks and the package build check passed. A full browser layout check could not run because the browser download was blocked/timed out in this environment. Live authentication, uploads, notifications, calendar sync and AI calls still require the production setup and end-to-end checks above.

Additional DOM checks passed for the multi-date application ($45 + $30 = $75), 38 categories, and admin date/category/ban/social/settings forms using synthetic responses. These do not substitute for visual browser or live integration testing.

## Vendor notification update

Approval and denial decisions queue a separate email for each requested date. Denial requires a reason, saved with the booking and included in the vendor's email and booking view. Banning (or reapplying a ban) queues a vendor access notice when a known email is available. Private ban notes are never inserted into that notice. Duplicate requests for an already-processed booking are rejected; already-active bans do not trigger another status-change notification.

Emails use the existing delivery queue, are delivered by the scheduled job, and reply to trinitycraftersmarket@gmail.com. Email credentials still must be configured before delivery works. Pending and failed emails are visible under Connections.

Two additional mandatory agreements are stored on each new application: no packing up before 3 PM, and rescheduling in the event of a hurricane. Terms version is 2026-09-v2. Existing agreement records are not retroactively changed. For a new project use the updated setup.sql. If you previously installed the initial package, run: ALTER TABLE market.bookings ADD COLUMN IF NOT EXISTS decision_reason text; ALTER TABLE market.applications ALTER COLUMN terms_version SET DEFAULT '2026-09-v2';
