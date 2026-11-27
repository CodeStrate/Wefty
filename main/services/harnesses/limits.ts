/**
 * Limits every harness reader shares, so transcripts and handoffs behave the same whichever
 * agent wrote the session. Change them here, never in a reader.
 */

/** Most transcript entries kept per session; longer sessions show their first part. */
export const MAX_ENTRIES = 3000;
/** Longest single message kept before it's cut short. */
export const MAX_ENTRY_CHARS = 12_000;
/** Tool output kept per entry: enough for an error message, small enough for IPC. */
export const MAX_RESULT_CHARS = 1200;
/** Most files listed as touched by a session (in the library and in handoffs). */
export const MAX_FILES_TOUCHED = 40;
