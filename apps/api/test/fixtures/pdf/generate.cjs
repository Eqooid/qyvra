// Small deterministic fixtures, with real xref offsets. No production dependency.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function pdf(pages, extra = '', image = false) {
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R ' + extra + ' >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < pages.length; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im0 ${4 + pages.length * 2} 0 R >>` : ''} >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const stream = pages[i];
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  if (image)
    objects.push(
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream',
    );
  let result = '%PDF-1.7\n',
    offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(result));
    result += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(
    result +
      `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
const text = (value) => `BT /F1 12 Tf 72 720 Td (${value}) Tj ET`;
for (const [name, content] of Object.entries({
  'single.pdf': pdf([text('Hello   Qyvra')]),
  'multi.pdf': pdf([text('First page'), '', text('Third page')]),
  'empty.pdf': pdf(['']),
  'graphics.pdf': pdf(['0 0 100 100 re f']),
  'image-only.pdf': pdf(['q 200 0 0 200 72 400 cm /Im0 Do Q'], '', true),
  'script.pdf': pdf(
    [text('Safe document')],
    '/OpenAction << /S /JavaScript /JS (app.alert\\(123\\)) >>',
  ),
  'malformed.pdf': Buffer.from('%PDF-1.7\nthis is not a PDF\n%%EOF\n'),
}))
  fs.writeFileSync(path.join(__dirname, name), content);
// Optional fixture regeneration; passwords are public fixture data, never runtime credentials.
if (process.argv[2]) {
  for (const [name, password] of [
    ['encrypted.pdf', 'fixture-password'],
    ['encrypted-empty-password.pdf', ''],
  ])
    execFileSync(
      process.argv[2],
      [
        '--encrypt',
        password,
        'fixture-owner',
        '256',
        '--',
        path.join(__dirname, 'single.pdf'),
        path.join(__dirname, name),
      ],
      { windowsHide: true },
    );
}
