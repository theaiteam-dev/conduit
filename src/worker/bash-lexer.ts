/**
 * Shell lexer for the harness per-call gate's Bash check.
 *
 * A harness Bash command runs in a real shell (bash, or zsh when that is the
 * user's shell), so the gate must read it the way a shell does and refuse
 * anything that would make the string that runs differ from the string it
 * approved. This lexer recognises a small subset of shell syntax and fails
 * closed: any character or construct it does not recognise is a refusal.
 *
 * Grammar (only a space separates words; nothing else does):
 *
 *   command  = segment *( "|" segment )      ; a pipeline, no "||", no "|&"
 *   segment  = word *( " " word )            ; at least one word
 *   word     = 1*part                        ; adjacent parts concatenate
 *   part     = unquoted / single / double
 *   unquoted = 1*( A-Z a-z 0-9 _ . / : = @ , + % - )
 *                                            ; "=" not first in a word
 *   single   = "'" *( any but "'" ) "'"      ; literal
 *   double   = '"' *( any but '"' $ ` \ ! ) '"'  ; literal, given the exclusions
 *
 * Refused anywhere, quoted or not: a C0 or C1 control character or DEL
 * (newline and tab included). Every other unquoted character, including
 * ; & ( ) < > $ ` \ * ? [ ] { } ~ # ! ^ and non-ASCII, is refused.
 *
 * Choices this grammar makes:
 *   - `%` is safe unquoted: neither bash nor zsh expands it outside a
 *     parameter expansion, which `$` already excludes.
 *   - `=` is refused as the first character of a word, because zsh expands
 *     `=name` to the path of `name` (EQUALS, on by default).
 *   - `!` is refused inside double quotes. History expansion is off in a
 *     non-interactive shell, but refusing it costs a single quote.
 *   - Control characters are refused inside quotes too. A newline in single
 *     quotes is literal to the shell, but a caller that splits on lines (a
 *     host wrapper, a log reader) would see two commands.
 *
 * `shell-quote` is not used: its `parse` replaces `$VAR` with an empty string
 * when given no environment, which would hide the `$` this check must refuse.
 */

/** One shell word after quote removal. */
export interface BashWord {
  /** The word as the shell passes it to the program. */
  text: string;
  /** True when any part of the word was quoted. */
  quoted: boolean;
}

export type BashLexResult =
  | { ok: true; segments: BashWord[][] }
  | { ok: false; kind: 'syntax' | 'empty'; reason: string };

const UNQUOTED_SAFE = /^[A-Za-z0-9_./:=@,+%-]$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DOUBLE_QUOTE_REFUSED: ReadonlySet<string> = new Set(['$', '`', '\\', '!']);
/** Refused characters that quoting would not fix: the agent meant them as syntax. Only affects the reason. */
const OPERATORS: ReadonlySet<string> = new Set([';', '&', '<', '>', '(', ')', '$', '`']);

/** Names a refused character for the reason. Printable ASCII only, else a code point. */
function describe(ch: string): string {
  const code = ch.codePointAt(0)!;
  return code >= 0x21 && code <= 0x7e ? JSON.stringify(ch) : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function syntax(reason: string): BashLexResult {
  return { ok: false, kind: 'syntax', reason };
}

/**
 * Split `command` into pipeline segments of words, or refuse it. The reason
 * names the refused construct and carries no other text from the command.
 */
export function lexBashCommand(command: string): BashLexResult {
  if (CONTROL.test(command)) return syntax('Bash command contains a control character (newline, tab or similar)');

  const segments: BashWord[][] = [];
  let segment: BashWord[] = [];
  let text = '';
  let quoted = false;
  let inWord = false;
  let sawPipe = false;

  const endWord = (): void => {
    if (inWord) segment.push({ text, quoted });
    text = '';
    quoted = false;
    inWord = false;
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === ' ') {
      endWord();
      i += 1;
    } else if (ch === '|') {
      endWord();
      const next = command[i + 1];
      if (next === '|') return syntax('Bash command contains "||"; only a plain pipe between programs is allowed');
      if (next === '&') return syntax('Bash command contains "|&"; only a plain pipe between programs is allowed');
      if (segment.length === 0) return syntax('Bash command has an empty pipeline segment');
      segments.push(segment);
      segment = [];
      sawPipe = true;
      i += 1;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return syntax('Bash command has an unterminated single quote');
      text += command.slice(i + 1, end);
      quoted = true;
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      for (;;) {
        const c = command[j];
        if (c === undefined) return syntax('Bash command has an unterminated double quote');
        if (c === '"') break;
        if (DOUBLE_QUOTE_REFUSED.has(c)) {
          return syntax(`Bash command has ${describe(c)} inside double quotes; use single quotes for literal text`);
        }
        j += 1;
      }
      text += command.slice(i + 1, j);
      quoted = true;
      inWord = true;
      i = j + 1;
    } else if (UNQUOTED_SAFE.test(ch)) {
      if (ch === '=' && !inWord) return syntax('Bash command has a word starting with an unquoted "="');
      text += ch;
      inWord = true;
      i += 1;
    } else if (OPERATORS.has(ch)) {
      return syntax(
        `Bash command contains an unquoted ${describe(ch)}: command separators, redirects, subshells and expansions are not allowed`,
      );
    } else {
      return syntax(`Bash command contains an unquoted ${describe(ch)}; quote literal text with single quotes`);
    }
  }
  endWord();
  if (segment.length === 0) {
    if (sawPipe) return syntax('Bash command has an empty pipeline segment');
    return { ok: false, kind: 'empty', reason: 'Bash command is empty' };
  }
  segments.push(segment);
  return { ok: true, segments };
}
