import {
    CSV_LIMITS,
    CsvError,
    csvCell,
    csvLine,
    decodeCsvBytes,
    parseCsv,
} from './csv-parser.js';

describe('parseCsv', () => {
    it('reads headers and rows with their line numbers', () => {
        const parsed = parseCsv('Name,Email\nRavi,r@x.com\nAsha,a@x.com\n');
        expect(parsed.headers).toEqual(['Name', 'Email']);
        expect(parsed.rows).toEqual([
            { line: 2, cells: ['Ravi', 'r@x.com'] },
            { line: 3, cells: ['Asha', 'a@x.com'] },
        ]);
    });

    it('handles quoted cells with commas, doubled quotes and line breaks', () => {
        const parsed = parseCsv('Name,Note\n"Rao, Ravi","said ""hi""\nthen left"\nAsha,ok\n');
        expect(parsed.rows[0].cells).toEqual(['Rao, Ravi', 'said "hi"\nthen left']);
        // The next row starts on line 4 because the quoted cell spans two lines.
        expect(parsed.rows[1]).toEqual({ line: 4, cells: ['Asha', 'ok'] });
    });

    it('accepts Windows and old Mac line endings and a missing final newline', () => {
        expect(parseCsv('A,B\r\n1,2\r\n3,4').rows).toHaveLength(2);
        expect(parseCsv('A,B\r1,2\r3,4\r').rows).toHaveLength(2);
    });

    it('skips blank lines but keeps the real line numbers', () => {
        const parsed = parseCsv('A,B\n\n1,2\n,\n3,4\n');
        expect(parsed.rows.map((r) => r.line)).toEqual([3, 5]);
    });

    it('pads short rows and drops cells past the last header', () => {
        const parsed = parseCsv('A,B,C\n1\n1,2,3,4,5\n');
        expect(parsed.rows[0].cells).toEqual(['1', '', '']);
        expect(parsed.rows[1].cells).toEqual(['1', '2', '3']);
    });

    it('detects semicolon, tab and pipe delimiters', () => {
        expect(parseCsv('A;B\n1;2\n').headers).toEqual(['A', 'B']);
        expect(parseCsv('A\tB\n1\t2\n').delimiter).toBe('\t');
        expect(parseCsv('A|B\n1|2\n').delimiter).toBe('|');
    });

    it('does not count delimiters inside quotes when sniffing', () => {
        const parsed = parseCsv('"A;B;C;D",E\n1,2\n');
        expect(parsed.delimiter).toBe(',');
        expect(parsed.headers).toEqual(['A;B;C;D', 'E']);
    });

    it('names empty headers and numbers repeated ones', () => {
        const parsed = parseCsv('Phone,,Phone,phone\n1,2,3,4\n');
        expect(parsed.headers).toEqual(['Phone', 'Column 2', 'Phone (2)', 'phone (3)']);
    });

    it('trims cells and removes NUL characters', () => {
        const parsed = parseCsv('A,B\n  x  ,y\u0000z\n');
        expect(parsed.rows[0].cells).toEqual(['x', 'yz']);
    });

    it('undoes the spreadsheet formula guard so exported files can be re-uploaded', () => {
        const parsed = parseCsv("Phone,Name\n'+919876543210,'=cmd\n");
        expect(parsed.rows[0].cells).toEqual(['+919876543210', '=cmd']);
        // An ordinary apostrophe is left alone.
        expect(parseCsv("A\n'tis\n").rows[0].cells).toEqual(["'tis"]);
    });

    it('treats a quote in the middle of an unquoted cell as an ordinary character', () => {
        expect(parseCsv('A,B\n5" nail,x\n').rows[0].cells).toEqual(['5" nail', 'x']);
    });

    it('cuts off absurdly long cells', () => {
        const parsed = parseCsv(`A\n${'x'.repeat(CSV_LIMITS.maxCellLength + 50)}\n`);
        expect(parsed.rows[0].cells[0]).toHaveLength(CSV_LIMITS.maxCellLength);
    });

    it.each([
        ['', 'EMPTY'],
        ['   \n\n', 'EMPTY'],
        ['Name,Email\n', 'NO_ROWS'],
        ['Name,Email\n,\n', 'NO_ROWS'],
        ['A,B\n"never closed,2\n', 'UNTERMINATED_QUOTE'],
    ])('rejects %j as %s', (text, code) => {
        expect(() => parseCsv(text)).toThrowError(CsvError);
        try {
            parseCsv(text);
        } catch (error) {
            expect((error as CsvError).code).toBe(code);
        }
    });

    it('names the line where an unclosed quote starts, even after multi-line cells', () => {
        const text = 'A,B\n"two\nlines",1\nok,2\n3,"never closed\nmore\n';
        expect(() => parseCsv(text)).toThrowError(/starts on line 5 /);
    });

    it('keeps a stray quote after a closing quote as plain text instead of failing the file', () => {
        const parsed = parseCsv('A,B\n"abc"def,2\n');
        expect(parsed.rows[0].cells).toEqual(['"abc"def', '2']);
    });

    it('reads a 25,000 row file quickly', () => {
        const body = Array.from({ length: CSV_LIMITS.maxRows }, (_, i) => `Lead ${i},lead${i}@x.com,+9198${String(10000000 + i)}`).join('\n');
        const started = Date.now();
        const parsed = parseCsv(`Name,Email,Phone\n${body}\n`);
        expect(parsed.rows).toHaveLength(CSV_LIMITS.maxRows);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('rejects too many rows and too many columns', () => {
        const rows = Array.from({ length: CSV_LIMITS.maxRows + 1 }, (_, i) => `n${i}`).join('\n');
        expect(() => parseCsv(`Name\n${rows}\n`)).toThrow(/at most 25,000/);
        const wide = Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',');
        expect(() => parseCsv(`${wide}\n1\n`)).toThrow(/more than 100 columns/);
    });

    it('accepts exactly the maximum number of rows', () => {
        const rows = Array.from({ length: CSV_LIMITS.maxRows }, (_, i) => `n${i}`).join('\n');
        expect(parseCsv(`Name\n${rows}\n`).rows).toHaveLength(CSV_LIMITS.maxRows);
    });
});

describe('decodeCsvBytes', () => {
    it('drops a UTF-8 byte order mark', () => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('Name\n')]);
        expect(decodeCsvBytes(bytes)).toBe('Name\n');
    });

    it('reads UTF-8 text', () => {
        expect(decodeCsvBytes(Buffer.from('Zoë,Éric', 'utf8'))).toBe('Zoë,Éric');
    });

    it('falls back to Windows-1252 for files saved by Excel', () => {
        // "José" in Windows-1252: the é is a single byte 0xE9, which is not valid UTF-8.
        const bytes = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]);
        expect(decodeCsvBytes(bytes)).toBe('José');
    });
});

describe('csvCell', () => {
    it('quotes cells that need it', () => {
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('two\nlines')).toBe('"two\nlines"');
        expect(csvCell('plain')).toBe('plain');
    });

    it('guards against spreadsheet formulas', () => {
        expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
        expect(csvCell('+919876543210')).toBe("'+919876543210");
        expect(csvCell('-5')).toBe("'-5");
        expect(csvCell('@user')).toBe("'@user");
    });

    it('writes a full line', () => {
        expect(csvLine(['a', 'b,c', '=x'])).toBe(`a,"b,c",'=x`);
    });

    it('round-trips through the parser', () => {
        const cells = ['Rao, Ravi', '+919876543210', 'he said "yes"', '=HYPERLINK()'];
        const text = `${csvLine(['A', 'B', 'C', 'D'])}\n${csvLine(cells)}\n`;
        expect(parseCsv(text).rows[0].cells).toEqual(cells);
    });
});
