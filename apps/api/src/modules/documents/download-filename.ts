/** @description Builds an ASCII fallback and RFC 5987 Unicode filename without trusting filename as a path or header. */
export function attachmentDisposition(filename: string): string {
  const basename =
    filename.normalize('NFC').replace(/\\/g, '/').split('/').pop() ?? '';
  const safe = Array.from(basename)
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return (
        point >= 32 &&
        !(point >= 127 && point <= 159) &&
        !(point >= 0xd800 && point <= 0xdfff)
      );
    })
    .join('')
    .replace(/[";\\]/g, '_')
    .trim()
    .slice(0, 255);
  const name = safe && safe !== '.' && safe !== '..' ? safe : 'document';
  const fallback = name.replace(/[^\x20-\x7e]/g, '_');
  // Replace a trailing isolated surrogate if the length bound split an astral character.
  const unicode = Array.from(name)
    .map((character) =>
      character.length === 1 && /[\ud800-\udfff]/.test(character)
        ? '_'
        : character,
    )
    .join('');
  const encoded = encodeURIComponent(unicode).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
