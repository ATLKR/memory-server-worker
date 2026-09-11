/** Wrangler --define stamps these into the exact bundle built from the checked source/target. */
declare const BUILD_SOURCE_REVISION: string;
declare const BUILD_RESOURCE_FINGERPRINT: string;

// Direct Node imports and ad-hoc builds cannot claim a deployable source identity.
export const BUILD_REVISION = typeof BUILD_SOURCE_REVISION === 'string' ? BUILD_SOURCE_REVISION : 'unreleased';
export const BUILD_FINGERPRINT = typeof BUILD_RESOURCE_FINGERPRINT === 'string' ? BUILD_RESOURCE_FINGERPRINT : '';
