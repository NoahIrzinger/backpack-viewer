/**
 * Versioned extension API contract.
 *
 * Bumping the major version means breaking changes for installed
 * extensions — extensions declare which version they target in their
 * manifest and the loader rejects mismatches.
 */
export const VIEWER_API_VERSION = "1";
