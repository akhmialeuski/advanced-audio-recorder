/**
 * The two well-known symbols explicit resource management keys on, for a
 * runtime that predates them (issue #164).
 *
 * The host here is a stand-in for a realm's Symbol, so a test can start from
 * a runtime with neither symbol, or with the one the audio engine adds, without
 * touching the suite's own.
 * @module tests/unit/disposeSymbols.test
 */

import { provideDisposeSymbols } from 'src/platform/disposeSymbols';

/** The shape provideDisposeSymbols fills in. */
interface Host {
	dispose?: symbol;
	asyncDispose?: symbol;
}

describe('provideDisposeSymbols', () => {
	it.each([
		{ name: 'dispose', key: 'dispose' },
		{ name: 'asyncDispose', key: 'asyncDispose' },
	] satisfies { name: string; key: keyof Host }[])(
		'gives a runtime without Symbol.$name the one esbuild falls back to',
		({ key }) => {
			const host: Host = {};

			provideDisposeSymbols(host);

			expect(host[key]).toBe(Symbol.for(`Symbol.${key}`));
		},
	);

	it('keeps the Symbol.dispose a runtime already has', () => {
		const own = Symbol('Symbol.dispose');
		const host: Host = { dispose: own };

		provideDisposeSymbols(host);

		expect(host.dispose).toBe(own);
	});

	it('adds Symbol.asyncDispose next to the Symbol.dispose the audio engine added', () => {
		const host: Host = { dispose: Symbol('Symbol.dispose') };

		provideDisposeSymbols(host);

		expect(host.asyncDispose).toBe(Symbol.for('Symbol.asyncDispose'));
	});

	it('fixes what it provides, so no later polyfill can move a key in use', () => {
		const host: Host = {};
		provideDisposeSymbols(host);

		expect(() => {
			host.asyncDispose = Symbol('Symbol.asyncDispose');
		}).toThrow(TypeError);
	});
});
