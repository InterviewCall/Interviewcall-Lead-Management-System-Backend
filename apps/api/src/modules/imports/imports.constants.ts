export const IMPORTS_QUEUE = 'imports';

/** How many rows one pass of the importer takes from the database. Small enough that the progress bar moves about once a second. */
export const IMPORT_CHUNK_SIZE = 50;

/** After this many unexpected failures in a row the job stops and is retried, instead of marking every row an error. */
export const MAX_CONSECUTIVE_ROW_FAILURES = 5;

/** The most issues one dry run returns; the full list is in the report. */
export const DRY_RUN_ISSUE_LIMIT = 500;
