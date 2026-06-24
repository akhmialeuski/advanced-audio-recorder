/**
 * Small formatting helper for human-readable byte sizes. Shared by the
 * live recording stat (compact "1.4 MB") and the file-info modal
 * (precise "1.5 MB" / "500 Bytes"); the presentation differs via options
 * while the unit-selection math stays in one place.
 * @module utils/formatBytes
 */

/** Unit suffixes above bytes, in ascending order. */
const LARGE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

/** Highest supported exponent (bytes is exponent 0). */
const MAX_EXPONENT = LARGE_UNITS.length;

/** Default decimal places for units above bytes. */
const DEFAULT_DECIMALS = 1;

/** Options controlling how {@link formatByteSize} renders a size. */
export interface ByteSizeOptions {
	/** Decimal places for units above bytes (default 1). */
	decimals?: number;
	/** Strip trailing zeros from the decimal part (default false). */
	trimZeros?: boolean;
	/** Label for the bytes unit (default "B"). */
	bytesLabel?: string;
}

/**
 * Formats a byte count as a human-readable string (e.g. "1.4 MB").
 * Negative or non-finite inputs render as "0 <bytesLabel>".
 * @param bytes - Byte count
 * @param options - Presentation options
 * @returns Formatted size string
 */
export function formatByteSize(
	bytes: number,
	options: ByteSizeOptions = {},
): string {
	const {
		decimals = DEFAULT_DECIMALS,
		trimZeros = false,
		bytesLabel = 'B',
	} = options;
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return `0 ${bytesLabel}`;
	}
	const exponent = Math.min(
		MAX_EXPONENT,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const unit = exponent === 0 ? bytesLabel : LARGE_UNITS[exponent - 1];
	const value = bytes / Math.pow(1024, exponent);
	let formatted: string;
	if (exponent === 0) {
		// Whole numbers for bytes
		formatted = String(value);
	} else if (trimZeros) {
		formatted = String(parseFloat(value.toFixed(decimals)));
	} else {
		formatted = value.toFixed(decimals);
	}
	return `${formatted} ${unit}`;
}
