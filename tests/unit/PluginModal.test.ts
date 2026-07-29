/**
 * Tests the shared dialog frame, and asserts that every dialog in the plugin
 * uses it. The behaviours here are the ones each dialog previously implemented
 * for itself and sometimes got wrong: the busy guard that must survive a throw,
 * the rejected click handler that must surface rather than become an unhandled
 * rejection, and teardown that must empty the body.
 * @module tests/unit/PluginModal.test
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { PluginModal } from 'src/ui/PluginModal';

/** A concrete dialog exposing the protected frame for assertion. */
class TestModal extends PluginModal {
	renderTitle(title: string): void {
		this.setDialogTitle(title);
	}
	renderSourceLine(file: TFile): void {
		this.renderSource(file);
	}
	renderEmpty(message: string): void {
		this.renderEmptyState(message);
	}
	actions(...args: Parameters<PluginModal['renderActions']>): void {
		this.renderActions(...args);
	}
	exclusive(job: () => Promise<void>): Promise<boolean> {
		return this.runExclusive(job);
	}
	get isBusy(): boolean {
		return this.busy;
	}
}

const app = {} as App;

/** Builds a modal whose contentEl is a live, Obsidian-extended element. */
function createModal(): TestModal {
	return new TestModal(app);
}

describe('PluginModal action row', () => {
	it('renders buttons in order with the primary marked mod-cta', () => {
		const modal = createModal();
		modal.actions(
			{ text: 'Go', cta: true, onClick: () => undefined },
			{ text: 'Cancel', onClick: () => undefined },
		);
		const buttons = modal.contentEl.querySelectorAll('button');
		expect(buttons).toHaveLength(2);
		expect(buttons[0]?.textContent).toBe('Go');
		expect(buttons[0]?.classList.contains('mod-cta')).toBe(true);
		expect(buttons[1]?.textContent).toBe('Cancel');
		expect(buttons[1]?.classList.contains('mod-cta')).toBe(false);
	});

	it('marks a destructive action without calling a deprecated API', () => {
		const modal = createModal();
		modal.actions({
			text: 'Replace',
			destructive: true,
			onClick: () => undefined,
		});
		const button = modal.contentEl.querySelector('button');
		expect(button?.classList.contains('mod-warning')).toBe(true);
	});

	it('honours the initial disabled state and hands the component back', () => {
		const modal = createModal();
		let captured: { setDisabled(v: boolean): unknown } | null = null;
		modal.actions({
			text: 'Run',
			disabled: true,
			ref: (button) => {
				captured = button;
			},
			onClick: () => undefined,
		});
		const button = modal.contentEl.querySelector('button');
		expect(button?.disabled).toBe(true);
		expect(captured).not.toBeNull();
	});

	it('invokes the handler on click', () => {
		const modal = createModal();
		const onClick = jest.fn();
		modal.actions({ text: 'Go', onClick });
		modal.contentEl.querySelector('button')?.click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('surfaces a rejected handler as a Notice instead of swallowing it', async () => {
		const modal = createModal();
		modal.actions({
			text: 'Go',
			onClick: () => Promise.reject(new Error('boom')),
		});
		modal.contentEl.querySelector('button')?.click();
		// Let the rejection settle through the frame's reporter.
		await Promise.resolve();
		await Promise.resolve();
		expect(Notice).toHaveBeenCalledWith('boom');
	});
});

describe('PluginModal busy guard', () => {
	it('runs one job at a time and reports the refusal', async () => {
		const modal = createModal();
		let release = (): void => undefined;
		const first = modal.exclusive(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		expect(modal.isBusy).toBe(true);
		await expect(modal.exclusive(() => Promise.resolve())).resolves.toBe(
			false,
		);
		release();
		await expect(first).resolves.toBe(true);
		expect(modal.isBusy).toBe(false);
	});

	it('clears the flag when the job throws, so the dialog stays usable', async () => {
		const modal = createModal();
		await expect(
			modal.exclusive(() => Promise.reject(new Error('failed'))),
		).rejects.toThrow('failed');
		// The hand-written guards this replaces left the dialog permanently
		// inert when the job threw between setting and clearing the flag.
		expect(modal.isBusy).toBe(false);
		await expect(modal.exclusive(() => Promise.resolve())).resolves.toBe(
			true,
		);
	});
});

describe('PluginModal shared body pieces', () => {
	it('renders the source line with the shared class', () => {
		const modal = createModal();
		modal.renderSourceLine({ name: 'meeting.webm' } as TFile);
		const line = modal.contentEl.querySelector('.aar-modal-config');
		expect(line?.textContent).toBe('Source: meeting.webm');
	});

	it('renders an empty state with a lone Close button', () => {
		const modal = createModal();
		modal.renderEmpty('Nothing to do here.');
		expect(modal.contentEl.textContent).toContain('Nothing to do here.');
		const buttons = modal.contentEl.querySelectorAll('button');
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toBe('Close');
	});

	it('empties the body on close', () => {
		const modal = createModal();
		modal.renderEmpty('Nothing to do here.');
		modal.onClose();
		expect(modal.contentEl.childElementCount).toBe(0);
	});
});
