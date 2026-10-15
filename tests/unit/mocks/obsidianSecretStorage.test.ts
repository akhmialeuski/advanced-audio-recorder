/**
 * Contract tests for the keychain double in the obsidian mock.
 *
 * The plugin's key handling is tested against this double, so the rules it
 * copies from the app - which IDs are accepted, what an unknown ID answers,
 * and that every write and deletion is announced - are pinned down here.
 * @module tests/unit/mocks/obsidianSecretStorage.test
 */

// Imported from the mock by path: deleteSecret and validateId are internal API
// of the real app and absent from the typings.
import {
	App,
	SECRET_ID_INVALID_MESSAGE,
	SecretStorage,
} from '../../mocks/obsidian';

describe('SecretStorage', () => {
	it('returns a stored secret by its ID', () => {
		const storage = new SecretStorage();
		storage.setSecret('openai-api-key', 'sk-1');

		const value = storage.getSecret('openai-api-key');

		expect(value).toBe('sk-1');
	});

	it('answers null for an ID nothing is stored under', () => {
		const storage = new SecretStorage();

		expect(storage.getSecret('missing')).toBeNull();
	});

	it('replaces the value stored under an existing ID', () => {
		const storage = new SecretStorage();
		storage.setSecret('openai-api-key', 'sk-1');

		storage.setSecret('openai-api-key', 'sk-2');

		expect(storage.getSecret('openai-api-key')).toBe('sk-2');
	});

	it('lists the ID of every stored secret', () => {
		const storage = new SecretStorage();
		storage.setSecret('a', '1');
		storage.setSecret('b-2', '2');

		expect(storage.listSecrets()).toEqual(['a', 'b-2']);
	});

	it.each([
		{ name: 'an upper-case letter', id: 'OpenAI' },
		{ name: 'a space', id: 'open ai' },
		{ name: 'an underscore', id: 'open_ai' },
		{ name: 'nothing at all', id: '' },
		{ name: 'more than 64 characters', id: 'a'.repeat(65) },
	])('refuses an ID holding $name, as the app does', ({ id }) => {
		const storage = new SecretStorage();

		expect(() => {
			storage.setSecret(id, 'value');
		}).toThrow(SECRET_ID_INVALID_MESSAGE);
	});

	it('accepts an ID of exactly 64 characters', () => {
		const storage = new SecretStorage();
		const id = 'a'.repeat(64);

		storage.setSecret(id, 'value');

		expect(storage.getSecret(id)).toBe('value');
	});

	it('announces a write to its listeners', () => {
		const storage = new SecretStorage();
		const changed = jest.fn();
		storage.on('changed', changed);

		storage.setSecret('openai-api-key', 'sk-1');

		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('announces nothing for a refused write', () => {
		const storage = new SecretStorage();
		const changed = jest.fn();
		storage.on('changed', changed);

		expect(() => {
			storage.setSecret('Bad ID', 'value');
		}).toThrow(SECRET_ID_INVALID_MESSAGE);
		expect(changed).not.toHaveBeenCalled();
	});

	it('removes a secret and announces the deletion', () => {
		const storage = new SecretStorage();
		storage.setSecret('openai-api-key', 'sk-1');
		const changed = jest.fn();
		storage.on('changed', changed);

		const removed = storage.deleteSecret('openai-api-key');

		expect(removed).toBe(true);
		expect(storage.getSecret('openai-api-key')).toBeNull();
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('reports a deletion of an unknown ID without announcing one', () => {
		const storage = new SecretStorage();
		const changed = jest.fn();
		storage.on('changed', changed);

		expect(storage.deleteSecret('missing')).toBe(false);
		expect(changed).not.toHaveBeenCalled();
	});

	it('is part of every app, empty, as on a device nothing was entered on', () => {
		const app = new App();

		expect(app.secretStorage.listSecrets()).toEqual([]);
	});
});
