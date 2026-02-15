# Repository Guidelines

## Project Structure & Module Organization

- `server.js`: Express API + static file server (basic-auth protected) and S3 multipart orchestration.
- `public/`: Browser UI (vanilla JS in `public/index.html`) and generated assets (e.g. `public/generated-audio/` at runtime).
- `s3/`: S3/Hetzner compatibility helpers (SDK pin guard, checksum/path-style parsing).
- `scripts/`: Operator/diagnostic scripts (TypeScript executed via `tsx`), e.g. `scripts/check-s3-multipart.ts`.
- `.env.example`: Environment template. Use `.env`/`.env.local` locally; never commit real credentials.

## Build, Test, and Development Commands

Requires Node.js >= 20 (see `package.json`).

```bash
npm install          # install dependencies
npm start            # run the server (defaults to :3000)
npm test             # run Node’s built-in test runner (node --test)
npm run check:s3-multipart -- --help  # multipart diagnostic against your endpoint
docker build -t s3-upload-platform .  # container build (installs ffmpeg)
```

## Coding Style & Naming Conventions

- Node.js ESM (`"type": "module"`); prefer `import`/`export` and async/await.
- Match existing formatting: 2-space indentation, semicolons, and `const` by default.
- Filenames: keep scripts in `kebab-case` (e.g. `check-s3-multipart.ts`); modules in clear, topic-based folders (`s3/utils.js`).

## Testing Guidelines

- Framework: Node test runner via `npm test` (`node --test`).
- If adding tests, place them under `test/` and name `*.test.js` (or `*.test.ts` if you add a `tsconfig` and runner support).
- Prefer deterministic unit tests; gate S3/FFmpeg integration tests behind env flags and document required vars.

## Commit & Pull Request Guidelines

- Commit subjects in this repo are short, imperative, and descriptive (e.g. “Add queued multi-file upload handling”).
- PRs: explain the user-facing change, list key env/config impacts, and include screenshots for UI changes (`public/index.html`).
- When touching multipart logic or AWS SDK versions, run `npm run check:s3-multipart` and call out Hetzner compatibility considerations in the PR.

## Security & Configuration Tips

- Use least-privilege S3 credentials scoped to the target bucket.
- Don’t log secrets; avoid committing `.env*` files with real values.
- Verify Hetzner uploads after dependency changes (the S3 SDK is intentionally pinned for compatibility).
