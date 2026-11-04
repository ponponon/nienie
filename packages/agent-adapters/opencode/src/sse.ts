export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match: RegExpExecArray | null;
      const delimiterPattern = /\r?\n\r?\n/;
      while ((match = delimiterPattern.exec(buffer)) !== null) {
        const rawFrame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        const parsed = parseFrame(rawFrame);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const parsed = parseFrame(buffer);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): unknown | undefined {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const rawData = dataLines.join('\n').trim();
  if (!rawData) {
    return undefined;
  }

  try {
    return JSON.parse(rawData) as unknown;
  } catch {
    return undefined;
  }
}
