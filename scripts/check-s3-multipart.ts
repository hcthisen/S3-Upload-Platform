import crypto from 'crypto';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  resolveBucket,
  resolveRequestChecksumCalculation,
  resolveResponseChecksumValidation,
  resolveForcePathStyle,
  ensureHetznerCompatibleSdk
} from '../s3/utils.js';

const serializeError = (error: unknown) => ({
  name: (error as { name?: string })?.name,
  message: (error as { message?: string })?.message,
  stack: (error as { stack?: string })?.stack,
  statusCode: (error as { statusCode?: number })?.statusCode,
  retryable: (error as { retryable?: boolean })?.retryable,
  code: (error as { code?: string })?.code,
  metadata: (error as { $metadata?: unknown })?.$metadata
});

const logger = {
  info: (message: string, meta: Record<string, unknown> = {}) => {
    const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    console.log(`[INFO] ${message}${metaString ? ` ${metaString}` : ''}`);
  },
  warn: (message: string, meta: Record<string, unknown> = {}) => {
    const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    console.warn(`[WARN] ${message}${metaString ? ` ${metaString}` : ''}`);
  },
  error: (message: string, meta: Record<string, unknown> = {}) => {
    const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    console.error(`[ERROR] ${message}${metaString ? ` ${metaString}` : ''}`);
  }
};

const requiredEnv = {
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_BUCKET: resolveBucket(),
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY
};

const missingEnv = Object.entries(requiredEnv)
  .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
  .map(([key]) => key);

if (missingEnv.length > 0) {
  logger.error('Missing required environment variables for multipart diagnostic', { missingEnv });
  process.exit(1);
}

const {
  value: requestChecksumCalculation,
  invalidValue: invalidRequestChecksumCalculation
} = resolveRequestChecksumCalculation(process.env.S3_REQUEST_CHECKSUM_CALCULATION);

const {
  value: responseChecksumValidation,
  invalidValue: invalidResponseChecksumValidation
} = resolveResponseChecksumValidation(process.env.S3_RESPONSE_CHECKSUM_VALIDATION);

if (invalidRequestChecksumCalculation) {
  logger.warn('Invalid S3_REQUEST_CHECKSUM_CALCULATION value provided, falling back to default', {
    providedValue: invalidRequestChecksumCalculation,
    appliedValue: requestChecksumCalculation
  });
}

if (invalidResponseChecksumValidation) {
  logger.warn('Invalid S3_RESPONSE_CHECKSUM_VALIDATION value provided, falling back to default', {
    providedValue: invalidResponseChecksumValidation,
    appliedValue: responseChecksumValidation
  });
}

const { version: s3SdkVersion, endpointHost: s3EndpointHost, isHetzner } = ensureHetznerCompatibleSdk({
  endpoint: process.env.S3_ENDPOINT as string,
  logger
});

const {
  value: forcePathStyle,
  invalidValue: invalidForcePathStyle
} = resolveForcePathStyle(process.env.FORCE_PATH_STYLE);

if (invalidForcePathStyle) {
  logger.warn('Invalid FORCE_PATH_STYLE value provided, defaulting to virtual-hosted style addressing', {
    providedValue: invalidForcePathStyle,
    appliedValue: forcePathStyle
  });
}

const s3Client = new S3Client({
  region: process.env.S3_REGION as string,
  endpoint: process.env.S3_ENDPOINT as string,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string
  },
  forcePathStyle,
  signingEscapePath: true,
  requestChecksumCalculation,
  responseChecksumValidation
});

const PART_SIZE_BYTES = 5 * 1024 * 1024;
const TOTAL_SIZE_BYTES = PART_SIZE_BYTES * 2;
const testKey = `diagnostics/multipart-upload-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomInt(1e6)}.bin`;
const testPayload = Buffer.allocUnsafe(TOTAL_SIZE_BYTES);
crypto.randomFillSync(testPayload);

(async () => {
  logger.info('Starting S3 multipart diagnostic upload', {
    bucket: requiredEnv.S3_BUCKET,
    key: testKey,
    s3SdkVersion,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3EndpointHost,
    forcePathStyle,
    requestChecksumCalculation,
    responseChecksumValidation
  });

  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: requiredEnv.S3_BUCKET,
        Key: testKey,
        Body: testPayload,
        ContentType: 'application/octet-stream'
      },
      queueSize: 2,
      partSize: PART_SIZE_BYTES,
      leavePartsOnError: false
    });

    upload.on('httpUploadProgress', (progress) => {
      logger.info('Multipart progress', progress);
    });

    const result = await upload.done();
    logger.info('Multipart upload completed successfully', {
      bucket: result?.Bucket ?? requiredEnv.S3_BUCKET,
      key: result?.Key ?? testKey,
      eTag: result?.ETag ?? null
    });

    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: requiredEnv.S3_BUCKET,
        Key: testKey
      }));
      logger.info('Cleaned up diagnostic object', { key: testKey });
    } catch (cleanupError) {
      logger.warn('Failed to delete diagnostic object after upload', {
        key: testKey,
        error: serializeError(cleanupError)
      });
    }

    process.exit(0);
  } catch (error) {
    logger.error('Multipart diagnostic upload failed', {
      key: testKey,
      error: serializeError(error)
    });
    process.exit(1);
  }
})();
