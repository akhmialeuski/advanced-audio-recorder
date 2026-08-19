/**
 * Contract tests for the Menu double.
 *
 * The previous mock handed a MenuItem to the builder and threw everything it
 * was told away, including the click handler, so no test could pick an entry
 * from a menu the code under test had built. Every menu test shadowed the whole
 * obsidian module to get around it.
 * @module tests/unit/mocks/obsidianMenu.test
 */

// Imported from the mock by path: items, click, and separatorsAfter are the
// mock's own contract, not part of the real Menu API.
import { Menu } from '../../mocks/obsidian';

describe('Menu', () => {
	it('keeps the items the builder added, in order', () => {
		const menu = new Menu();

		menu.addItem((item) => item.setTitle('First'));
		menu.addItem((item) => item.setTitle('Second'));

		expect(menu.items.map((item) => item.title)).toEqual([
			'First',
			'Second',
		]);
	});

	it('runs the handler when an entry is picked by title', () => {
		const menu = new Menu();
		const onClick = jest.fn();
		menu.addItem((item) => item.setTitle('Rename').onClick(onClick));

		menu.click('Rename');

		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('names the entries it does have when asked for one it does not', () => {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle('Rename'));

		expect(() => {
			menu.click('Delete');
		}).toThrow('Menu has no item "Delete". Available: Rename');
	});

	it('says the menu is empty rather than listing nothing', () => {
		const menu = new Menu();

		expect(() => {
			menu.click('Rename');
		}).toThrow('Available: (none)');
	});

	it('refuses to pick a disabled entry', () => {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle('Rename').setDisabled(true).onClick(jest.fn()),
		);

		expect(() => {
			menu.click('Rename');
		}).toThrow('Menu item "Rename" is disabled');
	});

	it('refuses to pick an entry with no handler', () => {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle('Heading'));

		expect(() => {
			menu.click('Heading');
		}).toThrow('Menu item "Heading" has no click handler');
	});

	it('records the builder values the production code sets', () => {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle('Rename')
				.setIcon('pencil')
				.setSection('edit')
				.setChecked(true)
				.onClick(jest.fn()),
		);

		const [item] = menu.items;
		expect(item).toMatchObject({
			title: 'Rename',
			icon: 'pencil',
			section: 'edit',
			checked: true,
			disabled: false,
		});
	});

	it('reads a DocumentFragment title as its text', () => {
		const menu = new Menu();
		const fragment = document.createDocumentFragment();
		fragment.append(document.createTextNode('Fragment title'));

		menu.addItem((item) => item.setTitle(fragment));

		expect(menu.items[0]?.title).toBe('Fragment title');
	});

	it('leaves the icon empty when it is cleared with null', () => {
		const menu = new Menu();

		menu.addItem((item) => item.setTitle('Plain').setIcon(null));

		expect(menu.items[0]?.icon).toBe('');
	});

	it('leaves checked false when it is cleared with null', () => {
		const menu = new Menu();

		menu.addItem((item) => item.setTitle('Plain').setChecked(null));

		expect(menu.items[0]?.checked).toBe(false);
	});

	it('records where separators fall', () => {
		const menu = new Menu();

		menu.addItem((item) => item.setTitle('First'));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Second'));

		expect(menu.separatorsAfter).toEqual([0]);
	});

	it('finds an entry without picking it', () => {
		const menu = new Menu();
		const onClick = jest.fn();
		menu.addItem((item) => item.setTitle('Rename').onClick(onClick));

		expect(menu.item('Rename')?.title).toBe('Rename');
		expect(menu.item('Missing')).toBeUndefined();
		expect(onClick).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: 'showAtMouseEvent',
			show: (menu: Menu): void => {
				menu.showAtMouseEvent(new MouseEvent('contextmenu'));
			},
		},
		{
			name: 'showAtPosition',
			show: (menu: Menu): void => {
				menu.showAtPosition({ x: 0, y: 0 });
			},
		},
	])('records that $name displayed it', ({ show }) => {
		const menu = new Menu();

		expect(menu.shown).toBe(false);
		show(menu);
		expect(menu.shown).toBe(true);
	});

	it('records the position it was opened at', () => {
		const menu = new Menu();

		menu.showAtPosition({ x: 12, y: 34 });

		expect(menu.shownAtPosition).toEqual({ x: 12, y: 34 });
		expect(menu.shownAtEvent).toBeNull();
	});

	it('records the event it was opened from', () => {
		const menu = new Menu();
		const event = new MouseEvent('contextmenu');

		menu.showAtMouseEvent(event);

		expect(menu.shownAtEvent).toBe(event);
		expect(menu.shownAtPosition).toBeNull();
	});

	it('passes the event through to the handler', () => {
		const menu = new Menu();
		const onClick = jest.fn();
		menu.addItem((item) => item.setTitle('Rename').onClick(onClick));
		const event = new MouseEvent('click');

		menu.items[0]?.click(event);

		expect(onClick).toHaveBeenCalledWith(event);
	});
});
