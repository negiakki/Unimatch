# UniMatch

A mobile-first dating web app exclusively for verified university students.

| Area     | Tech                                          | Deploy target |
| -------- | --------------------------------------------- | ------------- |
| Frontend | Next.js (App Router), TypeScript, Tailwind v4 | Vercel        |
| Backend  | FastAPI (Python 3.11)                         | Render        |
| Data     | Supabase (Postgres, Storage, Realtime, Auth)  | Supabase      |

## Repository layout

```
frontend/   Next.js web app
backend/    FastAPI service
docs/       PRD, architecture, database, API, security, roadmap
supabase/   Database migrations (schema is designed separately)
.github/    CI workflow
```

## Local development

### Frontend

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local   # fill in Supabase values when available
npm run dev                         # http://localhost:3000
```

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env         # fill in when Supabase is connected
uvicorn app.main:app --reload       # http://localhost:8000/docs
```

Health check: `GET http://localhost:8000/api/v1/health`

## Checks

```powershell
cd frontend
npm run lint
npx tsc --noEmit
npm run build

cd ..\backend
.\.venv\Scripts\python.exe -m pytest -v
```

CI (`.github/workflows/ci.yml`) runs exactly these commands.

## Documentation

Start with [docs/PRD.md](docs/PRD.md), then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DATABASE.md](docs/DATABASE.md),
[docs/API.md](docs/API.md),
[docs/SECURITY.md](docs/SECURITY.md),
and [docs/ROADMAP.md](docs/ROADMAP.md).
