# Free Google email setup for Accident Management

This is the free Google Apps Script mail route. No Resend account, paid email service, or domain purchase is required.

## 1. Create the mailer
1. Sign in to the Google account that should send the emails, then open https://script.google.com/home.
2. Create a new project named **Swans Accident Mailer**.
3. Replace the contents of `Code.gs` with the code in [google-mailer/Code.gs](google-mailer/Code.gs) in this repository and save. The gateway sends branded HTML when provided and builds a branded HTML version from the plain-text body when a caller omits it; it always keeps the plain-text body for mail clients that cannot display HTML.
4. In **Project Settings → Script Properties**, add `MAILER_SHARED_SECRET` with a strong random secret. Do not put this value in GitHub or send it in chat.
5. Under **Deploy → Manage deployments**, edit the existing Web app deployment and select **New version** (or create a new Web app deployment if none exists). Set **Execute as: Me** and **Who has access: Anyone**, then deploy and authorise the requested mail permissions. Copy the Web app URL ending in `/exec` if it changes. Saving the Apps Script source alone does not update the live `/exec` deployment. The endpoint validates the shared secret in every request and only permits `@swanstravel.com` recipients.

## 2. Vercel environment variables
In Vercel → swans-accident-management → Settings → Environment Variables, set the following for **Production** (and Preview if needed):
- `GOOGLE_MAILER_URL`: the deployed Apps Script Web app URL ending in `/exec`.
- `GOOGLE_MAILER_SHARED_SECRET`: exactly the same secret as the Apps Script `MAILER_SHARED_SECRET` property.
- `INSURANCE_FORM_URL`: the permanent HTTPS Adobe insurance-form link sent to drivers.
- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`: existing Firebase Admin service-account value, required by the notification API.
- `ACCIDENT_ALERT_TO`: comma-separated team addresses, each ending in `@swanstravel.com`.
- `FNOL_ALERT_TO`: optional comma-separated FNOL addresses.
- `CRON_SECRET`: strong random value used to protect the deadline scan.

Save changes and redeploy the Vercel project after setting variables. The old `RESEND_API_KEY` and `TASK_EMAIL_FROM` variables are not needed for the Google route.

## 3. Verify
Test one new accident and confirm the recipient receives it. Then test a task assignment, FNOL acknowledgement and deadline scan. Check Firestore `notificationEvents` for `sent` or `failed`. A Vercel deployment being Ready does not by itself prove email delivery.

## Important
The Apps Script Web App must be deployed and its URL/secret configured in Vercel before live mail can work. Keep the shared secret private. Google imposes daily sending quotas; the mailer returns a clear error if its remaining quota is insufficient.

