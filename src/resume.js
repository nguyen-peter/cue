// Extracts plain text from a resume/job-description file (PDF or DOCX) so it can be
// dropped into the existing Settings textareas. No OCR — text layer only.
const fs = require('fs');
const path = require('path');

async function parseDocumentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const res = await pdfParse(buf);
    return (res.text || '').trim();
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const res = await mammoth.extractRawText({ buffer: buf });
    return (res.value || '').trim();
  }
  if (ext === '.txt' || ext === '.md') {
    return buf.toString('utf8').trim();
  }
  if (ext === '.html' || ext === '.htm') {
    const rawHtml = buf.toString('utf8');
    return rawHtml
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\/(h[1-6]|p|li|tr|div|section|header)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;|&#8212;/g, '—')
      .replace(/&ndash;|&#8211;/g, '–')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  }
  throw new Error('Unsupported file type: ' + (ext || '(none)') + '. Use a PDF, DOCX, HTML, MD, or TXT file.');
}

module.exports = { parseDocumentFile };
