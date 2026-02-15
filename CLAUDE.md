# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

S3-Upload-Platform is a browser-based S3 file manager with direct browser-to-S3 multipart uploads via presigned URLs. The server never handles file data — it only signs requests. Includes audio extraction and splitting features via FFmpeg.

## Commands

- **Start server:** `npm start` (runs `node server.js`)
- **Run tests:** `npm test` (uses Node.js built-in test runner via `node --test`)
- **Check S3 multipart support:** `npm run check:s3-multipart` (runs `tsx scripts/check-s3-multipart.ts`)
- **Docker build:** `docker build -t s3-upload-platform .`

## Architecture

**Monolithic Express app** — all server logic lives in `server.js` (~1900 lines), frontend is a single-page vanilla JS app in `public/index.html`.

### Request Flow

```
Browser UI (public/index.html)
  → Express server (server.js) signs requests
    → Browser uploads directly to S3 via presigned URLs
```

### Key Files

| File | Role |
|------|------|
| `server.js` | All Express routes, middleware, audio processing, logging |
| `public/index.html` | Complete frontend: HTML + inline CSS + inline JS |
| `s3/utils.js` | AWS SDK version guard for Hetzner compatibility |
| `scripts/check-s3-multipart.ts` | CLI diagnostic tool for S3 multipart support |

### API Endpoints

- `GET /api/upload-config` — Part size and concurrency settings
- `GET /api/list?prefix=...` — List S3 objects and prefixes
- `POST /api/mkdir` — Create folder (empty object with trailing `/`)
- `POST /api/create-multipart` — Initiate multipart upload
- `POST /api/sign-part` — Get presigned URL for a part
- `POST /api/complete-multipart` — Complete multipart upload, trigger webhook
- `POST /api/abort-multipart` — Cancel multipart upload
- `POST /api/getaudio` — Extract MP3 from video URL via FFmpeg
- `POST /splitaudio` — Split audio file into segments (fixed-duration or silence-based)

### Multipart Upload Flow

1. Browser calls `/api/create-multipart` to get an upload ID
2. File is chunked (default 8MB parts, 4 concurrent workers)
3. Each chunk: `/api/sign-part` → presigned URL → PUT directly to S3
4. Progress and ETags stored in LocalStorage (enables resume)
5. `/api/complete-multipart` finalizes; server resolves missing ETags via `ListPartsCommand` as fallback

### Hetzner Object Storage Compatibility

**Critical constraint:** AWS SDK v3 versions ≥3.729.0 add "Data Integrity Protection" signatures that Hetzner rejects. The SDK is pinned to `3.726.1`. `s3/utils.js` enforces this at startup — the server exits if an incompatible version is detected. Do not upgrade `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, or `@aws-sdk/s3-request-presigner` without verifying Hetzner compatibility.

### Audio Processing

FFmpeg/FFprobe are required (installed via `ffmpeg-static` npm package or system-level in Docker). Temp files auto-clean after 30 minutes. Two split modes: `fixed` (time-based segments) and `silence` (detects quiet sections via FFprobe).

## Environment Variables

Required: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `ADMIN_PASSWORD`, and one of `S3_BUCKET`/`S3_BUCKET_NAME`/`BUCKET`/`BUCKET_NAME`.

Optional: `PORT` (default 3000), `FORCE_PATH_STYLE`, `TRUST_PROXY`, `UPLOAD_PART_SIZE_BYTES` (default 8MB), `UPLOAD_MAX_CONCURRENCY` (default 4), `LOG_FILE`, `S3_REQUEST_CHECKSUM_CALCULATION`, `S3_RESPONSE_CHECKSUM_VALIDATION`.

See `.env.example` for full reference.

## Code Patterns

- **ESM modules** throughout (`"type": "module"` in package.json)
- **Async error wrapper:** `asyncHandler(fn)` wraps route handlers for consistent error propagation
- **Auth:** HTTP Basic Auth (`admin` / `ADMIN_PASSWORD`) via `express-basic-auth`
- **Path safety:** Rejects prefixes/keys starting with `/` or containing `..`
- **Logging:** Dual output (console + optional file), format: `[TIMESTAMP] [LEVEL] message {"meta":"json"}`
- **Presigned URLs:** 1-hour expiry (3600s)
