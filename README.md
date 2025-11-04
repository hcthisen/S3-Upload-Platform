# Hetzner S3 Upload Platform

A password-protected, self-hosted dashboard to browse Hetzner Object Storage buckets, create prefixes, and upload multi-gigabyte files directly from the browser using S3 multipart uploads.

## Features

- 🔐 Basic-auth protected UI suitable for private deployments
- 🗂️ Browse bucket prefixes with breadcrumb navigation and responsive views
- 📁 Create folders and organize content without leaving the browser
- 🚀 Upload large files using multipart uploads that stream straight from the browser to Hetzner S3
- ☁️ Server only signs AWS S3 requests; object data never transits the server
- 🐳 Deployable via Docker and Coolify with environment-based configuration

## Architecture overview

The application is a Node.js (Express) service that exposes REST endpoints for listing objects, creating prefixes, and orchestrating multipart uploads with the AWS SDK v3. The browser UI uses a first-party multipart uploader (written in vanilla JavaScript) that requests presigned URLs from the server and uploads file parts directly to Hetzner Object Storage. This keeps the server lightweight and avoids proxying large payloads while ensuring the client captures ETags for every part.

```
Browser ⇄ Express server ⇄ Hetzner S3 (presigned requests)
```

## Required environment variables

Create a `.env` (or `.env.local`) file (or configure variables within Coolify) using the template below:

```env
S3_ENDPOINT=https://s3.eu-central-2.hetzner.cloud
S3_REGION=eu-central-2
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
ADMIN_PASSWORD=change-me
PORT=3000
FORCE_PATH_STYLE=false
S3_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
S3_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
TRUST_PROXY=true
# Optional multipart tuning
UPLOAD_PART_SIZE_BYTES=8388608
UPLOAD_MAX_CONCURRENCY=4
# Optional: uncomment to enable structured log file output
# LOG_FILE=/var/log/s3-upload-platform/server.log
```

- `S3_ENDPOINT`: Hetzner object storage endpoint URL.
- `S3_REGION`: Region identifier (e.g., `eu-central-2`).
- `S3_BUCKET`: Bucket to manage via the dashboard. The app also accepts `S3_BUCKET_NAME`, `BUCKET`, or `BUCKET_NAME` for compatibility with existing deployments.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: Access credentials with the minimum required permissions.
- `ADMIN_PASSWORD`: Password for the `admin` user used by HTTP basic authentication.
- `PORT` (optional): Port that the Express server listens on (defaults to 3000).
- `FORCE_PATH_STYLE` (optional): Defaults to virtual-hosted style (`false`). Override to `true` only if your provider requires path-style addressing.
- `S3_REQUEST_CHECKSUM_CALCULATION` (optional): Controls when the SDK adds checksum headers to requests. Accepts `WHEN_REQUIRED` or `WHEN_SUPPORTED` and defaults to `WHEN_REQUIRED`. Hetzner still rejects multipart uploads when newer SDK versions force integrity headers, so this flag is primarily for diagnostics.
- `S3_RESPONSE_CHECKSUM_VALIDATION` (optional): Governs how the SDK validates response checksums. Accepts `WHEN_REQUIRED`, `WHEN_SUPPORTED`, or `NEVER` and defaults to `WHEN_REQUIRED`.
- `TRUST_PROXY` (optional): Overrides Express's [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) setting. Defaults to `true` so deployments behind load balancers or reverse proxies correctly honour `X-Forwarded-*` headers. Set to `false` to disable or provide a numeric/string value to match your topology.
- `LOG_FILE` (optional): Absolute or relative path to a writable file. When set, the server continues logging to stdout/stderr and also appends timestamped entries to the specified file, making it easier to inspect request and S3 activity after the fact.
- `UPLOAD_PART_SIZE_BYTES` (optional): Overrides the multipart part size used by the client (defaults to 8 MiB, but the server will never allow values below S3's 5 MiB minimum).
- `UPLOAD_MAX_CONCURRENCY` (optional): Caps how many parts the client uploads in parallel (defaults to 4).

> ℹ️ Ensure your Hetzner bucket CORS policy exposes the `ETag`, `x-amz-request-id`, and `x-amz-id-2` headers so the browser can read multipart upload responses.

## Hetzner compatibility and AWS SDK pinning

Hetzner Object Storage is S3-compatible but currently rejects the "Data Integrity Protection" signatures that the AWS SDK for JavaScript v3 started sending by default in `@aws-sdk/client-s3@3.729.0`. To guarantee stable multipart uploads we pin the S3 packages (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, and `@aws-sdk/s3-request-presigner`) to `3.726.1`. The server logs the detected SDK version (`s3SdkVersion`) and endpoint host at startup, and it will refuse to boot if it detects a Hetzner endpoint (`*.your-objectstorage.com`) with an incompatible SDK version. The failure is intentional so misconfigured deployments do not partially work.

If you switch to genuine AWS S3 endpoints you may upgrade the AWS SDK packages, but re-test multipart uploads against Hetzner (or any other S3-compatible provider) before deploying those changes broadly.

`S3_REQUEST_CHECKSUM_CALCULATION` and `S3_RESPONSE_CHECKSUM_VALIDATION` remain configurable for diagnostics, but they are observability knobs—the guaranteed compatibility comes from the version pin and runtime guard described above.

## Multipart upload diagnostic CLI

Run the following command to perform a small multipart upload using the exact same client configuration as the server:

```bash
npm run check:s3-multipart
```

The script creates a temporary object using multipart uploads, reports progress, and deletes the object afterward. It honours the same environment variables (including the runtime guard), making it ideal for troubleshooting Hetzner deployments or validating future SDK upgrades in CI.

## Getting started locally

1. Copy the example environment file and adjust the values:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies and start the development server:
   ```bash
   npm install
   npm start
   ```
3. Visit `http://localhost:3000` and authenticate with username `admin` and your `ADMIN_PASSWORD` value.

## Docker usage

Build and run the container locally:

```bash
docker build -t hetzner-s3-ui .
docker run --rm -p 3000:3000 \
  -e S3_ENDPOINT=... \
  -e S3_REGION=... \
  -e S3_BUCKET=... \
  -e S3_ACCESS_KEY_ID=... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e ADMIN_PASSWORD=... \
  hetzner-s3-ui
```

## Deploying with Coolify

1. Add a new application in Coolify pointing to this repository.
2. Choose the provided `Dockerfile` (or the Node 20 runtime) and expose port `3000`.
3. Define all environment variables listed above within Coolify.
4. Deploy. Coolify will build the container, inject the environment variables, and start the app.

## Security recommendations

- Use a strong, unique `ADMIN_PASSWORD` and rotate it periodically.
- Provision S3 credentials with the least privileges required (e.g., restrict to the target bucket).
- Always place Coolify behind HTTPS and restrict network access to trusted IP ranges where possible.
- Monitor bucket access logs to detect suspicious activity.

## Acceptance criteria checklist

- [x] Browse root and nested prefixes
- [x] Create folders inside the current prefix
- [x] Upload large files directly from the browser via multipart uploads
- [x] Compatible with Hetzner Object Storage via the pinned AWS SDK 3.726.1 guardrails
- [x] Container builds and runs with `docker build . && docker run -p 3000:3000 ...`
