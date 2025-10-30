require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;

// S3 Client Configuration
const s3Client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // Required for Hetzner and other S3-compatible services
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts from this IP, please try again later.',
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiting to all API routes
app.use('/api', apiLimiter);

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// Login endpoint with stricter rate limiting
app.post('/api/login', authLimiter, (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// List objects in S3 bucket (with optional prefix)
app.get('/api/objects', requireAuth, async (req, res) => {
  try {
    // Ensure prefix is a string to prevent type confusion
    let prefix = req.query.prefix || '';
    if (Array.isArray(prefix)) {
      prefix = prefix[0] || '';
    }
    prefix = String(prefix);
    
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      Delimiter: '/',
    });

    const response = await s3Client.send(command);
    
    // Format response to separate folders and files
    const folders = (response.CommonPrefixes || []).map(p => ({
      type: 'folder',
      name: p.Prefix.slice(prefix.length),
      fullPath: p.Prefix,
    }));

    const files = (response.Contents || [])
      .filter(item => item.Key !== prefix) // Exclude the prefix itself
      .map(item => ({
        type: 'file',
        name: item.Key.slice(prefix.length),
        fullPath: item.Key,
        size: item.Size,
        lastModified: item.LastModified,
      }));

    res.json({
      prefix,
      folders,
      files,
    });
  } catch (error) {
    console.error('Error listing objects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create folder (by creating an empty object with trailing slash)
app.post('/api/folder', requireAuth, async (req, res) => {
  try {
    let { path: folderPath } = req.body;
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ error: 'Folder path is required and must be a string' });
    }

    // Sanitize the folder path
    folderPath = String(folderPath).trim();
    
    // Ensure path ends with /
    const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: normalizedPath,
      Body: '',
    });

    await s3Client.send(command);
    res.json({ success: true, path: normalizedPath });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// Initialize multipart upload
app.post('/api/upload/init', requireAuth, async (req, res) => {
  try {
    let { filename, path: filePath } = req.body;
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'Filename is required and must be a string' });
    }

    filename = String(filename).trim();
    filePath = filePath ? String(filePath).trim() : '';
    
    const key = filePath ? `${filePath}${filename}` : filename;

    // For multipart upload, we'll use presigned URLs for each part
    // Return the upload configuration
    res.json({
      key,
      bucket: BUCKET_NAME,
    });
  } catch (error) {
    console.error('Error initializing upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get presigned URL for uploading a file part
app.post('/api/upload/presign', requireAuth, async (req, res) => {
  try {
    let { key, partNumber } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Key is required and must be a string' });
    }

    key = String(key).trim();
    
    // Generate presigned URL for PUT operation
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    
    res.json({ url: signedUrl });
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`S3 Endpoint: ${process.env.S3_ENDPOINT || 'default'}`);
  console.log(`S3 Bucket: ${BUCKET_NAME}`);
});
