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

/**
 * Returns a file's own name without its folder or extension, the way
 * Obsidian's `TFile.basename` reads, for a path that has no TFile behind it.
 * A leading dot (`.env`) is part of the name, not an extension.
 * @param path - Vault-relative file path
 * @returns The file name with no directory and no extension
 */
export function fileStemOf(path: string): string {
	const name = fileNameOf(path);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}
