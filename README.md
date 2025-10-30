# S3 Upload Platform

A self-hosted web UI for Hetzner S3 (or any S3-compatible storage). Password-protected dashboard to browse prefixes, create folders, and upload large files via browser using S3 Multipart Upload with presigned URLs.

## Features

- 🔐 **Password-protected** dashboard for secure access
- 📁 **Browse S3 buckets** with folder navigation
- ➕ **Create folders** directly in S3
- 📤 **Upload large files** using multipart upload via presigned URLs
- 🚀 **Direct browser-to-S3** streaming (server only signs requests, doesn't proxy data)
- 🐳 **Docker deployable** on Coolify or any Docker host
- ⚙️ **Environment configurable** for easy setup

## Technology Stack

- **Backend**: Node.js + Express
- **S3 SDK**: AWS SDK v3 (@aws-sdk/client-s3)
- **File Upload**: Uppy with AWS S3 plugin
- **Deployment**: Docker + Docker Compose

## Quick Start

### Using Docker Compose (Recommended)

1. Clone the repository:
```bash
git clone https://github.com/hcthisen/S3-Upload-Platform.git
cd S3-Upload-Platform
```

2. Copy the environment template and configure your S3 credentials:
```bash
cp .env.example .env
```

3. Edit `.env` with your Hetzner S3 credentials:
```env
S3_ENDPOINT=https://your-bucket.fsn1.your-objectstorage.com
S3_BUCKET_NAME=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
DASHBOARD_PASSWORD=your-secure-password
SESSION_SECRET=random-secret-string-for-sessions
```

4. Start the application:
```bash
docker-compose up -d
```

5. Access the dashboard at `http://localhost:3000`

### Manual Setup (Without Docker)

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your configuration (see step 3 above)

3. Start the server:
```bash
npm start
```

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `S3_ENDPOINT` | S3-compatible endpoint URL | - | Yes |
| `S3_REGION` | S3 region | `us-east-1` | No |
| `S3_BUCKET_NAME` | Name of your S3 bucket | - | Yes |
| `S3_ACCESS_KEY_ID` | S3 access key | - | Yes |
| `S3_SECRET_ACCESS_KEY` | S3 secret key | - | Yes |
| `DASHBOARD_PASSWORD` | Password for dashboard access | `admin` | Yes |
| `SESSION_SECRET` | Secret for session encryption | Auto-generated | Recommended |
| `PORT` | Server port | `3000` | No |
| `NODE_ENV` | Environment mode | `development` | No |

### Hetzner S3 Configuration

For Hetzner Object Storage, use the following format:

```env
S3_ENDPOINT=https://<bucket-name>.<location>.your-objectstorage.com
S3_REGION=us-east-1
S3_BUCKET_NAME=<bucket-name>
```

**Location codes:**
- `fsn1` - Falkenstein, Germany
- `nbg1` - Nuremberg, Germany
- `hel1` - Helsinki, Finland

Example:
```env
S3_ENDPOINT=https://my-bucket.fsn1.your-objectstorage.com
S3_BUCKET_NAME=my-bucket
```

## Deployment

### Coolify

1. Create a new service in Coolify
2. Select "Docker Compose" as the build pack
3. Connect your Git repository
4. Add environment variables in the Coolify UI
5. Deploy!

### Standard Docker

Build and run:
```bash
docker build -t s3-upload-platform .
docker run -d \
  -p 3000:3000 \
  -e S3_ENDPOINT=your-endpoint \
  -e S3_BUCKET_NAME=your-bucket \
  -e S3_ACCESS_KEY_ID=your-key \
  -e S3_SECRET_ACCESS_KEY=your-secret \
  -e DASHBOARD_PASSWORD=your-password \
  s3-upload-platform
```

### Docker Compose

```bash
docker-compose up -d
```

## Usage

1. **Login**: Enter the password you configured in `DASHBOARD_PASSWORD`

2. **Browse Files**: Navigate through folders by clicking on them

3. **Create Folders**: Click "New Folder" button and enter a folder name

4. **Upload Files**: 
   - Click "Upload Files" button
   - Drag and drop files or click to select
   - Files upload directly from your browser to S3
   - Large files automatically use multipart upload

## Architecture

The application uses a secure architecture where:

1. **Server Role**: The Express server only generates presigned URLs for S3 operations
2. **Client Upload**: Files stream directly from the browser to S3 using presigned URLs
3. **No Proxying**: The server never handles file data, ensuring better performance and scalability
4. **Multipart Upload**: Large files (>100MB) automatically use S3 multipart upload for reliability

## Security Notes

- Change the default `DASHBOARD_PASSWORD` immediately
- Use a strong, random `SESSION_SECRET` in production
- Use HTTPS in production (configure via reverse proxy like Nginx or Traefik)
- Keep your S3 credentials secure and never commit them to version control
- Consider using IAM roles with minimal required permissions

## License

MIT

## Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

