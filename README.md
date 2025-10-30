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

The application is a Node.js (Express) service that exposes REST endpoints for listing objects, creating prefixes, and orchestrating multipart uploads with the AWS SDK v3. The browser UI (built with vanilla JS and Uppy) requests presigned URLs from the server and uploads file parts directly to Hetzner Object Storage. This keeps the server lightweight and avoids proxying large payloads.

```
Browser ⇄ Express server ⇄ Hetzner S3 (presigned requests)
```

## Required environment variables

Create a `.env` file (or configure variables within Coolify) using the template below:

```env
S3_ENDPOINT=https://s3.eu-central-2.hetzner.cloud
S3_REGION=eu-central-2
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
ADMIN_PASSWORD=change-me
PORT=3000
FORCE_PATH_STYLE=true
```

- `S3_ENDPOINT`: Hetzner object storage endpoint URL.
- `S3_REGION`: Region identifier (e.g., `eu-central-2`).
- `S3_BUCKET`: Bucket to manage via the dashboard.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: Access credentials with the minimum required permissions.
- `ADMIN_PASSWORD`: Password for the `admin` user used by HTTP basic authentication.
- `PORT` (optional): Port that the Express server listens on (defaults to 3000).
- `FORCE_PATH_STYLE` (optional): Set to `true` to enable path-style requests (recommended for Hetzner).

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
- [x] Compatible with Hetzner Object Storage and path-style addressing
- [x] Container builds and runs with `docker build . && docker run -p 3000:3000 ...`
