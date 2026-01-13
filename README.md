# Idol Tool — drag & drop blanks

Minimal Node + static frontend demonstrating draggable words that fill rectangular blanks in sentences. Intended for hosting on Render; Supabase integration can be added later.

Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

Deploying on Render

- Create a new Web Service on Render using Node. The project includes `render.yaml` to simplify setup.
- Ensure `PORT` env var is provided by Render (the server reads it automatically).

Supabase

- Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` as environment variables in Render (or a local `.env`) to enable direct fetching from Supabase.
- A small Supabase client exists at `lib/supabaseClient.js`; the server will attempt to use it if env vars are present. Right now the `/api/sentences` endpoint falls back to sample data until you add your DB schema and queries.

Next steps

- Wire your Supabase tables (e.g., `sentences`, `words`) and update `server.js` query logic.
- Add auth and persistence as needed.
