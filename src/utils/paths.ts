/**
 * Vault-path helpers shared across features.
 * @module utils/paths
 */

/**
 * Returns the directory part of a vault-relative path, or '' for a
 * file at the vault root.
 * @param path - Vault-relative file path
 * @returns Directory path without the trailing slash
 */
export function directoryOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash) : '';
}

/**
 * Returns the file name of a vault-relative path, without its folders.
 * @param path - Vault-relative file path
 * @returns The last path segment
 */
export function fileNameOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}
