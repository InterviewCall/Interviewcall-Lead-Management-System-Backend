/**
 * Extends the Rspack config the Nest CLI generates.
 * Wired up in nest-cli.json -> compilerOptions.builder.options.configPath.
 *
 * The Nest CLI shallow-merges whatever this returns over its defaults, so this
 * exports a factory that receives those defaults and returns them with only the
 * `module.parser` branch replaced.
 */
module.exports = (config) => ({
  ...config,
  module: {
    ...config.module,
    parser: {
      ...config.module?.parser,
      javascript: {
        ...config.module?.parser?.javascript,
        // Prisma's ESM client sets `globalThis.__dirname` from `import.meta.url`.
        // Rspack 2.2 panics while rewriting `import.meta` ("should be a path: ()").
        // Output here is a real ES module, so leaving `import.meta` alone is both
        // safe and correct.
        importMeta: false,
      },
    },
  },
});
