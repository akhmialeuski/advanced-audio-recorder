import {
	normalizeCoreSyntax,
	offsetOf,
	parseErrorLocation,
	parseErrorMessage,
} from 'src/templates/templateSyntax';

describe('normalizeCoreSyntax', () => {
	it.each([
		['{{date:YYYY-MM-DD}}', '{{date format="YYYY-MM-DD"}}'],
		['{{ time : HH:mm }}', '{{time format="HH:mm"}}'],
		['{{date:[at] "x"}}', '{{date format="[at] \\"x\\""}}'],
		['{{date}} {{title}}', '{{date}} {{title}}'],
		['{{date format="x"}}', '{{date format="x"}}'],
	])('rewrites %s as %s', (source, expected) => {
		expect(normalizeCoreSyntax(source)).toBe(expected);
	});

	it('keeps every line where it was', () => {
		const source = 'a\n{{date:YYYY}}\nb';

		const lines = normalizeCoreSyntax(source).split('\n');

		expect(lines).toEqual(['a', '{{date format="YYYY"}}', 'b']);
	});
});

describe('parseErrorLocation', () => {
	it('reads the fields a mismatched block error carries', () => {
		const error = Object.assign(new Error('x'), {
			lineNumber: 4,
			column: 2,
		});

		expect(parseErrorLocation(error)).toEqual({ line: 4, column: 3 });
	});

	it('defaults the column when only the line is carried', () => {
		const error = Object.assign(new Error('x'), { lineNumber: 4 });

		expect(parseErrorLocation(error)).toEqual({ line: 4, column: 1 });
	});

	it('reads the caret of a grammar error', () => {
		const error = new Error(
			'Parse error on line 2:\nab{{x}\n----^\nExpecting CLOSE',
		);

		expect(parseErrorLocation(error)).toEqual({ line: 2, column: 5 });
	});

	it('answers nothing for an error without a location', () => {
		expect(parseErrorLocation('boom')).toBeUndefined();
	});

	it('answers nothing for a missing error', () => {
		expect(parseErrorLocation(undefined)).toBeUndefined();
	});
});

describe('parseErrorMessage', () => {
	it('keeps the expectation of a grammar error', () => {
		const error = new Error(
			"Parse error on line 2:\nab\n--^\nExpecting 'CLOSE', got 'EOF'",
		);

		expect(parseErrorMessage(error)).toBe("Expecting 'CLOSE', got 'EOF'");
	});

	it('drops the location suffix of a block error', () => {
		expect(
			parseErrorMessage(new Error("if doesn't match each - 2:3")),
		).toBe("if doesn't match each");
	});

	it('reads a thrown string', () => {
		expect(parseErrorMessage('plain')).toBe('plain');
	});
});

describe('offsetOf', () => {
	it('counts lines and the column within the last', () => {
		expect(offsetOf('ab\ncd\nef', 3, 1)).toBe(7);
	});

	it('answers the end for a line past the text', () => {
		expect(offsetOf('ab', 5, 0)).toBe(2);
	});
});
