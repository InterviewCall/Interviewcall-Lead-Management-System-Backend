import { CsvError as CsvParseError, parse as parseRecords } from 'csv-parse/sync';

/** Limits that keep one upload from using up the server. */
export const CSV_LIMITS = {
    maxRows: 25_000,
    maxColumns: 100,
    maxFileBytes: 10 * 1024 * 1024,
    /** A single cell longer than this is cut off; no lead field is anywhere near it. */
    maxCellLength: 2_000,
} as const;

export type CsvErrorCode =
    | 'EMPTY'
    | 'NO_ROWS'
    | 'TOO_MANY_ROWS'
    | 'TOO_MANY_COLUMNS'
    | 'UNTERMINATED_QUOTE'
    | 'MALFORMED';

/** A file that cannot be imported at all. The message is safe to show to the person who uploaded it. */
export class CsvError extends Error {
    constructor(
        readonly code: CsvErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'CsvError';
    }
}

export interface CsvRow {
    /** The line in the file where the row starts (1 is the header), so people can find it in Excel. */
    line: number;
    cells: string[];
}

export interface ParsedCsv {
    headers: string[];
    rows: CsvRow[];
    delimiter: string;
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Bytes to text. UTF-8 first (a byte order mark is dropped). A file that is not valid UTF-8 is
 * almost always Excel's "CSV" save in Windows-1252, so it is read that way instead of being
 * turned into question marks.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
    let start = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        start = 3;
    }
    const body = bytes.subarray(start);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
        return new TextDecoder('windows-1252').decode(body);
    }
}

/** Picks the delimiter that appears most on the header line, outside quotes. Comma wins ties. */
function sniffDelimiter(text: string): string {
    const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
            break;
        } else if (!inQuotes && counts.has(ch)) {
            counts.set(ch, (counts.get(ch) ?? 0) + 1);
        }
    }
    let best: string = ',';
    let bestCount = counts.get(',') ?? 0;
    for (const d of DELIMITERS) {
        const count = counts.get(d) ?? 0;
        if (count > bestCount) {
            best = d;
            bestCount = count;
        }
    }
    return best;
}

/**
 * A cell that starts with = + - or @ is dangerous in a spreadsheet, so exported files prefix it
 * with an apostrophe. Taking that apostrophe off again means a downloaded report can be fixed
 * and uploaded without the phone numbers (+91...) changing.
 */
function cleanCell(raw: string): string {
    let value = raw.replace(/\0/g, '');
    if (value.length > CSV_LIMITS.maxCellLength) {
        value = value.slice(0, CSV_LIMITS.maxCellLength);
    }
    if (value.length > 1 && value[0] === "'" && '=+-@'.includes(value[1])) {
        value = value.slice(1);
    }
    return value.trim();
}

/**
 * Splits text into records with csv-parse (RFC 4180: quoted cells may hold delimiters, quotes ("") and line breaks).
 * `relax_quotes` keeps a stray quote inside an unquoted cell (5" screen) as ordinary text, and
 * `relax_column_count` lets short and long rows through so they can be padded and trimmed below.
 */
function splitRecords(text: string, delimiter: string): CsvRow[] {
    // csv-parse reports the line a record ends on. A record starts on the line after the previous one ended.
    const rows: CsvRow[] = [];
    let lastEnd = 0;
    try {
        parseRecords(text, {
            delimiter,
            relax_quotes: true,
            relax_column_count: true,
            skip_empty_lines: false,
            bom: false,
            trim: false,
            on_record: (record: string[], context: { lines: number }) => {
                rows.push({ line: lastEnd + 1, cells: record });
                lastEnd = context.lines;
                return null;
            },
        });
        return rows;
    } catch (error) {
        if (error instanceof CsvParseError && error.code === 'CSV_QUOTE_NOT_CLOSED') {
            // The unfinished record starts right after the last record that did finish.
            throw new CsvError(
                'UNTERMINATED_QUOTE',
                `A quoted value that starts on line ${lastEnd + 1} is never closed. Check the file for a stray " character.`,
            );
        }
        throw new CsvError('MALFORMED', 'The file could not be read as a CSV. Save it as CSV (comma delimited) and try again.');
    }
}

/** Header names: never empty, never repeated, so every column can be told apart. */
function cleanHeaders(raw: string[]): string[] {
    const seen = new Map<string, number>();
    return raw.map((header, index) => {
        const base = header === '' ? `Column ${index + 1}` : header;
        const key = base.toLowerCase();
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        return count === 1 ? base : `${base} (${count})`;
    });
}

const isBlank = (cells: string[]) => cells.every((c) => c === '');

export function parseCsv(text: string): ParsedCsv {
    if (text.trim() === '') {
        throw new CsvError('EMPTY', 'The file is empty.');
    }
    const delimiter = sniffDelimiter(text);
    const records = splitRecords(text, delimiter)
        .map((r) => ({ line: r.line, cells: r.cells.map(cleanCell) }))
        .filter((r) => !isBlank(r.cells));

    const [headerRecord, ...dataRecords] = records;
    if (!headerRecord) {
        throw new CsvError('EMPTY', 'The file is empty.');
    }
    if (headerRecord.cells.length > CSV_LIMITS.maxColumns) {
        throw new CsvError(
            'TOO_MANY_COLUMNS',
            `The file has more than ${CSV_LIMITS.maxColumns} columns.`,
        );
    }
    if (dataRecords.length === 0) {
        throw new CsvError(
            'NO_ROWS',
            'The file has a header row but no leads under it.',
        );
    }
    if (dataRecords.length > CSV_LIMITS.maxRows) {
        throw new CsvError(
            'TOO_MANY_ROWS',
            `The file has ${dataRecords.length.toLocaleString('en-IN')} rows; one import can hold at most ${CSV_LIMITS.maxRows.toLocaleString('en-IN')}. Split it into smaller files.`,
        );
    }

    const width = headerRecord.cells.length;
    const rows = dataRecords.map((r) => ({
        line: r.line,
        // Short rows are padded; cells past the last header have no column to map to, so they are dropped.
        cells:
            r.cells.length >= width
                ? r.cells.slice(0, width)
                : [...r.cells, ...Array<string>(width - r.cells.length).fill('')],
    }));
    return { headers: cleanHeaders(headerRecord.cells), rows, delimiter };
}

/** Writes one cell for a CSV file, with the spreadsheet formula guard. */
export function csvCell(value: string): string {
    let text = value;
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: string[]): string {
    return values.map(csvCell).join(',');
}
