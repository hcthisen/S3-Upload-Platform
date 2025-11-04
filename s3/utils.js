import semver from 'semver';
import s3PackageJson from '@aws-sdk/client-s3/package.json' assert { type: 'json' };

export const HETZNER_ENDPOINT_SUFFIX = '.your-objectstorage.com';
export const HETZNER_MIN_INCOMPATIBLE_VERSION = '3.729.0';
export const HETZNER_MAX_COMPATIBLE_VERSION = '3.726.1';
export const DEFAULT_REQUEST_CHECKSUM_CALCULATION = 'WHEN_REQUIRED';
export const DEFAULT_RESPONSE_CHECKSUM_VALIDATION = 'WHEN_REQUIRED';

export const resolveBucket = (env = process.env) => {
  const candidates = [
    env.S3_BUCKET,
    env.S3_BUCKET_NAME,
    env.BUCKET,
    env.BUCKET_NAME
  ];

  return candidates.find((value) => typeof value === 'string' && value.trim().length > 0) || '';
};

export const resolveRequestChecksumCalculation = (value) => {
  if (typeof value !== 'string') {
    return { value: DEFAULT_REQUEST_CHECKSUM_CALCULATION, invalidValue: null };
  }

  const normalized = value.trim().toUpperCase();
  const allowedValues = new Set(['WHEN_SUPPORTED', 'WHEN_REQUIRED']);
  if (allowedValues.has(normalized)) {
    return { value: normalized, invalidValue: null };
  }

  return { value: DEFAULT_REQUEST_CHECKSUM_CALCULATION, invalidValue: value };
};

export const resolveResponseChecksumValidation = (value) => {
  if (typeof value !== 'string') {
    return { value: DEFAULT_RESPONSE_CHECKSUM_VALIDATION, invalidValue: null };
  }

  const normalized = value.trim().toUpperCase();
  const allowedValues = new Set(['WHEN_REQUIRED', 'WHEN_SUPPORTED', 'NEVER']);
  if (allowedValues.has(normalized)) {
    return { value: normalized, invalidValue: null };
  }

  return { value: DEFAULT_RESPONSE_CHECKSUM_VALIDATION, invalidValue: value };
};

export const getEndpointHost = (endpoint) => {
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    return null;
  }

  try {
    const url = new URL(endpoint);
    return url.hostname;
  } catch (error) {
    return null;
  }
};

export const isHetznerEndpoint = (endpoint) => {
  const host = getEndpointHost(endpoint);
  return typeof host === 'string' ? host.endsWith(HETZNER_ENDPOINT_SUFFIX) : false;
};

export const getS3SdkVersion = () => s3PackageJson.version;

export const ensureHetznerCompatibleSdk = ({ endpoint, logger }) => {
  const version = getS3SdkVersion();
  const endpointHost = getEndpointHost(endpoint);
  const hetzner = endpointHost ? endpointHost.endsWith(HETZNER_ENDPOINT_SUFFIX) : false;

  if (hetzner && semver.gte(version, HETZNER_MIN_INCOMPATIBLE_VERSION)) {
    const message = 'Incompatible @aws-sdk/client-s3 version detected for Hetzner Object Storage';
    const meta = {
      endpointHost,
      s3SdkVersion: version,
      hetznerMaxSupportedVersion: HETZNER_MAX_COMPATIBLE_VERSION,
      documentation: 'https://docs.hetzner.com/storage/object-storage/troubleshooting/s3-compatible-clients/#aws-cli-and-aws-sdks'
    };

    if (logger && typeof logger.error === 'function') {
      logger.error(message, meta);
    } else {
      const serializedMeta = JSON.stringify(meta);
      console.error(`[ERROR] ${message}`, serializedMeta);
    }

    process.exit(1);
  }

  return { version, endpointHost, isHetzner: hetzner };
};

export const resolveForcePathStyle = (value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return { value: true, invalidValue: null };
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return { value: false, invalidValue: null };
    }

    return { value: false, invalidValue: value };
  }

  return { value: false, invalidValue: null };
};
