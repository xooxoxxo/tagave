/** Fixture covers with very different palettes, as SVG data URIs so stories never hit the network. */

const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">${body}</svg>`)}`;

export interface FixtureCover { key: CoverKey; album: string; artist: string; title: string; src: string }
export type CoverKey = 'moody' | 'bright' | 'mono' | 'pastel' | 'redblack';

export const COVERS: Record<CoverKey, FixtureCover> = {
  moody: {
    key: 'moody', album: 'Night Ferry', artist: 'Lowlight', title: 'Harbour Lights',
    src: svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141826"/><stop offset="1" stop-color="#2a1f3d"/></linearGradient></defs>
      <rect width="300" height="300" fill="url(#g)"/><ellipse cx="150" cy="250" rx="220" ry="40" fill="#3b3355" opacity=".8"/>
      <circle cx="205" cy="92" r="26" fill="#c98a3a"/><circle cx="205" cy="92" r="44" fill="#c98a3a" opacity=".18"/>
      <rect x="40" y="196" width="120" height="6" rx="3" fill="#c98a3a" opacity=".45"/>`),
  },
  bright: {
    key: 'bright', album: 'Sunbath', artist: 'Kiwi Static', title: 'Lido',
    src: svg(`<rect width="300" height="300" fill="#ffd400"/><circle cx="118" cy="150" r="88" fill="#ff2d8a"/>
      <path d="M190 40 L280 220 L150 220 Z" fill="#00c2ff"/><circle cx="118" cy="150" r="22" fill="#ffd400"/>`),
  },
  mono: {
    key: 'mono', album: 'Paper Rooms', artist: 'A. Grey', title: 'Room 4',
    src: svg(`<rect width="300" height="300" fill="#d9d6d0"/><rect x="48" y="48" width="132" height="204" fill="#8a8a8a"/>
      <path d="M48 48 L252 252 M210 40 V260" stroke="#2b2b2b" stroke-width="10"/><circle cx="214" cy="96" r="20" fill="#2b2b2b"/>`),
  },
  pastel: {
    key: 'pastel', album: 'Soft Hours', artist: 'Mallow', title: 'Late Bloom',
    src: svg(`<rect width="300" height="300" fill="#f7d6c8"/><rect x="0" y="180" width="300" height="120" fill="#c8ead9"/>
      <circle cx="170" cy="140" r="70" fill="#d9cdf2"/><circle cx="96" cy="210" r="34" fill="#fbe9a8"/>`),
  },
  redblack: {
    key: 'redblack', album: 'Signal Red', artist: 'Ironside', title: 'Siren',
    src: svg(`<rect width="300" height="300" fill="#0a0a0a"/><rect x="0" y="96" width="300" height="84" fill="#e10600"/>
      <rect x="36" y="214" width="150" height="14" fill="#f5f5f5"/><rect x="36" y="238" width="96" height="14" fill="#f5f5f5"/>`),
  },
};

export const COVER_KEYS = Object.keys(COVERS) as CoverKey[];
