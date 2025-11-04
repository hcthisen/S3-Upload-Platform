import crypto from 'crypto';
import {
  S3Client,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
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

const args = process.argv.slice(2);
const hasFlag = (flag: string) => args.includes(flag);
const getArgValue = (flag: string) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      return args[index + 1];
    }

    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }

  return undefined;
};

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: npm run check:s3-multipart [-- --object-key <key>] [--run-key-suite]\n\n` +
    `Options:\n` +
    `  --object-key <key>    Use the provided key for diagnostics instead of a random key.\n` +
    `  --run-key-suite       Run CreateMultipartUpload diagnostics for a suite of keys.\n` +
    `  -h, --help            Show this help message.`);
  process.exit(0);
}

const objectKeyArg = getArgValue('--object-key');
const objectKeyFlagProvided = args.some((arg) => arg === '--object-key' || arg.startsWith('--object-key='));

if (objectKeyFlagProvided && (objectKeyArg === undefined || objectKeyArg === '')) {
  logger.error('Missing value for --object-key argument');
  process.exit(1);
}

const objectKeyFromCli = typeof objectKeyArg === 'string' ? objectKeyArg : undefined;
const runKeySuite = hasFlag('--run-key-suite');

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

const signingEscapePath = isHetzner ? false : true;

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
  signingEscapePath,
  requestChecksumCalculation,
  responseChecksumValidation
});

const PART_SIZE_BYTES = 5 * 1024 * 1024;
const TOTAL_SIZE_BYTES = PART_SIZE_BYTES * 2;

const randomKey = () =>
  `diagnostics/multipart-upload-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomInt(1e6)}.bin`;

const buildUploadPayload = () => {
  const payload = Buffer.allocUnsafe(TOTAL_SIZE_BYTES);
  crypto.randomFillSync(payload);
  return payload;
};

const runMultipartUploadDiagnostic = async (key: string) => {
  const payload = buildUploadPayload();
  logger.info('Starting S3 multipart diagnostic upload', {
    bucket: requiredEnv.S3_BUCKET,
    key,
    s3SdkVersion,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3EndpointHost,
    forcePathStyle,
    signingEscapePath,
    requestChecksumCalculation,
    responseChecksumValidation,
    isHetznerEndpoint: isHetzner
  });

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: requiredEnv.S3_BUCKET,
      Key: key,
      Body: payload,
      ContentType: 'application/octet-stream'
    },
    queueSize: 2,
    partSize: PART_SIZE_BYTES,
    leavePartsOnError: false
  });

  upload.on('httpUploadProgress', (progress) => {
    logger.info('Multipart progress', { ...progress, key });
  });

  const result = await upload.done();
  logger.info('Multipart upload completed successfully', {
    bucket: result?.Bucket ?? requiredEnv.S3_BUCKET,
    key: result?.Key ?? key,
    eTag: result?.ETag ?? null
  });

  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: requiredEnv.S3_BUCKET,
      Key: key
    }));
    logger.info('Cleaned up diagnostic object', { key });
  } catch (cleanupError) {
    logger.warn('Failed to delete diagnostic object after upload', {
      key,
      error: serializeError(cleanupError)
    });
  }
};

const createMultipartSuiteKeys = objectKeyFromCli
  ? [objectKeyFromCli]
  : [
      'test-simple.mp4',
      'file_with_parentheses(1).mp4',
      'file with space.mp4',
      'file_with_plus+sign.mp4',
      'file_with_å_ø_æ.mp4',
      'nyhed_-_app_er_ude_og_events_er_i_gang_v1(1080p).mp4'
    ];

const runCreateMultipartSuite = async () => {
  logger.info('Starting CreateMultipartUpload diagnostics', {
    bucket: requiredEnv.S3_BUCKET,
    s3SdkVersion,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3EndpointHost,
    forcePathStyle,
    signingEscapePath,
    requestChecksumCalculation,
    responseChecksumValidation,
    isHetznerEndpoint: isHetzner,
    keysTested: createMultipartSuiteKeys.length
  });

  const results: Array<{
    key: string;
    createMultipartUploadStatus: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  }> = [];

  for (const key of createMultipartSuiteKeys) {
    const suiteResult = {
      key,
      createMultipartUploadStatus: null as number | null,
      errorCode: null as string | null,
      errorMessage: null as string | null
    };

    try {
      const response = await s3Client.send(new CreateMultipartUploadCommand({
        Bucket: requiredEnv.S3_BUCKET,
        Key: key
      }));

      suiteResult.createMultipartUploadStatus = response?.$metadata?.httpStatusCode ?? null;

      if (response?.UploadId) {
        try {
          await s3Client.send(new AbortMultipartUploadCommand({
            Bucket: requiredEnv.S3_BUCKET,
            Key: key,
            UploadId: response.UploadId
          }));
        } catch (abortError) {
          logger.warn('Failed to abort diagnostic multipart upload', {
            key,
            uploadId: response.UploadId,
            error: serializeError(abortError)
          });
        }
      }
    } catch (error) {
      const serialized = serializeError(error);
      const httpStatus =
        ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ??
          (error as { statusCode?: number })?.statusCode ??
          null);
      suiteResult.createMultipartUploadStatus = httpStatus;
      suiteResult.errorCode = (serialized.code as string | undefined) || (serialized.name as string | undefined) || null;
      suiteResult.errorMessage = typeof serialized.message === 'string' ? serialized.message : null;

      logger.error('CreateMultipartUpload diagnostic failed', {
        key,
        error: serialized
      });
    }

    results.push(suiteResult);
    console.log(JSON.stringify(suiteResult));
  }

  const hasFailure = results.some((result) => result.createMultipartUploadStatus !== 200);
  return { results, success: !hasFailure };
};

const run = async () => {
  if (runKeySuite) {
    const suiteOutcome = await runCreateMultipartSuite();
    return suiteOutcome.success;
  }

  const key = objectKeyFromCli ?? randomKey();

  try {
    await runMultipartUploadDiagnostic(key);
    return true;
  } catch (error) {
    logger.error('Multipart diagnostic upload failed', {
      key,
      error: serializeError(error)
    });
    return false;
  }
};

run()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logger.error('Unexpected multipart diagnostic failure', { error: serializeError(error) });
    process.exit(1);
  });
