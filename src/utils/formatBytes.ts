/**
 * Small formatting helper for human-readable byte sizes.
 * @module utils/formatBytes
 */

/** Unit suffixes for {@link formatByteSize}. */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Formats a byte count as a human-readable string (e.g. "1.4 MB").
 * Negative or non-finite inputs render as "0 B".
 * @param bytes - Byte count
 * @returns Formatted size string
 */
export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const exponent = Math.min(
		BYTE_UNITS.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / Math.pow(1024, exponent);
	// Whole numbers for bytes; one decimal for larger units
	const formatted = exponent === 0 ? String(value) : value.toFixed(1);
	return `${formatted} ${BYTE_UNITS[exponent]}`;
}
