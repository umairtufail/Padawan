/**
 * Yoda's voice model may emit ElevenLabs audio tags such as "[sad]" or "[slow]", or (rarely) meta text in
 * parentheses or asterisks such as "(pauses)" or "*sighs*". None of it is spoken words, so captions drop it.
 */
/** Agent reasoning that leaked into the output ("The user has not responded. I should ask..."). */
const META_SENTENCE = /^(the user (?:has|had|is|did|does|hasn|didn|said|asked|wants|seems)|i should|i need to|i will (?:ask|wait)|i must)\b/i;

export function cleanCaption(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !META_SENTENCE.test(sentence.trim()))
    .join(" ")
    .replace(/\[[a-z][a-z _-]{0,30}\]\s*/gi, "")
    .replace(/\([^()]{0,80}\)\s*/g, "")
    .replace(/\*[^*\n]{1,60}\*\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
