# Visual removal email reports

Target: avs-copy (`irdccxgbgkzxdjfskbdx`). No mobile or Netlify deployment is needed.

An UPDATE from `hidden_from_admin_list = false` to `true` on a client or
employee queues a single email to `avs.run974@gmail.com`. Updating a hidden
record or restoring its visibility does not send an email. Hiding it again
after restoration sends a new report. Existing hidden records are not backfilled.

The report snapshots `client_monthly_bilan` or `employee_month_summary` at
removal time: monthly planned hours counted by these views (fait/valide),
rounded to two decimal places, and their sum. No calculation rules or business
data are changed. An empty history produces a zero-hour report.

Transport uses the existing AhaSend v1 sender and Vault credential. Failure
before queuing aborts the visual removal and the admin UI displays the error.
pg_net sends asynchronously after commit: queuing is not proof of delivery.
The private `admin_removal_email_notifications` ledger stores the snapshot,
recipient and request ID without the API key. Correlate `request_id` with
`net._http_response.id` promptly (responses expire after six hours by default).
An AhaSend HTTP 201 must also have `success_count = 1` and `fail_count = 0`;
final delivery/bounces are checked with the email provider. There is no blind
automatic retry that could send duplicate reports after an ambiguous timeout.

Keep `private` and `net` out of the Supabase Data API exposed schemas. Managed
Supabase owns the pg_net objects and can ignore attempted postgres ACL changes;
verify the API boundary separately, without retrieving queue contents:
request `/rest/v1/http_request_queue?select=id&limit=0` with `Accept-Profile: net`
and a publishable key must return PGRST106 (invalid schema).

Verification:

- `tools/admin-removal-emails.test.sql`: monthly totals, payload, escaping,
  transition semantics and private privileges, all rolled back.
- `tools/admin-list-visibility.test.sql`: business/Auth/report fingerprints,
  all rolled back.
- `node tools/admin-list-visibility.test.cjs`: admin UI list/update behavior.

The SQL tests use pg_net's commit semantics: rolled-back requests never send.
Do not remove their surrounding transaction or replace ROLLBACK with COMMIT.
