// Minimal, dependency-free QR Code SVG generator (Byte mode, ECC Level L, Versions 1–10).
// Used to render local LAN pairing QR codes offline with zero external requests.

// Version capacities (total data codewords at ECC Level L, and EC codewords per block)
// Format: [version, totalDataBytes, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
const VERSION_TABLE = [
  null,
  [1, 19, 7, 1, 19, 0, 0],
  [2, 34, 10, 1, 34, 0, 0],
  [3, 55, 15, 1, 55, 0, 0],
  [4, 80, 20, 1, 80, 0, 0],
  [5, 108, 26, 1, 108, 0, 0],
  [6, 136, 18, 2, 68, 0, 0],
  [7, 156, 20, 2, 78, 0, 0],
  [8, 194, 24, 2, 97, 0, 0],
  [9, 232, 30, 2, 116, 0, 0],
  [10, 274, 18, 2, 68, 2, 69]
];

const ALIGNMENT_POSITIONS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
];

// GF(256) tables for Reed-Solomon (primitive polynomial 0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

function pickVersion(byteLength) {
  for (let v = 1; v < VERSION_TABLE.length; v++) {
    const totalDataBytes = VERSION_TABLE[v][1];
    // Byte mode header: 4 bits mode (0100) + 8 bits length (v1-9) or 16 bits (v10)
    const headerBits = v <= 9 ? 12 : 20;
    const maxBytes = Math.floor((totalDataBytes * 8 - headerBits) / 8);
    if (byteLength <= maxBytes) return VERSION_TABLE[v];
  }
  throw new Error('QR payload too long (max ~270 bytes).');
}

function encodeDataCodewords(bytes, versionInfo) {
  const [version, totalDataBytes, ecLen, b1, k1, b2, k2] = versionInfo;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  // Mode indicator for Byte mode: 0100
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataBytes * 8;
  const terminator = Math.min(4, maxBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(totalDataBytes);
  let idx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes[idx++] = b;
  }
  const pads = [0xec, 0x11];
  let padIdx = 0;
  while (idx < totalDataBytes) {
    dataBytes[idx++] = pads[padIdx++ & 1];
  }

  // Split into blocks and compute RS error correction
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) {
    const block = dataBytes.slice(offset, offset + k1);
    offset += k1;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen));
  }
  for (let i = 0; i < b2; i++) {
    const block = dataBytes.slice(offset, offset + k2);
    offset += k2;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen));
  }

  // Interleave data and EC codewords
  const out = [];
  const maxDataLen = Math.max(k1, k2);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) {
      out.push(block[i]);
    }
  }
  return out;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Int8Array(size)); // 0=unset, 1=light, 2=dark
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  function setFunctionModule(r, c, dark) {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 2 : 1;
    isFunction[r][c] = 1;
  }

  function drawFinder(row, col) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr;
        const c = col + dc;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inInner));
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunctionModule(6, i, dark);
    setFunctionModule(i, 6, dark);
  }

  // Alignment patterns
  const align = ALIGNMENT_POSITIONS[version];
  for (const r of align) {
    for (const c of align) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Reserve format info areas & dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  return { size, modules, isFunction };
}

function placeDataBits(matrix, codewords) {
  const { size, modules, isFunction } = matrix;
  const bits = [];
  for (const b of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          const dark = bitIdx < bits.length ? bits[bitIdx++] === 1 : false;
          modules[r][c] = dark ? 2 : 1;
        }
      }
    }
    upward = !upward;
  }
}

function applyMaskAndFormat(matrix, mask) {
  const { size, modules, isFunction } = matrix;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunction[r][c]) continue;
      let invert = false;
      if (mask === 0) invert = (r + c) % 2 === 0;
      else if (mask === 1) invert = r % 2 === 0;
      else if (mask === 2) invert = c % 3 === 0;
      else if (mask === 3) invert = (r + c) % 3 === 0;
      if (invert) {
        modules[r][c] = modules[r][c] === 2 ? 1 : 2;
      }
    }
  }

  // Format information for ECC Level L (01) + mask (3 bits)
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const formatBits = ((data << 10) | rem) ^ 0x5412;

  const setFmt = (r, c, bit) => { modules[r][c] = bit ? 2 : 1; };

  // Copy 1: around top-left finder (Bit 0 at (0,8) -> Bit 14 at (8,0))
  for (let i = 0; i <= 5; i++) setFmt(i, 8, (formatBits >>> i) & 1);
  setFmt(7, 8, (formatBits >>> 6) & 1);
  setFmt(8, 8, (formatBits >>> 7) & 1);
  setFmt(8, 7, (formatBits >>> 8) & 1);
  for (let i = 9; i < 15; i++) setFmt(8, 14 - i, (formatBits >>> i) & 1);

  // Copy 2: top-right horizontal (Bits 0..7) & bottom-left vertical (Bits 8..14)
  for (let i = 0; i < 8; i++) setFmt(8, size - 1 - i, (formatBits >>> i) & 1);
  for (let i = 8; i < 15; i++) setFmt(size - 15 + i, 8, (formatBits >>> i) & 1);
}

function generateQrSvg(text, { margin = 4 } = {}) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  if (!bytes.length) throw new Error('QR text must not be empty.');
  const versionInfo = pickVersion(bytes.length);
  const codewords = encodeDataCodewords(bytes, versionInfo);
  const matrix = createMatrix(versionInfo[0]);
  placeDataBits(matrix, codewords);
  applyMaskAndFormat(matrix, 0);

  const { size, modules } = matrix;
  const total = size + margin * 2;
  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c] === 2) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" rx="2" fill="#ffffff"/>` +
    `<path d="${pathData}" fill="#0b0d13"/>` +
    `</svg>`;
}

module.exports = { generateQrSvg };
