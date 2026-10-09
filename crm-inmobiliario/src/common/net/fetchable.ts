/**
 * Anti-SSRF básico para URLs que cargan los usuarios (fotos de fichas,
 * calendarios iCal externos): solo https hacia hostnames públicos, sin IPs
 * literales ni nombres internos. Usar junto con `redirect: 'error'`.
 */
export function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      !/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(u.hostname) &&
      !/^[\d.]+$|^\[|:/.test(u.hostname) &&
      u.hostname.includes('.')
    );
  } catch {
    return false;
  }
}
