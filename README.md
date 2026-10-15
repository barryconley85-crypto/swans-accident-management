# Swans Accident Management

Vercel-ready Vite + React + TypeScript sister application to Swans Ops Command Centre.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The app uses Firebase Authentication and Firestore for persistent accident records. Evidence files can remain in company SharePoint, with links stored against the accident case.


## Accident email notifications

The Vercel server-side endpoint `/api/notifications` handles authenticated event notifications and the deadline scan. Email delivery uses the free Google Apps Script mailer in [google-mailer/Code.gs](google-mailer/Code.gs), not Resend.

**Setup guide:** [GOOGLE_MAILER_SETUP.md](GOOGLE_MAILER_SETUP.md). Before live email can work, deploy the Apps Script web app and configure these server-side Vercel environment variables for the required environments:

- `GOOGLE_MAILER_URL`: deployed Google Apps Script Web App URL ending in `/exec`.
- `GOOGLE_MAILER_SHARED_SECRET`: shared secret matching the Apps Script `MAILER_SHARED_SECRET` script property.
- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`: base64-encoded Firebase service-account JSON for this project.
- `ACCIDENT_ALERT_TO`: comma-separated accident team email addresses (the mailer permits only `@swanstravel.com` recipients).
- `FNOL_ALERT_TO`: optional comma-separated FNOL recipients, otherwise `ACCIDENT_ALERT_TO` is used.
- `CRON_SECRET`: long random secret used to protect the scheduled deadline scan.

The old `RESEND_API_KEY` and `TASK_EMAIL_FROM` values are no longer used by `api/notifications.js`. The daily scan checks overdue tasks and investigations 72 hours after the accident date/time. Delivery attempts and provider responses are recorded in Firestore `notificationEvents`. A deployment marked Ready does not itself prove email delivery; verify by receiving a test email.
