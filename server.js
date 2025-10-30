import express from 'express';
import helmet from 'helmet';
import basicAuth from 'express-basic-auth';
import fs from 'fs';
import path from 'path';
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const resolveBucket = () => {
  const candidates = [
    process.env.S3_BUCKET,
    process.env.S3_BUCKET_NAME,
    process.env.BUCKET,
    process.env.BUCKET_NAME
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim().length > 0) || '';
};

const requiredEnv = {
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_BUCKET: resolveBucket(),
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD
};

const missingEnv = Object.entries(requiredEnv)
  .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
  .map(([key]) => key);
if (missingEnv.length > 0) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const {
  S3_ENDPOINT,
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY
} = process.env;

const S3_BUCKET = requiredEnv.S3_BUCKET;
const ADMIN_PASSWORD = requiredEnv.ADMIN_PASSWORD;
const FORCE_PATH_STYLE = process.env.FORCE_PATH_STYLE;
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY;

const serializeError = (error) => ({
  name: error?.name,
  message: error?.message,
  stack: error?.stack,
  statusCode: error?.statusCode,
  retryable: error?.retryable,
  code: error?.code,
  $metadata: error?.$metadata
});

const LOG_FILE = typeof process.env.LOG_FILE === 'string' && process.env.LOG_FILE.trim().length > 0
  ? process.env.LOG_FILE.trim()
  : null;

let logStream = null;

const writeLogLine = (level, message, meta) => {
  if (!logStream) {
    return;
  }

  const metaString = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${new Date().toISOString()}] [${level}] ${message}${metaString}\n`;
  logStream.write(line);
};

if (LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.on('error', (streamError) => {
      const streamMeta = { logFile: LOG_FILE, error: serializeError(streamError) };
      console.error('[ERROR] Log stream error', JSON.stringify(streamMeta));
    });
    console.log('[INFO] File logging enabled', JSON.stringify({ logFile: LOG_FILE }));
    writeLogLine('INFO', 'File logging enabled', { logFile: LOG_FILE });
  } catch (error) {
    const errorMeta = { logFile: LOG_FILE, error: serializeError(error) };
    console.error('[ERROR] Failed to initialize log file', JSON.stringify(errorMeta));
  }
}

const logToConsole = (method, level, message, meta) => {
  const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
  if (metaString) {
    console[method](`[${level}] ${message}`, metaString);
  } else {
    console[method](`[${level}] ${message}`);
  }
};

const logger = {
  info: (message, meta = {}) => {
    logToConsole('log', 'INFO', message, meta);
    writeLogLine('INFO', message, meta);
  },
  warn: (message, meta = {}) => {
    logToConsole('warn', 'WARN', message, meta);
    writeLogLine('WARN', message, meta);
  },
  error: (message, meta = {}) => {
    logToConsole('error', 'ERROR', message, meta);
    writeLogLine('ERROR', message, meta);
  }
};

const closeLogStream = () => {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
};

process.on('exit', closeLogStream);
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    closeLogStream();
    process.exit(0);
  });
});

const parseTrustProxy = (value) => {
  if (value === undefined) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) {
    return asNumber;
  }

  return value;
};

const s3Client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY
  },
  forcePathStyle: FORCE_PATH_STYLE ? FORCE_PATH_STYLE.toLowerCase() === 'true' : true
});

const app = express();

const containsTraversal = (value) => value.includes('..');

const trustProxySetting = parseTrustProxy(TRUST_PROXY);
app.set('trust proxy', trustProxySetting);

logger.info('Server configuration', {
  s3Endpoint: S3_ENDPOINT,
  s3Bucket: S3_BUCKET,
  trustProxy: app.get('trust proxy'),
  logFile: LOG_FILE || null
});
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(
  basicAuth({
    users: { admin: ADMIN_PASSWORD },
    challenge: true,
    realm: 'Hetzner S3 Dashboard'
  })
);

app.use(express.static('public', { fallthrough: true }));

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.use((req, res, next) => {
  const startTime = Date.now();
  const requestMeta = {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    user: req.auth?.user
  };

  logger.info('Incoming request', requestMeta);

  res.on('finish', () => {
    logger.info('Request completed', {
      ...requestMeta,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime
    });
  });

  next();
});

const sendS3Command = async (command, meta = {}) => {
  const commandName = command?.constructor?.name || 'UnknownCommand';
  logger.info('Executing S3 command', { command: commandName, ...meta });
  try {
    const response = await s3Client.send(command);
    logger.info('S3 command succeeded', {
      command: commandName,
      ...meta,
      httpStatusCode: response?.$metadata?.httpStatusCode
    });
    return response;
  } catch (error) {
    logger.error('S3 command failed', {
      command: commandName,
      ...meta,
      error: serializeError(error)
    });
    throw error;
  }
};

app.get('/api/list', asyncHandler(async (req, res) => {
  const prefixParam = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  let decodedPrefix = '';
  try {
    decodedPrefix = decodeURIComponent(prefixParam.replace(/\+/g, ' '));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid prefix encoding' });
  }

  if (decodedPrefix.startsWith('/') || containsTraversal(decodedPrefix)) {
    return res.status(400).json({ error: 'Invalid prefix' });
  }
  const continuationToken = typeof req.query.continuationToken === 'string' ? req.query.continuationToken : undefined;

  const params = {
    Bucket: S3_BUCKET,
    Prefix: decodedPrefix === '/' ? '' : decodedPrefix,
    Delimiter: '/',
    ContinuationToken: continuationToken
  };

  const command = new ListObjectsV2Command(params);
  const response = await sendS3Command(command, {
    prefix: params.Prefix,
    continuationToken: params.ContinuationToken
  });

  const prefixes = (response.CommonPrefixes || [])
    .map((item) => ({ prefix: item.Prefix }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix, undefined, { sensitivity: 'base' }));

  const objects = (response.Contents || [])
    .filter((object) => object.Key !== decodedPrefix)
    .map((object) => ({
      key: object.Key,
      size: object.Size,
      lastModified: object.LastModified
    }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));

  res.json({
    prefix: decodedPrefix,
    isTruncated: response.IsTruncated || false,
    nextContinuationToken: response.NextContinuationToken || null,
    prefixes,
    objects
  });
}));

app.post('/api/list', asyncHandler(async (req, res) => {
  res.status(405).json({ error: 'Method not allowed' });
}));

app.post('/api/mkdir', asyncHandler(async (req, res) => {
  const { prefix } = req.body || {};
  if (!prefix || typeof prefix !== 'string') {
    return res.status(400).json({ error: 'prefix is required' });
  }

  if (prefix.startsWith('/') || containsTraversal(prefix)) {
    return res.status(400).json({ error: 'Invalid prefix' });
  }

  const sanitized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: sanitized,
    Body: ''
  });

  await sendS3Command(command, { key: sanitized });
  res.status(201).json({ key: sanitized });
}));

app.post('/api/create-multipart', asyncHandler(async (req, res) => {
  const { key, contentType } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'key is required' });
  }

  if (key.startsWith('/') || containsTraversal(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  const objectKey = key;

  const command = new CreateMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: objectKey,
    ContentType: contentType
  });

  const response = await sendS3Command(command, { key: objectKey, contentType });
  if (!response?.UploadId) {
    throw new Error('Failed to create multipart upload: missing UploadId');
  }

  res.status(201).json({ uploadId: response.UploadId, key: objectKey });
}));

app.get('/api/sign-part', asyncHandler(async (req, res) => {
  const { key, uploadId, partNumber } = req.query;

  if (!key || !uploadId || !partNumber) {
    return res.status(400).json({ error: 'key, uploadId and partNumber are required' });
  }

  if (key.startsWith('/') || containsTraversal(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  const partNum = Number(partNumber);
  if (!Number.isInteger(partNum) || partNum <= 0) {
    return res.status(400).json({ error: 'partNumber must be a positive integer' });
  }

  const command = new UploadPartCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNum
  });

  logger.info('Generating signed URL for multipart upload part', {
    key,
    uploadId,
    partNumber: partNum
  });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  logger.info('Generated signed URL for multipart upload part', {
    key,
    uploadId,
    partNumber: partNum
  });
  res.set({
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.removeHeader('ETag');
  res.json({ url });
}));

app.post('/api/complete-multipart', asyncHandler(async (req, res) => {
  const { key, uploadId, parts } = req.body || {};

  if (!key || !uploadId || !Array.isArray(parts)) {
    return res.status(400).json({ error: 'key, uploadId and parts array are required' });
  }

  if (key.startsWith('/') || containsTraversal(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  const formattedParts = parts
    .map((part) => ({
      ETag: part.ETag,
      PartNumber: Number(part.PartNumber)
    }))
    .filter((part) => typeof part.ETag === 'string' && Number.isInteger(part.PartNumber) && part.PartNumber > 0)
    .sort((a, b) => a.PartNumber - b.PartNumber);

  if (formattedParts.length === 0) {
    return res.status(400).json({ error: 'parts array must include valid PartNumber and ETag values' });
  }

  const command = new CompleteMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: formattedParts
    }
  });

  const response = await sendS3Command(command, {
    key,
    uploadId,
    partsCount: formattedParts.length
  });
  res.json({ location: response.Location, bucket: response.Bucket, key: response.Key });
}));

app.post('/api/abort-multipart', asyncHandler(async (req, res) => {
  const { key, uploadId } = req.body || {};

  if (!key || !uploadId) {
    return res.status(400).json({ error: 'key and uploadId are required' });
  }

  if (key.startsWith('/') || containsTraversal(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  const command = new AbortMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId
  });

  await sendS3Command(command, { key, uploadId });
  res.status(204).end();
}));

app.use((err, req, res, next) => {
  logger.error('Unhandled error encountered', {
    method: req.method,
    url: req.originalUrl,
    user: req.auth?.user,
    error: serializeError(err)
  });
  const status = err.$metadata?.httpStatusCode || err.statusCode || 500;
  res.status(status).json({ error: 'Internal server error' });
});

app.listen(Number(PORT), () => {
  logger.info('Server running', { port: Number(PORT) });
});
