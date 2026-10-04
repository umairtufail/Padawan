# Deployment guide

Two deployments talk to each other: the **frontend** on Vercel and the **backend** on FastAPI Cloud. Supabase is the database (used later, see the last section).

| | URL | Deploys from |
|---|---|---|
| Frontend | https://padawan-bay.vercel.app | Vercel, triggered by pushes to GitHub |
| Backend | https://padawan.fastapicloud.dev | FastAPI Cloud (it has redeployed after merges; check the dashboard to see whether it is linked to GitHub or deployed with `fastapi deploy`) |

## How the frontend talks to the backend (quick authentication)

No shared API key, because anything in a frontend is visible to every visitor. Instead:

```
1. Browser  --POST /v1/auth/login {username, password}-->  Backend
2. Backend checks them against ADMIN_USER / ADMIN_PASSWORD (set in the backend's environment)
3. Backend  --{access_token, expires_in: 43200}-->  Browser   (a signed token, valid 12 hours)
4. Browser keeps the token and sends  Authorization: Bearer <token>  on every other call
5. Backend verifies the token's signature and expiry (signed with ADMIN_JWT_SECRET); bad or missing = 401
```

The frontend code for this is `frontend/lib/api.ts`; the backend code is `backend/app/auth.py`. Frames go straight from the browser to the backend (never through a Next.js route).

**Backend modes** (`AUTH_MODE`):

| Mode | Use | Notes |
|---|---|---|
| `admin` (default) | the deployed demo | one hardcoded account, token from `POST /v1/auth/login`, sessions in memory (lost on restart) |
| `dev` | local UI work only | **no login at all, anyone can call the API. Never set this on a public deployment.** |
| `supabase` | the real flow later | users sign in with Supabase, data stored in Postgres |

If `AUTH_MODE` is not set, the backend uses `admin`, so a forgotten setting leaves it closed. At startup it logs `SECURITY:` warnings for risky settings (dev mode, default password, no token secret).

## Backend on FastAPI Cloud: variables to set

Set them in the FastAPI Cloud dashboard, or with the CLI (`uv run fastapi cloud login` once). A secret value is read from stdin so it stays out of your shell history:

```bash
cd backend
printf '%s' "the-value" | uv run fastapi cloud env set NAME --secret --value-stdin --no-redeploy
uv run fastapi cloud env set NAME plain-value --no-redeploy      # for non-secret values
uv run fastapi deploy                                              # one deploy at the end
```

| Variable | Value | Secret? |
|---|---|---|
| `AUTH_MODE` | `admin` | no |
| `ADMIN_USER` | a username of your choice | no |
| `ADMIN_PASSWORD` | **not** `admin`: a long password | **yes** |
| `ADMIN_JWT_SECRET` | a long random string (for example `openssl rand -base64 48`) | **yes** |
| `ALLOWED_ORIGINS` | `https://padawan-bay.vercel.app,http://localhost:3000` | no |
| `NEBIUS_API_KEY` | from the team password manager or Notion keys page | **yes** |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.us-north1.nebius.com/v1/` | no |
| `NEBIUS_VLM_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash` | no |

Why the password matters: anyone who finds the URL could otherwise log in and send frames, which spend your Nebius credits. The default `admin` / `admin` is fine on your laptop and unsafe on the internet. `ADMIN_JWT_SECRET` should be fixed so logins survive a restart.

## Frontend on Vercel: variables to set

Project Settings, Environment Variables. Set each for **Production and Preview**. `NEXT_PUBLIC_*` values are baked in at build time, so **redeploy after changing them**.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://padawan.fastapicloud.dev` |

(The Supabase `NEXT_PUBLIC_*` variables are only needed once the Supabase login is wired into the UI.)

## Check it works

```bash
B=https://padawan.fastapicloud.dev
curl -s -o /dev/null -w "no token:   %{http_code} (want 401)\n" $B/v1/sessions
curl -s -o /dev/null -w "bad login:  %{http_code} (want 401)\n" -X POST $B/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"nope"}'
curl -s -o /dev/null -w "good login: %{http_code} (want 200)\n" -X POST $B/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"YOUR_USER","password":"YOUR_PASSWORD"}'
curl -s -i -X OPTIONS $B/v1/auth/login -H "Origin: https://padawan-bay.vercel.app" -H 'Access-Control-Request-Method: POST' | grep -i allow-origin   # want your Vercel URL
```

If the first line says `200` instead of `401`, the backend is open (`AUTH_MODE=dev`). Fix it before anything else.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Browser console: CORS error | `ALLOWED_ORIGINS` on the backend does not include the exact frontend URL (scheme and host, no trailing slash) |
| Every call returns 401 | no token sent, token expired (12 h), or the backend restarted with an empty `ADMIN_JWT_SECRET` (random secret per start) |
| Login works but data disappears | admin mode keeps sessions in memory; a restart or another instance forgets them |
| Dashboard says backend unreachable | wrong `NEXT_PUBLIC_API_URL` (needs a redeploy after changing) or the backend is down |
| GitHub shows Vercel "Deployment was blocked" | Vercel refused the build, usually because the commit author is not a member of the Vercel team. The project owner opens the deployment in the Vercel dashboard to see the reason, adds the author to the team, or triggers a redeploy as owner |
| Old page still live on Vercel | the build was blocked or `NEXT_PUBLIC_*` was changed without a redeploy |

## Secrets

Real keys never go in git (the repo is public, see `AGENTS.md`). Set them in the dashboards. **The Nebius and ElevenLabs keys were in git history while the repo was public: rotate both now** (create a new key, update the Notion page and the FastAPI Cloud variables, delete the old key).

## Supabase login
Full guide: [`supabase-login.md`](supabase-login.md) (self sign-up with email confirmation, variables for both sides, Google later).

In short:

When the UI signs users in with Supabase, set `AUTH_MODE=supabase` and the `SUPABASE_*` variables on the backend and the `NEXT_PUBLIC_SUPABASE_*` ones on Vercel (values in the Notion keys page, enable the login providers and add the Vercel URL as a redirect URL in the Supabase dashboard). Data then lives in Postgres with row-level security.
