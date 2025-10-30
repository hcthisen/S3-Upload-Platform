# Deployment Guide

## Quick Start with Docker Compose

This is the recommended method for most users.

### 1. Prerequisites
- Docker and Docker Compose installed
- Hetzner S3 bucket or any S3-compatible storage

### 2. Setup Steps

```bash
# Clone the repository
git clone https://github.com/hcthisen/S3-Upload-Platform.git
cd S3-Upload-Platform

# Copy environment template
cp .env.example .env

# Edit .env with your S3 credentials
nano .env
```

### 3. Configure .env

```env
# S3 Configuration
S3_ENDPOINT=https://your-bucket.fsn1.your-objectstorage.com
S3_BUCKET_NAME=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key

# Security
DASHBOARD_PASSWORD=your-secure-password
SESSION_SECRET=generate-a-random-32-char-string

# Optional
PORT=3000
NODE_ENV=production
S3_REGION=us-east-1
```

### 4. Deploy

```bash
# Start the application
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the application
docker-compose down
```

### 5. Access

Open your browser and navigate to `http://localhost:3000`

---

## Deployment on Coolify

Coolify makes deployment even easier with its UI.

### 1. Create New Resource

1. Log into your Coolify dashboard
2. Click "New Resource"
3. Select "Docker Compose"

### 2. Connect Repository

1. Connect your GitHub account
2. Select the `S3-Upload-Platform` repository
3. Select the branch you want to deploy

### 3. Configure Environment Variables

Add these environment variables in Coolify:

| Variable | Value |
|----------|-------|
| `S3_ENDPOINT` | Your S3 endpoint URL |
| `S3_BUCKET_NAME` | Your bucket name |
| `S3_ACCESS_KEY_ID` | Your access key |
| `S3_SECRET_ACCESS_KEY` | Your secret key |
| `DASHBOARD_PASSWORD` | Your dashboard password |
| `SESSION_SECRET` | Random 32+ character string |
| `PORT` | 3000 |
| `NODE_ENV` | production |

### 4. Deploy

Click "Deploy" and Coolify will:
- Build the Docker image
- Start the container
- Set up automatic restarts
- Provide SSL certificates (if configured)

### 5. Access

Access your application via the domain configured in Coolify.

---

## Deployment with Nginx Reverse Proxy

For production deployments behind a reverse proxy.

### 1. Run the Application

```bash
docker-compose up -d
```

### 2. Configure Nginx

Create `/etc/nginx/sites-available/s3-upload`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL Configuration
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy to Application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Increase timeout for large uploads
        proxy_read_timeout 3600s;
        proxy_connect_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Increase max upload size
    client_max_body_size 0;
}
```

### 3. Enable and Restart Nginx

```bash
sudo ln -s /etc/nginx/sites-available/s3-upload /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Deployment on AWS EC2 / VPS

### 1. Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo apt install docker-compose -y

# Add user to docker group
sudo usermod -aG docker $USER
```

### 2. Deploy Application

```bash
# Clone repository
git clone https://github.com/hcthisen/S3-Upload-Platform.git
cd S3-Upload-Platform

# Configure environment
cp .env.example .env
nano .env

# Start application
docker-compose up -d
```

### 3. Configure Firewall

```bash
# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `S3_ENDPOINT` | Yes | - | S3-compatible endpoint URL |
| `S3_BUCKET_NAME` | Yes | - | Name of your S3 bucket |
| `S3_ACCESS_KEY_ID` | Yes | - | S3 access key |
| `S3_SECRET_ACCESS_KEY` | Yes | - | S3 secret key |
| `DASHBOARD_PASSWORD` | Yes | `admin` | Password for dashboard access |
| `SESSION_SECRET` | Recommended | Auto-generated | Secret for session encryption |
| `PORT` | No | `3000` | Server port |
| `NODE_ENV` | No | `development` | Environment mode |
| `S3_REGION` | No | `us-east-1` | S3 region |

---

## Troubleshooting

### Application won't start

1. Check Docker logs:
   ```bash
   docker-compose logs -f
   ```

2. Verify environment variables are set correctly

3. Ensure S3 credentials have proper permissions

### Can't connect to S3

1. Verify S3 endpoint URL is correct
2. Check S3 access key and secret key
3. Ensure bucket name is correct
4. Verify network connectivity to S3 endpoint

### Upload fails

1. Check S3 bucket CORS configuration
2. Verify presigned URL expiration (default 1 hour)
3. Check browser console for errors
4. Ensure bucket has proper permissions for uploads

### Session issues

1. Verify `SESSION_SECRET` is set
2. Check browser cookies are enabled
3. Clear browser cookies and try again

---

## Monitoring

### View Application Logs

```bash
# Docker Compose
docker-compose logs -f

# Docker
docker logs -f s3-upload-platform
```

### Check Application Health

```bash
# Health check endpoint
curl http://localhost:3000/api/auth/status
```

### Monitor Resource Usage

```bash
# Docker stats
docker stats
```

---

## Updating

### Using Docker Compose

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose up -d --build
```

### Using Docker

```bash
# Pull latest image
docker pull s3-upload-platform:latest

# Stop and remove old container
docker stop s3-upload-platform
docker rm s3-upload-platform

# Start new container
docker run -d --name s3-upload-platform \
  --env-file .env \
  -p 3000:3000 \
  s3-upload-platform:latest
```

---

## Backup and Restore

The application is stateless - all data is stored in S3. To backup:

1. Export your `.env` file securely
2. Backup your S3 bucket using S3 sync or backup tools

---

## Support

For issues and questions:
- GitHub Issues: https://github.com/hcthisen/S3-Upload-Platform/issues
- Documentation: See README.md
