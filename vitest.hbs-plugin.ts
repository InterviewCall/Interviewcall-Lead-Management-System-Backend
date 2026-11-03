import type { Plugin } from 'vite';

/** Lets tests import a .hbs file as its source text, the way the rspack build does. */
export function hbsAsText(): Plugin {
    return {
        name: 'hbs-as-text',
        enforce: 'pre',
        transform(code, id) {
            if (!id.split('?')[0].endsWith('.hbs')) {
                return null;
            }
            return {
                code: `export default ${JSON.stringify(code)};`,
                map: null,
            };
        },
    };
}
