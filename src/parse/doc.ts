/**
 * Shared access to the EW XML document model from ewd.
 *
 * Every parser takes `XmlInput`: callers that run several parsers over one
 * design parse the XML once (`parseEwXml`) and pass the document around;
 * one-off callers can still pass the XML text.
 */
import { type EwDocument, type EwElement, parseEwXml } from "electronics-workbench-decoder";

export type { EwDocument, EwElement };
export { decodeEwString } from "electronics-workbench-decoder";

export type XmlInput = string | EwDocument;

export const docOf = (input: XmlInput): EwDocument => (typeof input === "string" ? parseEwXml(input) : input);

/**
 * Text shown on a drawing (values, refdes, notes, pin names). The document
 * model keeps attribute values raw; display text drops surrounding
 * whitespace and uses LF line breaks (EW stores CRLF).
 */
export const displayText = (s: string): string => s.replace(/\r\n?/g, "\n").trim();
