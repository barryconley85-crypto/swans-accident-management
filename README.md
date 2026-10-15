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

The Vercel server-side endpoint `/api/notifications` handles authenticated event notifications and the daily deadline scan. Configure these **server-side Vercel Production and Preview environment variables** before enabling live email:

- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`: base64-encoded Firebase service-account JSON for the `swans-accident-management` project.
- `RESEND_API_KEY`: Resend API key.
- `TASK_EMAIL_FROM`: sender address authorised by Resend.
- `ACCIDENT_ALERT_TO`: comma-separated accident team email addresses.
- `FNOL_ALERT_TO`: optional comma-separated FNOL recipients, otherwise `ACCIDENT_ALERT_TO` is used.
- `CRON_SECRET`: long random secret used to protect the scheduled deadline scan.

The daily scan checks overdue tasks and investigations 72 hours after the accident date/time. Delivery attempts and provider responses are recorded in Firestore `notificationEvents`. The frontend triggers notifications for new accident records, task assignments and FNOL acknowledgement transitions. Do not enable this for production until the sender and recipient configuration is verified and test emails are received.
