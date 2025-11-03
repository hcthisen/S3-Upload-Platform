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
  UploadPartCommand,
  ListPartsCommand
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
  S3_SECRET_ACCESS_KEY,
  WEBHOOK_UPLOAD_TRIGGER
} = process.env;

const S3_BUCKET = requiredEnv.S3_BUCKET;
const ADMIN_PASSWORD = requiredEnv.ADMIN_PASSWORD;
const FORCE_PATH_STYLE = process.env.FORCE_PATH_STYLE;
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY;
const UPLOAD_WEBHOOK_URL =
  typeof WEBHOOK_UPLOAD_TRIGGER === 'string' && WEBHOOK_UPLOAD_TRIGGER.trim().length > 0
    ? WEBHOOK_UPLOAD_TRIGGER.trim()
    : null;

const parsePositiveInteger = (value, fallback) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;

const configuredPartSize = parsePositiveInteger(process.env.UPLOAD_PART_SIZE_BYTES, DEFAULT_PART_SIZE);
const uploadConfig = {
  partSizeBytes: Math.max(configuredPartSize, MIN_PART_SIZE),
  maxConcurrency: parsePositiveInteger(process.env.UPLOAD_MAX_CONCURRENCY, DEFAULT_CONCURRENCY)
};

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
  forcePathStyle: FORCE_PATH_STYLE ? FORCE_PATH_STYLE.toLowerCase() === 'true' : true,
  signingEscapePath: true
});

const app = express();

const buildPublicObjectUrl = (location, bucket, key) => {
  if (typeof location === 'string' && location.trim()) {
    return location.trim();
  }

  if (!bucket || !key || !S3_ENDPOINT) {
    return null;
  }

  try {
    const endpointUrl = new URL(S3_ENDPOINT);
    const encodedKey = key
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const pathStyleUrl = `${endpointUrl.origin}/${bucket}/${encodedKey}`;
    return pathStyleUrl;
  } catch (error) {
    logger.warn('Failed to construct public object URL', {
      bucket,
      key,
      error: serializeError(error)
    });
    return null;
  }
};

const triggerUploadWebhook = async ({ url }) => {
  if (!UPLOAD_WEBHOOK_URL || !url) {
    return;
  }

  try {
    const response = await fetch(UPLOAD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      logger.warn('Upload webhook responded with non-OK status', {
        status: response.status,
        statusText: response.statusText
      });
    } else {
      logger.info('Upload webhook triggered successfully', { url });
    }
  } catch (error) {
    logger.warn('Failed to trigger upload webhook', {
      url,
      error: serializeError(error)
    });
  }
};

const containsTraversal = (value) => value.includes('..');

const trustProxySetting = parseTrustProxy(TRUST_PROXY);
app.set('trust proxy', trustProxySetting);

logger.info('Server configuration', {
  s3Endpoint: S3_ENDPOINT,
  s3Bucket: S3_BUCKET,
  trustProxy: app.get('trust proxy'),
  logFile: LOG_FILE || null,
  uploadPartSizeBytes: uploadConfig.partSizeBytes,
  uploadMaxConcurrency: uploadConfig.maxConcurrency
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

app.get('/api/upload-config', (req, res) => {
  res.json(uploadConfig);
});

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
  const { key, contentType, metadata } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'key is required' });
  }

  if (key.startsWith('/') || containsTraversal(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  const objectKey = key;

  const isMetadataObject = metadata && typeof metadata === 'object' && !Array.isArray(metadata);
  let metadataPayload;
  if (isMetadataObject) {
    const normalizeMetadataKey = (key) => {
      if (typeof key !== 'string') {
        return null;
      }

      const trimmed = key.trim().toLowerCase();
      if (!trimmed) {
        return null;
      }

      const withoutPrefix = trimmed.startsWith('x-amz-meta-')
        ? trimmed.slice('x-amz-meta-'.length)
        : trimmed;

      const sanitized = withoutPrefix.replace(/[^a-z0-9!#$&'*+.^_`|~-]/g, '-');
      if (!sanitized) {
        return null;
      }

      return sanitized;
    };

    const sanitizeMetadataValue = (value) => {
      if (value === undefined || value === null) {
        return '';
      }

      const stringValue = String(value);
      const isAsciiSafe = /^[\x20-\x7E]*$/.test(stringValue);
      if (!isAsciiSafe) {
        return null;
      }

      return stringValue;
    };

    metadataPayload = Object.entries(metadata).reduce((acc, [metaKey, metaValue]) => {
      const normalizedKey = normalizeMetadataKey(metaKey);
      if (!normalizedKey) {
        logger.warn('Skipping invalid metadata key', { key: metaKey });
        return acc;
      }

      const sanitizedValue = sanitizeMetadataValue(metaValue);
      if (sanitizedValue === null) {
        logger.warn('Skipping metadata value containing unsupported characters', {
          key: normalizedKey
        });
        return acc;
      }

      acc[normalizedKey] = sanitizedValue;
      return acc;
    }, {});

    if (metadataPayload && Object.keys(metadataPayload).length === 0) {
      metadataPayload = undefined;
    }
  }

  const multipartParams = {
    Bucket: S3_BUCKET,
    Key: objectKey,
    ContentType: contentType
  };

  if (metadataPayload) {
    multipartParams.Metadata = metadataPayload;
  } else if (isMetadataObject && Object.keys(metadata || {}).length > 0) {
    logger.warn('Omitting multipart metadata due to sanitization');
  }

  const command = new CreateMultipartUploadCommand(multipartParams);

  const response = await sendS3Command(command, { key: objectKey, contentType });
  if (!response?.UploadId) {
    throw new Error('Failed to create multipart upload: missing UploadId');
  }

  res.status(201).json({ uploadId: response.UploadId, key: objectKey, bucket: S3_BUCKET });
}));

app.post('/api/sign-part', asyncHandler(async (req, res) => {
  const { key, uploadId, partNumber } = req.body || {};

  if (!key || !uploadId || partNumber === undefined || partNumber === null) {
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
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

  const parsedParts = parts
    .map((part) => {
      const partNumber = Number(part?.PartNumber ?? part?.partNumber ?? part);
      if (!Number.isInteger(partNumber) || partNumber <= 0) {
        return null;
      }

      const rawEtag = part?.ETag ?? part?.etag;
      const normalizedEtag =
        typeof rawEtag === 'string' && rawEtag.trim().length > 0 ? rawEtag.trim() : null;

      return {
        PartNumber: partNumber,
        ETag: normalizedEtag
      };
    })
    .filter(Boolean);

  if (parsedParts.length === 0) {
    return res.status(400).json({ error: 'parts array must include valid PartNumber values' });
  }

  const missingPartNumbers = parsedParts
    .filter((part) => !part.ETag)
    .map((part) => part.PartNumber);

  const etagLookup = new Map();

  if (missingPartNumbers.length > 0) {
    const remaining = new Set(missingPartNumbers);
    let partNumberMarker = undefined;

    while (remaining.size > 0) {
      const listPartsCommand = new ListPartsCommand({
        Bucket: S3_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: partNumberMarker,
        MaxParts: 1000
      });

      const listResponse = await sendS3Command(listPartsCommand, {
        key,
        uploadId,
        partNumberMarker
      });

      for (const part of listResponse.Parts || []) {
        if (!etagLookup.has(part.PartNumber)) {
          etagLookup.set(part.PartNumber, part.ETag);
        }
        remaining.delete(part.PartNumber);
      }

      if (!listResponse.IsTruncated) {
        break;
      }

      partNumberMarker = listResponse.NextPartNumberMarker;
      if (partNumberMarker === undefined || partNumberMarker === null) {
        break;
      }
    }

    if (remaining.size > 0) {
      return res.status(400).json({
        error: `Unable to resolve ETag for parts: ${Array.from(remaining).join(', ')}`
      });
    }
  }

  const normalizedParts = parsedParts
    .map((part) => {
      const etag = part.ETag || etagLookup.get(part.PartNumber);
      return etag
        ? { PartNumber: part.PartNumber, ETag: etag }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.PartNumber - b.PartNumber);

  if (normalizedParts.length !== parsedParts.length) {
    return res.status(400).json({ error: 'Failed to normalize all multipart upload parts' });
  }

  const command = new CompleteMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: normalizedParts
    }
  });

  const response = await sendS3Command(command, {
    key,
    uploadId,
    partsCount: normalizedParts.length
  });
  const publicUrl = buildPublicObjectUrl(response.Location, response.Bucket || S3_BUCKET, response.Key || key);
  triggerUploadWebhook({ url: publicUrl });
  res.json({
    location: response.Location || null,
    bucket: response.Bucket || S3_BUCKET,
    key: response.Key || key,
    etag: response.ETag || null
  });
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
  res.json({ ok: true });
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
