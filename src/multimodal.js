import { normalizeProvider } from './providers.js';

export const MULTIMODAL_RESULT = 'switchyard.multimodal.v1';
export const NATIVE_IMAGE_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function modelCapabilities(provider, model) {
  const p = normalizeProvider(provider);
  const id = String(model || '').toLowerCase();
  const vision = p === 'openai'
    ? /^(?:gpt-(?:4o|4\.1|5|6)|o[134](?:-|$))/.test(id) && !/(?:audio|realtime|transcribe|tts|search-api)/.test(id)
    : p === 'anthropic'
      ? /^claude-(?:3|haiku|sonnet|opus|fable|mythos)/.test(id)
      : p === 'deepseek'
        ? /(?:vision|vl)/.test(id)
        : p === 'glm'
          ? /(?:vision|\bv\b|\dv(?:-|$)|ocr)/.test(id)
          : false;
  return {
    vision,
    // Switchyard currently implements generation through OpenAI's Responses
    // image_generation tool. Claude accepts image input but does not expose an
    // equivalent Anthropic Messages API image-output tool.
    imageGeneration: p === 'openai' && vision && !/(?:codex|chat|search|audio|realtime|transcribe|tts)/.test(id)
  };
}

export function supportsNativeImageMime(mimeType) {
  return NATIVE_IMAGE_MIME.includes(String(mimeType || '').toLowerCase());
}

export function multimodalResult({ text, images = [], files = [] }) {
  return {
    type: MULTIMODAL_RESULT,
    text: String(text || ''),
    images: images.map(image => ({
      type: 'image',
      data: String(image.data || ''),
      mimeType: String(image.mimeType || 'image/png'),
      path: image.path ? String(image.path) : undefined
    })),
    files
  };
}

export function isMultimodalResult(value) {
  return Boolean(value && typeof value === 'object' && value.type === MULTIMODAL_RESULT && Array.isArray(value.images));
}

export function multimodalText(value) {
  return isMultimodalResult(value) ? value.text : typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

export function consumeMultimodalResults(messages) {
  let released = 0;
  for (const message of messages || []) {
    if (!isMultimodalResult(message.content) || message.content.consumed) continue;
    const bytes = message.content.images.reduce((sum, image) => sum + Math.ceil((image.data?.length || 0) * 0.75), 0);
    message.content.images = message.content.images.map(({ data, ...image }) => image);
    message.content.consumed = true;
    message.content.releasedBytes = bytes;
    message.content.text += '\nImage bytes were delivered to the model once and released from the persisted transcript. Call view_image again to reattach the file.';
    released += bytes;
  }
  return released;
}
