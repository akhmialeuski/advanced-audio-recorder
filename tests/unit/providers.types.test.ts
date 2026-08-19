/**
 * Type tests for the provider registry.
 *
 * The registry's whole point is that the id strings are derived rather than
 * typed twice: an engine's id, the account it is reached through, and the
 * transcription and LLM ids it is stored under all come from one declaration,
 * so a new engine cannot be half-added. That guarantee is a type-level one, so
 * this is where it is checked - `npm run typecheck` covers tests/, and a
 * widened id or a nullable that stops being nullable fails the build even
 * though every runtime test still passes.
 * @module tests/unit/providers.types.test
 */

import { expectTypeOf } from 'expect-type';
import {
	ACCOUNTS,
	ACCOUNT_IDS,
	ENGINES,
	ENGINE_IDS,
	ENGINE_ORDER,
	accountOf,
	accountTranscribes,
	engineAccess,
	engineOfTranscription,
	engineOfVendor,
	enginesOfAccount,
	vendorEngine,
} from 'src/providers/providers';
import type {
	AccountId,
	EngineAccess,
	EngineDescriptor,
	EngineId,
	ProviderConnection,
	ProviderModels,
} from 'src/providers/providers';

describe('the id types', () => {
	it('are the declared ids, not any string', () => {
		// A widened id would let a typo through the settings store and be
		// found only when a run failed to match any engine.
		expectTypeOf<EngineId>().toEqualTypeOf<
			| 'whisper-api'
			| 'openai-llm'
			| 'deepgram'
			| 'gemini'
			| 'anthropic'
			| 'local-whisper'
		>();
		expectTypeOf<AccountId>().toEqualTypeOf<
			'openai' | 'deepgram' | 'gemini' | 'anthropic'
		>();

		expect(Object.values(ENGINE_IDS)).toHaveLength(6);
		expect(Object.values(ACCOUNT_IDS)).toHaveLength(4);
	});

	it('key the registries exhaustively, so no engine can be half-added', () => {
		// Record<EngineId, ...> is what makes a new id a compile error until
		// its descriptor exists.
		expectTypeOf(ENGINES).toEqualTypeOf<
			Record<EngineId, EngineDescriptor>
		>();
		expectTypeOf(ACCOUNTS).toEqualTypeOf<
			Record<AccountId, ProviderConnection>
		>();
		expectTypeOf(ENGINE_ORDER).toEqualTypeOf<EngineId[]>();

		expect(ENGINE_ORDER).toHaveLength(Object.keys(ENGINES).length);
	});
});

describe('what an engine may lack', () => {
	it('says so in the type rather than leaving it to a runtime check', () => {
		// The local engine has no account and no catalogue; a non-nullable
		// field here would let every reader skip the check and crash on it.
		expectTypeOf<
			EngineDescriptor['account']
		>().toEqualTypeOf<AccountId | null>();
		expectTypeOf<
			EngineDescriptor['models']
		>().toEqualTypeOf<ProviderModels | null>();
		expectTypeOf<EngineDescriptor['uploadChunk']>().toBeNullable();
		expectTypeOf<EngineDescriptor['maxTokens']>().toBeNullable();

		expect(ENGINES['local-whisper'].account).toBeNull();
	});

	it('marks every descriptor field readonly, so the registry is not edited', () => {
		expectTypeOf<EngineDescriptor>().toEqualTypeOf<
			Readonly<EngineDescriptor>
		>();

		expect(Object.isFrozen(ENGINE_IDS)).toBe(false);
	});
});

describe('the lookups', () => {
	it('answer nothing findable rather than throwing, where an id may miss', () => {
		// A stored id can name an engine a later version removed.
		expectTypeOf(engineOfVendor).returns.toEqualTypeOf<
			EngineDescriptor | undefined
		>();
		expectTypeOf(engineOfTranscription).returns.toEqualTypeOf<
			EngineDescriptor | undefined
		>();

		expect(engineOfVendor('gemini')).toBeDefined();
	});

	it('answer a descriptor outright where the caller has already checked', () => {
		expectTypeOf(vendorEngine).returns.toEqualTypeOf<EngineDescriptor>();
		expectTypeOf(enginesOfAccount).returns.toEqualTypeOf<
			EngineDescriptor[]
		>();
		expectTypeOf(accountTranscribes).returns.toEqualTypeOf<boolean>();

		expect(vendorEngine('gemini').id).toBe('gemini');
	});

	it('narrow an engine to the pair a networked one always has', () => {
		// engineAccess is the one place that turns "an engine" into "an
		// engine with an endpoint and a catalogue", so its result must carry
		// both without nulls or every caller re-checks.
		expectTypeOf(engineAccess).returns.toEqualTypeOf<EngineAccess>();
		expectTypeOf<
			EngineAccess['account']
		>().toEqualTypeOf<ProviderConnection>();
		expectTypeOf<EngineAccess['models']>().toEqualTypeOf<ProviderModels>();

		expect(engineAccess('gemini').models).toBeDefined();
	});

	it('keeps accountOf optional, since the local engine has none', () => {
		expectTypeOf(accountOf).returns.toEqualTypeOf<
			ProviderConnection | undefined
		>();

		expect(accountOf(ENGINES['local-whisper'])).toBeUndefined();
	});
});
