import express from 'express';
import helmet from 'helmet';
import basicAuth from 'express-basic-auth';
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

console.log(`S3 Endpoint: ${S3_ENDPOINT}`);
console.log(`S3 Bucket: ${S3_BUCKET}`);
console.log(`Trust proxy setting: ${JSON.stringify(app.get('trust proxy'))}`);
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

app.get('/api/list', asyncHandler(async (req, res) => {
  const prefixParam = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  let decodedPrefix = '';
  try {
    decodedPrefix = decodeURIComponent(prefixParam);
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
  const response = await s3Client.send(command);

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

  await s3Client.send(command);
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

  const command = new CreateMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType
  });

  const response = await s3Client.send(command);
  res.status(201).json({ uploadId: response.UploadId, key: response.Key });
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

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
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

  const response = await s3Client.send(command);
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

  await s3Client.send(command);
  res.status(204).end();
}));

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.$metadata?.httpStatusCode || err.statusCode || 500;
  res.status(status).json({ error: 'Internal server error' });
});

app.listen(Number(PORT), () => {
  console.log(`Server running on port ${PORT}`);
});
