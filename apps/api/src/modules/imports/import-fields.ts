/**
 * The lead fields a CSV column can be mapped to. `custom` makes a new text field from the column,
 * `skip` leaves the column out.
 */
export const IMPORT_FIELDS = [
    {
        key: 'name',
        label: 'Full name',
        description: 'The whole name in one column.',
        synonyms: ['fullname', 'name', 'candidatename', 'leadname', 'studentname', 'contactname'],
    },
    {
        key: 'firstName',
        label: 'First name',
        description: 'Use with Last name when the name is split in two columns.',
        synonyms: ['firstname', 'fname', 'givenname'],
    },
    {
        key: 'lastName',
        label: 'Last name',
        description: 'Joined to the first name.',
        synonyms: ['lastname', 'lname', 'surname', 'familyname'],
    },
    {
        key: 'email',
        label: 'Email',
        description: 'Used to find people who are already leads.',
        synonyms: ['email', 'emailaddress', 'emailid', 'mail', 'workemail', 'personalemail'],
    },
    {
        key: 'phone',
        label: 'Phone',
        description: 'Used to find people who are already leads. Indian mobiles are read with or without +91.',
        synonyms: ['phone', 'mobile', 'mobilenumber', 'phonenumber', 'contact', 'contactnumber', 'whatsapp', 'whatsappnumber', 'cell'],
    },
    {
        key: 'company',
        label: 'Current company',
        description: 'Where the person works now.',
        synonyms: ['company', 'currentcompany', 'organisation', 'organization', 'employer', 'companyname'],
    },
    {
        key: 'ctc',
        label: 'CTC range',
        description: 'Kept as written, for example "10-15 LPA".',
        synonyms: ['ctc', 'ctclpa', 'currentctc', 'salary', 'ctcrange', 'salaryrange'],
    },
    {
        key: 'gradYear',
        label: 'Graduation year',
        description: 'A four-digit year.',
        synonyms: ['gradyear', 'graduationyear', 'passoutyear', 'yearofpassing', 'passingyear', 'batch'],
    },
    {
        key: 'domain',
        label: 'Current domain',
        description: 'The area the person works in, for example "Backend".',
        synonyms: ['domain', 'currentdomain', 'stack', 'skill', 'skills', 'techstack', 'function'],
    },
    {
        key: 'userType',
        label: 'Working professional or student',
        description: 'Words like "working professional" or "student".',
        synonyms: ['usertype', 'persona', 'profiletype', 'candidatetype'],
    },
    {
        key: 'leadScore',
        label: 'Lead score',
        description: 'The score the lead starts with, a whole number from 0 to 10,000. The CRM adds to it as the lead engages.',
        synonyms: ['leadscore', 'score', 'contactscore'],
    },
    {
        key: 'sourceDetail',
        label: 'Source details',
        description: 'Extra source information, such as a campaign. Kept with the lead\'s first touchpoint.',
        synonyms: ['utmsource', 'source', 'leadsource', 'channel', 'campaign', 'utmcampaign', 'sourcedetail'],
    },
] as const;

export type FieldKey = (typeof IMPORT_FIELDS)[number]['key'];
export type Target = FieldKey | 'custom' | 'skip';

export const FIELD_KEYS = IMPORT_FIELDS.map((f) => f.key) as [FieldKey, ...FieldKey[]];

/** One CSV column and what to do with it. `index` is the column's position in the file. */
export interface ColumnMapping {
    index: number;
    target: Target;
    /** For `custom`: the field's name. A field with this name is reused if it exists, made if not. */
    label?: string;
}

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Turns a field name into its stored key: "Current City!" becomes "current_city". */
export function customFieldKey(label: string): string {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50);
}

export interface KnownCustomField {
    key: string;
    label: string;
}

/**
 * A first guess for every column. A field is used at most once. A column that matches nothing is
 * left out rather than turned into a new field, so a messy file cannot fill the CRM with junk
 * fields; the person can still choose "New field" for it.
 */
export function suggestMapping(
    headers: string[],
    customFields: KnownCustomField[] = [],
): ColumnMapping[] {
    const used = new Set<FieldKey>();
    const nameMatched = headers.some((h) =>
        (IMPORT_FIELDS[0].synonyms as readonly string[]).includes(compact(h)),
    );
    return headers.map((header, index): ColumnMapping => {
        const n = compact(header);
        const field = IMPORT_FIELDS.find(
            (f) =>
                !used.has(f.key) &&
                (f.synonyms as readonly string[]).includes(n) &&
                // A file with a full-name column keeps first and last name out of the way.
                !(nameMatched && (f.key === 'firstName' || f.key === 'lastName')),
        );
        if (field) {
            used.add(field.key);
            return { index, target: field.key };
        }
        const existing = customFields.find(
            (c) => compact(c.label) === n || compact(c.key) === n,
        );
        if (existing) return { index, target: 'custom', label: existing.label };
        return { index, target: 'skip' };
    });
}

export interface MappingProblem {
    message: string;
}

/**
 * Checks a mapping against the file's columns. Returns the problems in plain words; an empty list
 * means the mapping can be used.
 */
export function validateMapping(
    columns: ColumnMapping[],
    columnCount: number,
): string[] {
    const problems: string[] = [];
    const seenIndex = new Set<number>();
    const seenTarget = new Set<string>();
    const seenCustom = new Set<string>();

    for (const column of columns) {
        if (column.index < 0 || column.index >= columnCount) {
            problems.push('A mapped column is not in the file.');
            continue;
        }
        if (seenIndex.has(column.index)) {
            problems.push('A column is mapped twice.');
            continue;
        }
        seenIndex.add(column.index);

        if (column.target === 'skip') continue;
        if (column.target === 'custom') {
            const label = (column.label ?? '').trim();
            const key = customFieldKey(label);
            if (label.length < 2 || key.length < 2) {
                problems.push('A new field needs a name of at least 2 letters or digits.');
            } else if (seenCustom.has(key)) {
                problems.push(`Two columns would make the field "${label}".`);
            } else if (IMPORT_FIELDS.some((f) => customFieldKey(f.label) === key)) {
                problems.push(`"${label}" is already a built-in field; map the column to it instead.`);
            }
            seenCustom.add(key);
            continue;
        }
        if (seenTarget.has(column.target)) {
            const label = IMPORT_FIELDS.find((f) => f.key === column.target)?.label ?? column.target;
            problems.push(`More than one column is mapped to ${label}.`);
        }
        seenTarget.add(column.target);
    }

    const hasName = seenTarget.has('name');
    const hasSplitName = seenTarget.has('firstName') || seenTarget.has('lastName');
    if (hasName && hasSplitName) {
        problems.push('Map either Full name or First name and Last name, not both.');
    } else if (!hasName && !seenTarget.has('firstName')) {
        problems.push('Map a column to Full name (or First name).');
    }
    if (!seenTarget.has('email') && !seenTarget.has('phone')) {
        problems.push('Map a column to Email or Phone. They are how duplicates are found.');
    }
    return problems;
}
