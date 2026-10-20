export type PdfTextRunner = (bytes: Uint8Array) => Promise<string>;

export async function extractPdfText(
  bytes: Uint8Array,
  command = "pdftotext",
): Promise<string> {
  if (bytes.byteLength === 0) throw new Error("PDF content is empty");
  const process = Bun.spawn([command, "-", "-"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(bytes);
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `PDF text extraction failed: ${stderr.trim().slice(0, 300)}`,
    );
  }
  return stdout;
}
