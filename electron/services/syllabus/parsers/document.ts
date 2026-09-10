/**
 * PDF and DOCX text extraction.
 *
 * Both libraries are loaded lazily and treated as optional: if a dependency is
 * missing or fails on the current runtime, the caller gets a clear error and can
 * fall back to pasting the text (which then goes through the LLM extractor).
 *
 * `pdfjs-dist` is used rather than `pdf-parse` because pdf-parse v1 pins an
 * ancient pdf.js build that does not run reliably on modern Node.
 */

export interface ExtractedText {
  text: string;
  pages?: number;
  error?: string;
}

export async function extractPdfText(bytes: Uint8Array | Buffer): Promise<ExtractedText> {
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> };
    };

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      // Text extraction only — never evaluate embedded JS or fetch system fonts.
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;

    const chunks: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) chunks.push(line);
    }

    const text = chunks.join("\n\n");
    if (!text.trim()) {
      return { text: "", pages: doc.numPages, error: "The PDF contains no extractable text (is it a scan?)." };
    }
    return { text, pages: doc.numPages };
  } catch (err) {
    return {
      text: "",
      error: `PDF extraction failed (${describe(err)}). Paste the outline instead — the LLM extractor handles plain text.`,
    };
  }
}

export async function extractDocxText(bytes: Uint8Array | Buffer): Promise<ExtractedText> {
  try {
    const mammoth = (await import("mammoth")) as unknown as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = result.value ?? "";
    if (!text.trim()) return { text: "", error: "The DOCX contains no extractable text." };
    return { text };
  } catch (err) {
    return {
      text: "",
      error: `DOCX extraction failed (${describe(err)}). Paste the outline instead.`,
    };
  }
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
  }>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
