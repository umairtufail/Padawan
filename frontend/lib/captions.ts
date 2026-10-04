/**
 * Yoda's voice model may emit ElevenLabs audio tags such as "[sad]" or "[slow]". They steer the voice and are
 * never meant to be read, so captions drop them.
 */
export function cleanCaption(text: string): string {
  return text.replace(/\[[a-z][a-z _-]{0,30}\]\s*/gi, "").replace(/\s{2,}/g, " ").trim();
}
