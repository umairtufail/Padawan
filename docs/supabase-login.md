# Supabase login (email and password)

Real accounts, no shared secret. Supabase checks the password and issues the token; our backend verifies it with Supabase's public key.

```
Browser: supabase.auth.signInWithPassword(email, password)
Supabase Auth -> session { access_token (JWT, about 1 hour), refresh_token }
supabase-js renews the token by itself; the app asks for the current one before every API call
Browser -> Backend:  Authorization: Bearer <access_token>
Backend verifies signature, expiry, audience and issuer against the project's public keys (JWKS)
Backend calls Supabase AS THE USER, so row-level security keeps each person's data private
```

Code: `frontend/lib/supabase.ts`, `frontend/lib/api.ts` (`loginWithSupabase`, `syncSupabaseToken`), `frontend/components/auth-sync.tsx`, `frontend/app/login/page.tsx`, backend `app/auth.py` and `app/repo.py`.

## 1. Supabase dashboard (project `reuueppvukwdiytfxezj`)
- [ ] **Authentication, Users, Add user** (or Invite): create the team's accounts with an email and a password they choose. Tick "Auto Confirm User" when you set the password yourself.
- [ ] **Authentication, Sign In / Providers**: turn **off "Allow new users to sign up"**. The publishable key is public by design, so while sign-ups are on, anyone can register through the API and then use our backend.
- [ ] **Authentication, URL Configuration**: set **Site URL** to `https://padawan-bay.vercel.app` (confirmation and reset emails link there; the default is `http://localhost:3000`) and add `http://localhost:3000` to the redirect URLs. The app handles the confirmation link itself: it reads the session from the URL and sends the person to `/dashboard`.
- [ ] Optional: **Confirm email** stays on if people sign up themselves; off if you only create accounts by hand.

## 2. Turn it on
| Where | Variables |
|---|---|
| **Backend** (FastAPI Cloud, or local `.env`) | `AUTH_MODE=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS_URL` (all public values, see `.env.example`), `ALLOWED_ORIGINS` with the Vercel URL, plus the Nebius settings |
| **Frontend** (Vercel, or `frontend/.env.local`) | `NEXT_PUBLIC_AUTH_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the publishable key), `NEXT_PUBLIC_API_URL` |

Set the frontend variables for Production **and** Preview and redeploy (they are baked in at build time). Both sides must use the same mode: in `supabase` mode the backend's admin login returns 404.

## 3. Check it
```bash
B=https://padawan.fastapicloud.dev
curl -s -o /dev/null -w "no token:        %{http_code} (want 401)\n" $B/v1/sessions
curl -s -o /dev/null -w "admin login:     %{http_code} (want 404, disabled in supabase mode)\n" -X POST $B/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}'
```
Then sign in on the site with a real account, press Start teaching, and look at the Supabase tables `sessions` and `events`: rows appear under your user id. A user never sees another user's rows.

## Tested
Email and password sign-in through the real login form, a wrong password rejected, a recording saved to `sessions` and `events` under the right user, the data read back after a fresh login, another user and anonymous access blocked by the database rules, sign-out clearing the session and the dashboard guard. Not tested: token renewal after an hour, sign-up through the UI (there is none: accounts are created in the dashboard).

## Google login (optional, later)
Needs a Google Cloud project, about 10 to 15 minutes:
1. Google Cloud Console: create a project, then **APIs and Services, OAuth consent screen**. User type External, app name Padawan, your email. Leave it in **Testing** and add the team's Google emails as test users (no Google review needed for the basic email and profile scopes).
2. **Credentials, Create credentials, OAuth client ID**, type **Web application**. Add `http://localhost:3000` and the Vercel URL as authorised JavaScript origins, and `https://reuueppvukwdiytfxezj.supabase.co/auth/v1/callback` as the authorised redirect URI.
3. Copy the **Client ID** and **Client secret** into Supabase, **Authentication, Sign In / Providers, Google**, and enable it. The client secret stays in the Supabase dashboard only, never in git or the frontend.
4. The frontend still needs a "Continue with Google" button that calls `supabase.auth.signInWithOAuth({ provider: "google" })` (not built).
