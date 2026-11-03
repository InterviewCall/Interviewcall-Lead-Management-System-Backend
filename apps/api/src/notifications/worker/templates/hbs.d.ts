/** A .hbs file is imported as its source text. The build (rspack) and the tests (vitest) both do this. */
declare module '*.hbs' {
    const source: string;
    export default source;
}
