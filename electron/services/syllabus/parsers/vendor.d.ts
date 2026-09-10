/**
 * Type shims for optional, lazily-imported document libraries.
 *
 * Both are loaded with a dynamic `import()` inside a try/catch so a missing or
 * broken dependency degrades to "paste the text instead" rather than breaking
 * the build.
 */

declare module "pdfjs-dist/legacy/build/pdf.mjs";

declare module "mammoth";
