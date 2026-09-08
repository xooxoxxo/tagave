/**
 * Audio-stream hash implementation per spec §12.6
 *
 * Computes structural hashes of audio payloads excluding container-specific metadata and tags:
 * - FLAC: frames after the last metadata block
 * - MP3: bytes between ID3v2 tag end and ID3v1/APEv2 tag start
 * - MP4: mdat box payload
 * - Ogg Vorbis/Opus: packet payloads reassembled from audio pages after comment header
 * - WAV/AIFF: data/SSND chunk payload
 * - DSF/DFF: data chunk payload
 *
 * Hashes are computed as SHA-256 over the extracted stream.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Computes SHA-256 hash of a byte stream
 */
async function hashStream(buffer: Buffer): Promise<string> {
  const hash = createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

/**
 * Extracts and hashes the audio stream from a FLAC file
 * Per spec §12.6: frames after the last metadata block
 */
export async function hashFlacStream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    // FLAC starts with 'fLaC' (4 bytes)
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);

    if (header.toString('ascii') !== 'fLaC') {
      throw new Error('Not a valid FLAC file');
    }

    let offset = 4;
    let isLastBlock = false;

    // Parse metadata blocks until we find the last one
    while (!isLastBlock) {
      const metaBlockHeader = Buffer.alloc(4);
      const bytesRead = await file.read(metaBlockHeader, 0, 4, offset);
      if (bytesRead.bytesRead !== 4) {
        throw new Error('Truncated FLAC metadata block header');
      }

      const headerByte = metaBlockHeader[0];
      if (headerByte === undefined) {
        throw new Error('Invalid FLAC metadata block header');
      }
      isLastBlock = (headerByte & 0x80) !== 0;
      const blockType = headerByte & 0x7f;
      const length = metaBlockHeader.readUInt32BE(1) & 0xffffff; // 24-bit length

      offset += 4 + length;
    }

    // Read remaining file (audio frames)
    const stats = await file.stat();
    const streamSize = stats.size - offset;
    const audioData = Buffer.alloc(streamSize);
    await file.read(audioData, 0, streamSize, offset);

    return hashStream(audioData);
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from an MP3 file
 * Per spec §12.6: bytes between ID3v2 tag end and ID3v1/APEv2 tag start
 */
export async function hashMp3Stream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat();
    let startOffset = 0;
    let endOffset = stats.size;

    // Check for ID3v2 tag at the beginning
    const idv2Header = Buffer.alloc(10);
    await file.read(idv2Header, 0, 10, 0);

    if (idv2Header.toString('ascii', 0, 3) === 'ID3') {
      const version = idv2Header[3];
      const flags = idv2Header[5];
      const byte6 = idv2Header[6];
      const byte7 = idv2Header[7];
      const byte8 = idv2Header[8];
      const byte9 = idv2Header[9];

      if (version === undefined || flags === undefined || byte6 === undefined ||
          byte7 === undefined || byte8 === undefined || byte9 === undefined) {
        throw new Error('Invalid ID3v2 header');
      }

      // Synchsafe integer: 7 bits per byte
      let size = 0;
      size = (size << 7) | (byte6 & 0x7f);
      size = (size << 7) | (byte7 & 0x7f);
      size = (size << 7) | (byte8 & 0x7f);
      size = (size << 7) | (byte9 & 0x7f);

      // Check for footer flag (0x10)
      const hasFooter = (flags & 0x10) !== 0;
      startOffset = 10 + size + (hasFooter ? 10 : 0);
    }

    // Check for ID3v1 tag at the end (128 bytes)
    const idv1Header = Buffer.alloc(3);
    const readPos = Math.max(0, stats.size - 128);
    await file.read(idv1Header, 0, 3, readPos);

    if (idv1Header.toString('ascii') === 'TAG') {
      endOffset = readPos;
    } else {
      // Check for APEv2 tag at the end
      const apeHeader = Buffer.alloc(32);
      const apePos = Math.max(0, stats.size - 32);
      await file.read(apeHeader, 0, 32, apePos);

      if (apeHeader.toString('ascii', 0, 8) === 'APETAGEX') {
        // APEv2 has tag size in bytes 12-15
        const tagSize = apeHeader.readUInt32LE(12);
        endOffset = Math.max(startOffset, stats.size - tagSize - 32);
      }
    }

    if (endOffset <= startOffset) {
      throw new Error('Invalid MP3 file: no audio data found');
    }

    const streamSize = endOffset - startOffset;
    const audioData = Buffer.alloc(streamSize);
    await file.read(audioData, 0, streamSize, startOffset);

    return hashStream(audioData);
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from an MP4 file
 * Per spec §12.6: the mdat payload
 */
export async function hashMp4Stream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat();
    let offset = 0;

    while (offset < stats.size) {
      const boxHeader = Buffer.alloc(8);
      const bytesRead = await file.read(boxHeader, 0, 8, offset);
      if (bytesRead.bytesRead < 8) break;

      const size = boxHeader.readUInt32BE(0);
      const type = boxHeader.toString('ascii', 4, 8);

      if (size === 0) break;

      if (type === 'mdat') {
        // mdat box found; size includes the 8-byte header
        const mdatPayloadSize = size - 8;
        const mdatData = Buffer.alloc(mdatPayloadSize);
        await file.read(mdatData, 0, mdatPayloadSize, offset + 8);
        return hashStream(mdatData);
      }

      offset += size;
    }

    throw new Error('No mdat box found in MP4 file');
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from an Ogg file (Vorbis or Opus)
 * Per spec §12.6: packet payloads reassembled from audio pages after header packets
 *
 * Ogg format carries logical packets split across physical pages. Header packets:
 * - Vorbis: packets 1 (identification), 3 (comment), 5 (setup)
 * - Opus: OpusHead, OpusTags
 *
 * We walk the page sequence, track packet boundaries via segment tables, and
 * hash only the payload of real audio packets (those after all headers).
 */
export async function hashOggStream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat();
    const audioData: Buffer[] = [];
    let offset = 0;
    let packetsSeen = 0; // Track logical packets across pages
    let seenAllHeaders = false;

    // Detect codec from first page
    let isOpus = false;
    let isVorbis = false;

    while (offset < stats.size) {
      const pageHeader = Buffer.alloc(27);
      const bytesRead = await file.read(pageHeader, 0, 27, offset);
      if (bytesRead.bytesRead < 27) break;

      // Check OGG page signature
      if (pageHeader.toString('ascii', 0, 4) !== 'OggS') {
        break;
      }

      const numSegments = pageHeader[26];
      if (numSegments === undefined) {
        throw new Error('Invalid OGG page header');
      }
      const segmentSizes = Buffer.alloc(numSegments);

      await file.read(segmentSizes, 0, numSegments, offset + 27);

      let pageDataSize = 0;
      const segmentList: number[] = [];
      for (let i = 0; i < numSegments; i++) {
        const segmentSize = segmentSizes[i];
        if (segmentSize !== undefined) {
          pageDataSize += segmentSize;
          segmentList.push(segmentSize);
        }
      }

      const pageData = Buffer.alloc(pageDataSize);
      await file.read(pageData, 0, pageDataSize, offset + 27 + numSegments);

      // Parse logical packets from segments
      // Each segment < 255 bytes marks a packet boundary
      let pageOffset = 0;
      for (let i = 0; i < segmentList.length; i++) {
        const segmentSize = segmentList[i]!;
        const segmentData = pageData.slice(pageOffset, pageOffset + segmentSize);
        pageOffset += segmentSize;

        // Check if this segment ends a logical packet (next segment < 255 or is last)
        const isPacketEnd = i === segmentList.length - 1 || (segmentList[i + 1] ?? 0) < 255;

        if (isPacketEnd && segmentSize > 0) {
          packetsSeen++;

          // Detect codec from first packet
          if (packetsSeen === 1) {
            if (segmentData[0] === 0x01) {
              // Vorbis packet type 1 = identification
              isVorbis = true;
            } else if (segmentData.length >= 8 &&
                       segmentData.toString('ascii', 0, 4) === 'Opus') {
              // OpusHead starts with "Opus"
              isOpus = true;
            }
          }

          // Determine if this is a header packet or audio packet
          let isHeader = false;

          if (isVorbis) {
            // Vorbis: packets 1, 3, 5 are headers
            if ([1, 3, 5].includes(packetsSeen)) {
              isHeader = true;
            }
          } else if (isOpus) {
            // Opus: OpusHead (packet 1) and OpusTags (packet 2)
            if ([1, 2].includes(packetsSeen)) {
              isHeader = true;
            }
          } else {
            // Unknown codec: assume first packet is ID, second is comment/tags
            if (packetsSeen <= 2) {
              isHeader = true;
            }
          }

          if (isHeader) {
            // Mark that we've seen all expected headers once we pass them
            if (packetsSeen > 2) {
              seenAllHeaders = true;
            }
          } else {
            // This is audio data
            seenAllHeaders = true;
            audioData.push(segmentData);
          }
        }
      }

      offset += 27 + numSegments + pageDataSize;
    }

    if (audioData.length === 0) {
      throw new Error('No audio pages found in Ogg file');
    }

    const combined = Buffer.concat(audioData);
    return hashStream(combined);
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from a WAV file
 * Per spec §12.6: the data chunk
 */
export async function hashWavStream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    await file.read(header, 0, 12, 0);

    // Check RIFF signature
    if (header.toString('ascii', 0, 4) !== 'RIFF') {
      throw new Error('Not a valid WAV file');
    }

    if (header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Not a valid WAV file');
    }

    let offset = 12;
    let dataChunkFound = false;
    let dataSize = 0;

    // Parse chunks to find 'data' chunk
    while (offset < 1000000000) { // safety limit
      const chunkHeader = Buffer.alloc(8);
      const bytesRead = await file.read(chunkHeader, 0, 8, offset);
      if (bytesRead.bytesRead < 8) break;

      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);

      if (chunkId === 'data') {
        dataChunkFound = true;
        dataSize = chunkSize;
        offset += 8;
        break;
      }

      offset += 8 + chunkSize;
    }

    if (!dataChunkFound) {
      throw new Error('No data chunk found in WAV file');
    }

    const audioData = Buffer.alloc(dataSize);
    await file.read(audioData, 0, dataSize, offset);

    return hashStream(audioData);
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from an AIFF file
 * Per spec §12.6: the SSND chunk
 */
export async function hashAiffStream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    await file.read(header, 0, 12, 0);

    // Check FORM signature for AIFF
    if (header.toString('ascii', 0, 4) !== 'FORM') {
      throw new Error('Not a valid AIFF file');
    }

    const formType = header.toString('ascii', 8, 12);
    if (formType !== 'AIFF' && formType !== 'AIFC') {
      throw new Error('Not a valid AIFF file');
    }

    let offset = 12;
    let ssndChunkFound = false;
    let ssndSize = 0;

    // Parse chunks to find 'SSND' chunk
    while (offset < 1000000000) { // safety limit
      const chunkHeader = Buffer.alloc(8);
      const bytesRead = await file.read(chunkHeader, 0, 8, offset);
      if (bytesRead.bytesRead < 8) break;

      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32BE(4);

      if (chunkId === 'SSND') {
        ssndChunkFound = true;
        // SSND has 8-byte header (offset and blockSize) before actual samples
        ssndSize = chunkSize - 8;
        offset += 16; // 8 bytes header + 8 bytes for offset/blockSize
        break;
      }

      offset += 8 + chunkSize;
    }

    if (!ssndChunkFound) {
      throw new Error('No SSND chunk found in AIFF file');
    }

    const audioData = Buffer.alloc(ssndSize);
    await file.read(audioData, 0, ssndSize, offset);

    return hashStream(audioData);
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from a DSF file
 * Per spec §12.6: the data chunk
 */
export async function hashDsfStream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);

    if (header.toString('ascii', 0, 4) !== 'DSD ') {
      throw new Error('Not a valid DSF file');
    }

    let offset = 0;
    let dataChunkFound = false;
    let dataSize = 0;

    // Parse DSF chunks
    while (offset < 1000000000) { // safety limit
      const chunkHeader = Buffer.alloc(12);
      const bytesRead = await file.read(chunkHeader, 0, 12, offset);
      if (bytesRead.bytesRead < 12) break;

      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readBigUInt64LE(4);

      if (chunkId === 'data') {
        dataChunkFound = true;
        dataSize = Number(chunkSize) - 12;
        offset += 12;
        break;
      }

      offset += Number(chunkSize);
    }

    if (!dataChunkFound) {
      throw new Error('No data chunk found in DSF file');
    }

    const audioData = Buffer.alloc(dataSize);
    await file.read(audioData, 0, dataSize, offset);

    return hashStream(audioData);
  } finally {
    await file.close();
  }
}

/**
 * Extracts and hashes the audio stream from a DFF file
 * Per spec §12.6: the data chunk
 */
export async function hashDffStream(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);

    if (header.toString('ascii', 0, 4) !== 'FRM8') {
      throw new Error('Not a valid DFF file');
    }

    let offset = 0;
    let dataChunkFound = false;
    let dataSize = 0;

    // Parse DFF chunks
    while (offset < 1000000000) { // safety limit
      const chunkHeader = Buffer.alloc(12);
      const bytesRead = await file.read(chunkHeader, 0, 12, offset);
      if (bytesRead.bytesRead < 12) break;

      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readBigUInt64BE(4);

      if (chunkId === 'DSD ') {
        dataChunkFound = true;
        dataSize = Number(chunkSize) - 12;
        offset += 12;
        break;
      }

      offset += Number(chunkSize);
    }

    if (!dataChunkFound) {
      throw new Error('No DSD data chunk found in DFF file');
    }

    const audioData = Buffer.alloc(dataSize);
    await file.read(audioData, 0, dataSize, offset);

    return hashStream(audioData);
  } finally {
    await file.close();
  }
}

/**
 * Route to the appropriate hasher based on container format
 */
export async function hashAudioStream(filePath: string, container: string): Promise<string> {
  const normalizedContainer = container.toLowerCase();

  switch (normalizedContainer) {
    case 'flac':
      return hashFlacStream(filePath);
    case 'mp3':
      return hashMp3Stream(filePath);
    case 'mp4':
    case 'm4a':
    case 'alac':
      return hashMp4Stream(filePath);
    case 'ogg':
    case 'opus':
      return hashOggStream(filePath);
    case 'wav':
      return hashWavStream(filePath);
    case 'aiff':
    case 'aif':
      return hashAiffStream(filePath);
    case 'dsf':
      return hashDsfStream(filePath);
    case 'dff':
      return hashDffStream(filePath);
    default:
      throw new Error(`Unsupported container format: ${container}`);
  }
}
